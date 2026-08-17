import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { URL } from 'node:url';
import { WebSocket } from 'ws';
import { activeSessionAzureConfigDir, activeSessionKubeconfigPath } from '../auth/session.js';
import { sessionEnv } from '../auth/session.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logError, logInfo, logWarn } from '../util/logger.js';
import { setRequestOperation } from '../util/requestOp.js';

type TerminalRequest = {
  context?: string;
  namespace?: string;
};

type TerminalMessage =
  | { type: 'run'; command: string }
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

  let currentChild: ChildProcessWithoutNullStreams | undefined;
  let currentExecutable: string | undefined;
  let busy = false;
  let stopping = false;

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
    currentChild = undefined;
    currentExecutable = undefined;
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
    busy = true;

    try {
      const spawned = await spawnWithCandidates(candidates, args, env);
      currentChild = spawned.child;
      currentExecutable = spawned.executablePath;
    } catch (err) {
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
    let stderrBuffer = '';

    currentChild.stdout.on('data', (chunk) => {
      const textChunk = chunk.toString();
      stdoutBuffer += textChunk;
      send({ type: 'OUTPUT', stream: 'stdout', text: textChunk });
    });

    currentChild.stderr.on('data', (chunk) => {
      const textChunk = chunk.toString();
      stderrBuffer += textChunk;
      send({ type: 'OUTPUT', stream: 'stderr', text: textChunk });
    });

    currentChild.on('error', (err) => {
      busy = false;
      logCommandOutcome('error', 'terminal.command.error', 'failed', currentExecutable ?? executable, args, {
        executablePath: currentExecutable ?? executable,
        kubeconfigPath,
        azureConfigDir: azureConfigDir ?? null,
        context: context ?? null,
        namespace: namespace ?? null,
        error: err.message,
        commandLine: commandLine(currentExecutable ?? executable, args),
      }, commandReason(err));
      send({ type: 'ERROR', message: err.message });
      currentChild = undefined;
    });

    currentChild.on('close', (code) => {
      const exitCode = code ?? -1;
      const reason = (stderrBuffer || stdoutBuffer || `exit code ${exitCode}`).trim();
      if (stopping) {
        stopping = false;
        busy = false;
        currentChild = undefined;
        currentExecutable = undefined;
        send({ type: 'STOPPED', code: 130 });
        return;
      }
      if (exitCode === 0) {
        logCommandOutcome('info', 'terminal.command.finish', 'success', currentExecutable ?? executable, args, {
          executablePath: currentExecutable ?? executable,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          context: context ?? null,
          namespace: namespace ?? null,
          code: exitCode,
          commandLine: commandLine(currentExecutable ?? executable, args),
        }, 'command exited cleanly');
      } else {
        logCommandOutcome('error', 'terminal.command.finish', 'failed', currentExecutable ?? executable, args, {
          executablePath: currentExecutable ?? executable,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          context: context ?? null,
          namespace: namespace ?? null,
          code: exitCode,
          commandLine: commandLine(currentExecutable ?? executable, args),
        }, `exit code ${exitCode}${reason ? ` - ${reason.slice(-400)}` : ''}`);
      }

      busy = false;
      currentChild = undefined;
      currentExecutable = undefined;
      send({ type: 'DONE', code: exitCode });
    });
  });
}

async function spawnWithCandidates(
  candidates: string[],
  args: string[],
  env: Record<string, string>,
): Promise<{ child: ChildProcessWithoutNullStreams; executablePath: string }> {
  let lastError: NodeJS.ErrnoException | undefined;

  for (const cmd of candidates) {
    logInfo('terminal.command.spawn', {
      cmd,
      executablePath: cmd,
      args,
      commandLine: commandLine(cmd, args),
      platform: process.platform,
    });

    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      shell: false,
      windowsHide: true,
    });

    const outcome = await new Promise<{ child?: ChildProcessWithoutNullStreams; error?: NodeJS.ErrnoException }>((resolve) => {
      const onSpawn = () => {
        child.off('error', onError);
        resolve({ child });
      };
      const onError = (error: NodeJS.ErrnoException) => {
        child.off('spawn', onSpawn);
        resolve({ error });
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });

    if (outcome.child) {
      return { child: outcome.child, executablePath: cmd };
    }

    lastError = outcome.error;
    logWarn('terminal.command.spawn_fallback', {
      cmd,
      executablePath: cmd,
      code: outcome.error?.code ?? null,
    });

    if (outcome.error?.code !== 'ENOENT' && outcome.error?.code !== 'EINVAL') {
      throw outcome.error;
    }
  }

  logError('terminal.command.not_found', {
    candidateCommands: candidates,
    error: lastError?.message ?? null,
  });
  throw new Error('kubectl or helm executable was not found on the backend host');
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