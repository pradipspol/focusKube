import { URL } from 'node:url';
import { WebSocket } from 'ws';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { activeSessionAzureConfigDir, activeSessionKubeconfigPath } from '../auth/session.js';
import { sessionEnv } from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logError, logInfo, logWarn } from '../util/logger.js';
import { resolveExecutablePath } from '../util/run.js';
import { setRequestOperation } from '../util/requestOp.js';
import { prepareCliKubeconfig, type PreparedCliKubeconfig } from '../kube/cliKubeconfig.js';

type TerminalRequest = {
  context?: string;
  namespace?: string;
};

type TerminalMessage =
  | { type: 'run'; command: string; cols?: number; rows?: number }
  | { type: 'resize'; cols?: number; rows?: number }
  | { type: 'stop' };

export function parseTerminalRequest(req: any): TerminalRequest {
  const url = new URL(req.url, 'http://localhost');
  return {
    context: url.searchParams.get('context') || undefined,
    namespace: url.searchParams.get('namespace') || undefined,
  };
}

export async function handleTerminal(ws: WebSocket, req: any) {
  setRequestOperation(req, 'terminal.shell');
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const request = parseTerminalRequest(req);
  const context = request.context || session.activeContext || undefined;
  const namespace = request.namespace || undefined;

  let currentChild: IPty | undefined;
  let currentExecutable: string | undefined;
  let currentCliKubeconfig: PreparedCliKubeconfig | undefined;
  let busy = false;
  let stopping = false;
  let terminalCols = 80;
  let terminalRows = 24;

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const cleanup = () => {
    try {
      currentChild?.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    void currentCliKubeconfig?.cleanup();
    currentChild = undefined;
    currentExecutable = undefined;
    currentCliKubeconfig = undefined;
    busy = false;
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', async (data, isBinary) => {
    const text = isBinary ? data.toString() : data.toString();
    if (!text.startsWith('{')) return;

    let message: TerminalMessage;
    try {
      message = JSON.parse(text) as TerminalMessage;
    } catch {
      return;
    }

    if (message.type === 'stop') {
      stopping = true;
      cleanup();
      return;
    }

    if (message.type === 'resize') {
      terminalCols = normalizeTerminalSize(message.cols, terminalCols, 240);
      terminalRows = normalizeTerminalSize(message.rows, terminalRows, 120);
      if (currentChild) {
        try {
          currentChild.resize(terminalCols, terminalRows);
        } catch {
          /* ignore transient resize errors */
        }
      }
      return;
    }

    if (message.type !== 'run') return;
    if (busy) {
      send({ type: 'ERROR', message: 'A command is already running.' });
      return;
    }

    const rawCommand = String(message.command ?? '').trim();
    if (!rawCommand) {
      send({ type: 'ERROR', message: 'Enter a kubectl or helm command.' });
      return;
    }

    if (/[|<>;]/.test(rawCommand) || /\s&&\s|\s\|\|\s/.test(rawCommand)) {
      send({ type: 'ERROR', message: 'Shell pipes and redirection are not supported. Run a direct kubectl or helm command.' });
      return;
    }

    const parsed = tokenizeCommand(rawCommand);
    if (parsed.length === 0) {
      send({ type: 'ERROR', message: 'Enter a kubectl or helm command.' });
      return;
    }

    const baseCommand = parsed[0].replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (baseCommand !== 'kubectl' && baseCommand !== 'helm') {
      send({ type: 'ERROR', message: 'Only kubectl and helm commands are allowed here.' });
      return;
    }

    try {
      await ensureContextAuthReady({
        context,
        kubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir,
        userId: req.authUser?.id,
        azureLogin: session.azureLogin,
      });
    } catch (err) {
      send({ type: 'ERROR', message: (err as Error).message });
      return;
    }

    const [executable, ...args] = parsed;
    const candidates = process.platform === 'win32' ? [executable, `${executable}.exe`] : [executable];
    const env = sessionEnv(req);
    terminalCols = normalizeTerminalSize(message.cols, terminalCols, 240);
    terminalRows = normalizeTerminalSize(message.rows, terminalRows, 120);
    env.COLUMNS = String(terminalCols);
    env.LINES = String(terminalRows);
    busy = true;

    try {
      currentCliKubeconfig = await prepareCliKubeconfig({
        session,
        context,
        env,
      });
      const spawned = await spawnWithCandidates(candidates, args, currentCliKubeconfig.env, terminalCols, terminalRows);
      currentChild = spawned.child;
      currentExecutable = spawned.executablePath;
    } catch (err) {
      await currentCliKubeconfig?.cleanup();
      currentCliKubeconfig = undefined;
      busy = false;
      send({ type: 'ERROR', message: (err as Error).message });
      return;
    }

    logInfo('terminal.command.start', {
      executablePath: currentExecutable,
      commandLine: commandLine(currentExecutable ?? executable, args),
      context: context ?? null,
      namespace: namespace ?? null,
    });

    let stdoutBuffer = '';
    const stderrBuffer = '';

    currentChild.onData((textChunk: string) => {
      stdoutBuffer += textChunk;
      send({ type: 'OUTPUT', stream: 'stdout', text: textChunk });
    });

    currentChild.onExit((result: { exitCode: number; signal?: number }) => {
      const code = result.exitCode ?? -1;
      const reason = (stderrBuffer || stdoutBuffer || `exit code ${code}`).trim();
      if (stopping) {
        stopping = false;
        busy = false;
        currentChild = undefined;
        currentExecutable = undefined;
        send({ type: 'STOPPED', code: 130 });
        return;
      }
      if (code === 0) {
        logCommandOutcome('info', 'terminal.command.finish', 'success', currentExecutable ?? executable, args, {
          executablePath: currentExecutable ?? executable,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          context: context ?? null,
          namespace: namespace ?? null,
          code,
          commandLine: commandLine(currentExecutable ?? executable, args),
        }, 'command exited cleanly');
      } else {
        logCommandOutcome('error', 'terminal.command.finish', 'failed', currentExecutable ?? executable, args, {
          executablePath: currentExecutable ?? executable,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          context: context ?? null,
          namespace: namespace ?? null,
          code,
          commandLine: commandLine(currentExecutable ?? executable, args),
        }, `exit code ${code}${reason ? ` - ${reason.slice(-400)}` : ''}`);
      }

      busy = false;
      currentChild = undefined;
      currentExecutable = undefined;
      void currentCliKubeconfig?.cleanup();
      currentCliKubeconfig = undefined;
      send({ type: 'DONE', code });
    });

  });
}

async function spawnWithCandidates(
  candidates: string[],
  args: string[],
  env: Record<string, string>,
  cols: number,
  rows: number,
): Promise<{ child: IPty; executablePath: string }> {
  let lastError: NodeJS.ErrnoException | undefined;

  for (const cmd of candidates) {
    const executablePath = resolveExecutablePath(cmd, env);
    const spawnTarget = executablePath || cmd;
    logInfo('terminal.command.spawn', {
      cmd,
      executablePath: spawnTarget,
      args,
      commandLine: commandLine(spawnTarget, args),
      platform: process.platform,
    });

    try {
      const child = spawnPty(spawnTarget, args, {
        name: 'xterm-color',
        cols,
        rows,
        cwd: process.cwd(),
        env: { ...process.env, ...env },
      });
      return { child, executablePath: spawnTarget };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      lastError = err;
      logWarn('terminal.command.spawn_fallback', {
        cmd,
        executablePath: spawnTarget,
        code: err.code ?? null,
      });

      if (err.code !== 'ENOENT' && err.code !== 'EINVAL') {
        throw err;
      }
    }
  }

  logError('terminal.command.not_found', {
    candidateCommands: candidates,
    error: lastError?.message ?? null,
  });
  throw new Error('kubectl or helm executable was not found on the backend host');
}

function normalizeTerminalSize(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }

    if (quote === 'single') {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}