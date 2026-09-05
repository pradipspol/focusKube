import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './httpError.js';
import { config } from '../config.js';
import { commandLine, commandReason, logCommandOutcome } from './commandLog.js';
import { logWarn, logError, logInfo, logDebug } from './logger.js';
import type { CallIdentity } from './callIdentity.js';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  /** Extra environment variables merged onto process.env. */
  env?: Record<string, string>;
  /** Data to write to stdin. */
  input?: string;
  /** Timeout in milliseconds. Defaults to 60s. */
  timeoutMs?: number;
  /** Custom executable candidates to try. If provided, overrides auto-discovery. */
  candidates?: string[];
  /**
   * Which signed-in account/tenant/subscription/context this call is operating against.
   * Every az/helm invocation should supply this so a cross-account mix-up shows up in the
   * logs immediately instead of silently mixing data.
   */
  identity?: CallIdentity;
}

/**
 * Run an external CLI (helm, az, kubectl) WITHOUT a shell. Arguments are passed
 * as an array so user-provided values can never be interpreted by a shell,
 * which protects against command injection.
 */
export function run(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  logInfo('exec.run.run', { cmd, args, options });
  logDebug('exec.call_identity', {
    cmd,
    args,
    commandLine: commandLine(cmd, args),
    kubeconfigPath: options.env?.KUBECONFIG ?? null,
    azureConfigDir: options.env?.AZURE_CONFIG_DIR ?? null,
    identity: options.identity ?? null,
  });
  const candidates = options.candidates ?? executableCandidates(cmd);
  return runWithCandidates(candidates, args, options);
}

function runWithCandidates(
  commands: string[],
  args: string[],
  options: RunOptions,
): Promise<RunResult> {
  const [cmd, ...rest] = commands;
  if (!cmd) {
    return Promise.reject(new HttpError(500, 'No executable candidates to run.'));
  }

  const { env, input, timeoutMs = 60_000 } = options;
  const startedHr = process.hrtime.bigint();
  const commandText = commandLine(cmd, args);
  const resolvedExecutablePath = resolveExecutablePath(cmd, env);
  // Use resolved path if it's different from the command name (i.e., if we found it)
  const cmdToSpawn = resolvedExecutablePath !== cmd ? resolvedExecutablePath : cmd;
  const kubeconfigPath = env?.KUBECONFIG ?? null;
  const azureConfigDir = env?.AZURE_CONFIG_DIR ?? null;
  const isWindowsScript =
    process.platform === 'win32' && (cmdToSpawn.toLowerCase().endsWith('.cmd') || cmdToSpawn.toLowerCase().endsWith('.bat'));
  
  logInfo('exec.runWithCandidates.start', {
    cmd,
    executablePath: resolvedExecutablePath,
    resolvedExecutablePath,
    kubeconfigPath,
    azureConfigDir,
    candidateCommands: commands,
    spawnCmd: cmdToSpawn,
    args,
    timeoutMs,
    commandLine: commandText,
    platform: process.platform,
    isWindowsScript,
    useShellForWindows: isWindowsScript,
  });

  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    const startedHr = process.hrtime.bigint();
    try {
      if (isWindowsScript) {
        // For Windows batch files, use spawn with shell: true
        // This lets the Windows shell handle quoting of paths with spaces properly
        // The shell will interpret the quoted command path and argument array correctly
        const quotedCmd = `"${cmdToSpawn}"`;
        child = spawn(quotedCmd, args, {
          env: { ...process.env, ...env },
          shell: true,
          windowsHide: true,
        });
      } else {
        // For non-Windows, use spawn directly without shell
        child = spawn(cmdToSpawn, args, {
          env: { ...process.env, ...env },
          shell: false,
          windowsHide: true,
        });
      }
    } catch (err) {
      const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
      const e = err as NodeJS.ErrnoException;
      if ((e.code === 'ENOENT' || e.code === 'EINVAL') && rest.length > 0) {
        logError('exec.spawn_fallback', {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: rest,
          fallback: rest[0],
          code: e.code,
          elapsedMs: Number(elapsedMs.toFixed(1)),
        });
        runWithCandidates(rest, args, options).then(resolve).catch(reject);
        return;
      }
      logCommandOutcome('error', 'exec.spawn_failed', 'failed', cmd, args, {
        cmd,
        executablePath: resolvedExecutablePath,
        resolvedExecutablePath,
        kubeconfigPath,
        azureConfigDir,
        candidateCommands: commands,
        code: e.code,
        message: e.message,
        elapsedMs: Number(elapsedMs.toFixed(1)),
      }, commandReason(e));
      reject(new HttpError(500, `Failed to run ${cmd}: ${e.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
      logCommandOutcome('error', 'exec.timeout', 'timedout', cmd, args, {
        cmd,
        executablePath: resolvedExecutablePath,
        resolvedExecutablePath,
        kubeconfigPath,
        azureConfigDir,
        candidateCommands: commands,
        args,
        timeoutMs,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        commandLine: commandText,
      }, `exceeded timeout of ${timeoutMs}ms`);
      reject(new HttpError(504, `Command timed out: ${cmd} ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout?.on('data', (d: any) => (stdout += d.toString()));
    child.stderr?.on('data', (d: any) => (stderr += d.toString()));

    child.on('error', (err: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EINVAL') {
        if (rest.length > 0) {
          logError('exec.error_fallback', {
            cmd,
            executablePath: resolvedExecutablePath,
            resolvedExecutablePath,
            kubeconfigPath,
            azureConfigDir,
            candidateCommands: rest,
            fallback: rest[0],
            code: (err as NodeJS.ErrnoException).code,
            elapsedMs: Number(elapsedMs.toFixed(1)),
          });
          runWithCandidates(rest, args, options).then(resolve).catch(reject);
          return;
        }
        logCommandOutcome('error', 'exec.not_found', 'failed', cmd, args, {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: commands,
          args,
          elapsedMs: Number(elapsedMs.toFixed(1)),
          commandLine: commandText,
        }, `executable not found: ${commands[0]}`);
        reject(
          new HttpError(500, `Executable not found: ${commands[0]}. Is it installed on the backend host?`),
        );
      } else {
        logCommandOutcome('error', 'exec.error', 'failed', cmd, args, {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: commands,
          args,
          message: err.message,
          elapsedMs: Number(elapsedMs.toFixed(1)),
          commandLine: commandText,
        }, commandReason(err));
        reject(new HttpError(500, `Failed to run ${cmd}: ${err.message}`));
      }
    });

    child.on('close', (code: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const merged = `${stderr}\n${stdout}`.toLowerCase();
      const notFoundOutput =
        merged.includes('is not recognized as an internal or external command') ||
        merged.includes('not found') ||
        merged.includes('no such file or directory');
      const elapsedMs = Number(process.hrtime.bigint() - startedHr) / 1_000_000;

      if ((code ?? -1) !== 0 && rest.length > 0 && notFoundOutput) {
        logWarn('exec.close_fallback', {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: rest,
          fallback: rest[0],
          code,
          elapsedMs: Number(elapsedMs.toFixed(1)),
        });
        runWithCandidates(rest, args, options).then(resolve).catch(reject);
        return;
      }

      if (elapsedMs >= config.slowCommandWarnMs) {
        logCommandOutcome(
          'warn',
          'exec.slow',
          'stuck',
          cmd,
          args,
          {
            cmd,
            executablePath: resolvedExecutablePath,
            resolvedExecutablePath,
            kubeconfigPath,
            azureConfigDir,
            candidateCommands: commands,
            args,
            code,
            elapsedMs: Number(elapsedMs.toFixed(1)),
            thresholdMs: config.slowCommandWarnMs,
            stderrTail: (stderr || '').slice(-400),
          },
          `still running after ${config.slowCommandWarnMs}ms`,
        );
      }

      const exitCode = code ?? -1;
      if (exitCode !== 0) {
        const reason = (stderr || stdout || `exit code ${exitCode}`).trim();
        logCommandOutcome('error', 'exec.finish', 'failed', cmd, args, {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: commands,
          args,
          code: exitCode,
          elapsedMs: Number(elapsedMs.toFixed(1)),
          commandLine: commandText,
        }, `exit code ${exitCode}${reason ? ` - ${reason.slice(-400)}` : ''}`);
      } else {
        logCommandOutcome('info', 'exec.finish', 'success', cmd, args, {
          cmd,
          executablePath: resolvedExecutablePath,
          resolvedExecutablePath,
          kubeconfigPath,
          azureConfigDir,
          candidateCommands: commands,
          args,
          code: exitCode,
          elapsedMs: Number(elapsedMs.toFixed(1)),
          commandLine: commandText,
        }, `exit code ${exitCode}`);
      }

      resolve({ stdout, stderr, code: exitCode });
    });

    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
    }
    child.stdin?.end();
  });
}

const executableCandidatesCache = new Map<string, string[]>();

function executableCandidates(cmd: string): string[] {
  const cached = executableCandidatesCache.get(cmd);
  if (cached) return cached;

  // Keep exact command first to preserve expected behavior on all platforms.
  const candidates = [cmd];
  const hasExt = /\.[a-z0-9]+$/i.test(cmd);
  if (process.platform === 'win32' && !hasExt) {
    // Prefer .exe first (Helm often installs this way), then script wrappers.
    candidates.push(`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`);

    // WinGet adds command aliases under %LOCALAPPDATA%\Microsoft\WinGet\Links.
    // This helps when PATH in the running process is stale.
    const linksDir = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links')
      : undefined;
    if (linksDir && fs.existsSync(linksDir)) {
      const linkExe = path.join(linksDir, `${cmd}.exe`);
      if (fs.existsSync(linkExe)) candidates.push(linkExe);
    }

    const bundledTool = bundledToolPath(cmd);
    if (bundledTool) candidates.push(bundledTool);

    if (cmd.toLowerCase() === 'helm' && process.env.LOCALAPPDATA) {
      const pkgRoot = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(pkgRoot)) {
        try {
          const helmPkg = fs
            .readdirSync(pkgRoot, { withFileTypes: true })
            .find((d) => d.isDirectory() && d.name.startsWith('Helm.Helm_'));
          if (helmPkg) {
            const helmExe = path.join(pkgRoot, helmPkg.name, 'windows-amd64', 'helm.exe');
            if (fs.existsSync(helmExe)) candidates.push(helmExe);
          }
        } catch {
          // Ignore errors reading WinGet packages
        }
      }
    }
  }
  if (process.platform !== 'win32' && !cmd.includes('/')) {
    // Common Linux locations in containers where PATH may differ.
    candidates.push(`/usr/local/bin/${cmd}`, `/usr/bin/${cmd}`, `/bin/${cmd}`);
  }

  executableCandidatesCache.set(cmd, candidates);
  return candidates;
}

const resolveExecutablePathCache = new Map<string, string>();

export function resolveExecutablePath(cmd: string, env: RunOptions['env'] = undefined): string {
  const cacheKey = `${cmd}:${env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ''}`;
  const cached = resolveExecutablePathCache.get(cacheKey);
  if (cached) return cached;

  let resolved = cmd;
  const normalized = path.normalize(cmd);
  if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
    try {
      if (fs.existsSync(normalized)) {
        if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(normalized)) {
          const exeCandidate = normalized.replace(/\.(cmd|bat)$/i, '.exe');
          try {
            if (fs.existsSync(exeCandidate)) resolved = exeCandidate;
            else resolved = normalized;
          } catch {
            resolved = normalized;
          }
        } else {
          resolved = normalized;
        }
      }
    } catch {
      // If existsSync fails, fall back to the original command
      resolved = normalized;
    }
  } else if (process.platform === 'win32') {
    const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? '';
    const entries = pathValue.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
    const hasExt = /\.[a-z0-9]+$/i.test(cmd);
    const extensions = hasExt ? [''] : ['.exe', '.cmd', '.bat'];

    for (const entry of entries) {
      for (const extension of extensions) {
        const candidate = path.join(entry, `${cmd}${extension}`);
        try {
          if (fs.existsSync(candidate)) {
            if (extension === '.cmd' || extension === '.bat') {
              const exeCandidate = candidate.replace(/\.(cmd|bat)$/i, '.exe');
              try {
                if (fs.existsSync(exeCandidate)) {
                  resolved = exeCandidate;
                  break;
                } else {
                  resolved = candidate;
                  break;
                }
              } catch {
                resolved = candidate;
                break;
              }
            } else {
              resolved = candidate;
              break;
            }
          }
        } catch {
          // Ignore existsSync errors and continue to next candidate
          continue;
        }
      }
      if (resolved !== cmd) break;
    }
  }

  resolveExecutablePathCache.set(cacheKey, resolved);
  return resolved;
}

const bundledToolPathCache = new Map<string, string | null>();

function bundledToolPath(cmd: string): string | null {
  if (process.platform !== 'win32') return null;

  const cached = bundledToolPathCache.get(cmd);
  if (cached !== undefined) return cached;

  const resourcesPath = process.env.K8S_EXPLORER_RESOURCES_PATH;
  if (!resourcesPath) {
    bundledToolPathCache.set(cmd, null);
    return null;
  }

  const bundledDir = path.join(resourcesPath, 'extras');
  const base = cmd.toLowerCase();
  const candidates = base === 'az'
    ? [path.join(bundledDir, 'az_installer.msi')]
    : [path.join(bundledDir, `${base}.exe`), path.join(bundledDir, base)];

  let result: string | null = null;
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        result = candidate;
        break;
      }
    } catch {
      // Ignore errors and continue to next candidate
      continue;
    }
  }

  bundledToolPathCache.set(cmd, result);
  return result;
}

/** Run a command and throw an HttpError if it exits non-zero. */
export async function runOrThrow(cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const result = await run(cmd, args, options);
  if (result.code !== 0) {
    throw new HttpError(
      500,
      `${cmd} ${args[0] ?? ''} failed`,
      (result.stderr || result.stdout || '').trim(),
    );
  }
  return result;
}
