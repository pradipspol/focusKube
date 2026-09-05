import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { resolveExecutablePath, run, runOrThrow } from '../util/run.js';
import { config } from '../config.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logInfo } from '../util/logger.js';
import { logError, logWarn } from '../util/logger.js';
import type { CallIdentity } from '../util/callIdentity.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

export type LoginState = 'idle' | 'pending' | 'succeeded' | 'failed';

interface DeviceCodeInfo {
  message: string;
  verificationUrl?: string;
  userCode?: string;
}

interface AzureLoginDiagnostics {
  lastAzCandidate?: string;
}

export function getAzCliInstallationHints(): string[] {
  const hints: string[] = [];
  const cliFromEnv = process.env.AZURE_CLI_PATH?.trim();
  if (!cliFromEnv) {
    hints.push('Set AZURE_CLI_PATH environment variable to the location of az.exe');
  }
  const knownRoots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    'C:\\Program Files (x86)',
    'C:\\Program Files',
  ].filter(Boolean) as string[];
  for (const root of knownRoots) {
    const base = path.join(root, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin');
    hints.push(`Install Azure CLI to default location: ${base}`);
  }
  hints.push('Or install via: https://learn.microsoft.com/en-us/cli/azure/install-azure-cli-windows');
  return hints;
}

function buildAzCandidates(): string[] {
  if (process.platform !== 'win32') {
    return ['az'];
  }

  const candidates: string[] = [];

  // Allow the operator to pin an explicit path via env var.
  const cliFromEnv = process.env.AZURE_CLI_PATH?.trim();
  if (cliFromEnv) candidates.push(cliFromEnv);

  // Probe the standard MSI install locations for az.cmd / az.exe so that the
  // backend works even when the inherited PATH is stale (e.g. fresh install
  // in the same Windows session before a shell restart).
  const knownRoots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    'C:\\Program Files (x86)',
    'C:\\Program Files',
  ].filter(Boolean) as string[];

  for (const root of knownRoots) {
    const base = path.join(root, 'Microsoft SDKs', 'Azure', 'CLI2', 'wbin');
    const azCmd = path.join(base, 'az.cmd');
    try { if (fs.existsSync(azCmd)) candidates.push(azCmd); } catch { /* ignore */ }
    const azExe = path.join(base, 'az.exe');
    try { if (fs.existsSync(azExe)) candidates.push(azExe); } catch { /* ignore */ }
  }

  // WinGet alias link — present when installed via winget.
  if (process.env.LOCALAPPDATA) {
    const wingetLink = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'az.cmd');
    try { if (fs.existsSync(wingetLink)) candidates.push(wingetLink); } catch { /* ignore */ }
  }

  // Generic fallbacks — rely on PATH being correct.
  candidates.push('az.cmd', 'az.exe', 'az');

  return Array.from(new Set(candidates));
}

let cmdExeCache: string | null = null;

function resolveCmdExe(): string {
  if (cmdExeCache) return cmdExeCache;

  const comSpec = process.env.ComSpec?.trim();
  if (comSpec) {
    try {
      if (fs.existsSync(comSpec)) {
        cmdExeCache = comSpec;
        return cmdExeCache;
      }
    } catch {
      // Fall through to next candidate
    }
  }

  const systemRoot = process.env.SystemRoot?.trim();
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'cmd.exe');
    try {
      if (fs.existsSync(candidate)) {
        cmdExeCache = candidate;
        return cmdExeCache;
      }
    } catch {
      // Fall through to default
    }
  }

  cmdExeCache = 'C:\\Windows\\System32\\cmd.exe';
  return cmdExeCache;
}

type AzureCliLoginProbeState = {
  checkedAt: number;
  value: boolean | null;
  inFlight: Promise<boolean> | null;
};

const azureCliLoginProbeCache = new Map<string, AzureCliLoginProbeState>();

function azureCliLoginCacheKey(azureConfigDir: string): string {
  return azureConfigDir.trim() || '__default__';
}

function azureCliLoginProbeStateFor(azureConfigDir: string): AzureCliLoginProbeState {
  const key = azureCliLoginCacheKey(azureConfigDir);
  const existing = azureCliLoginProbeCache.get(key);
  if (existing) return existing;

  const created: AzureCliLoginProbeState = {
    checkedAt: 0,
    value: null,
    inFlight: null,
  };
  azureCliLoginProbeCache.set(key, created);
  return created;
}

export function invalidateAzureCliLoginCache(azureConfigDir?: string): void {
  if (!azureConfigDir) {
    azureCliLoginProbeCache.clear();
    return;
  }
  azureCliLoginProbeCache.delete(azureCliLoginCacheKey(azureConfigDir));
}

function isAzureDeviceCodeNoise(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('interactive authentication is needed') ||
    normalized.includes('please run: az login') ||
    normalized.includes('please run az login')
  );
}

export async function hasAzureCliLogin(azureConfigDir: string): Promise<boolean> {
  const state = azureCliLoginProbeStateFor(azureConfigDir);
  const now = Date.now();
  const cacheKey = azureCliLoginCacheKey(azureConfigDir);

  const cacheThresholdMs = state.value === false
    ? config.azureAuthCheckNegativeCacheMs
    : config.azureAuthCheckCacheMs;
  if (state.value !== null && now - state.checkedAt < cacheThresholdMs) {
    logInfo('azure.login.check.cached', {
      azureConfigDir,
      cacheKey,
      cachedValue: state.value,
      cacheAgeMs: now - state.checkedAt,
      cacheThresholdMs,
    });
    return state.value;
  }

  if (state.inFlight) {
    logInfo('azure.login.check.inflight', {
      azureConfigDir,
      cacheKey,
    });
    return state.inFlight;
  }

  logInfo('azure.login.check.start', {
    azureConfigDir,
    cacheKey,
    timeoutMs: config.azureAuthCheckTimeoutMs,
  });

  const checkStartTime = Date.now();
  state.inFlight = (async () => {
    try {
      logInfo('azure.login.az_account_show.start', {
        azureConfigDir,
        cacheKey,
      });
      const candidates = buildAzCandidates();
      const result = await run(
        'az',
        ['account', 'show', '--output', 'none'],
        {
          env: { AZURE_CONFIG_DIR: azureConfigDir },
          timeoutMs: config.azureAuthCheckTimeoutMs,
          candidates,
        },
      );
      logInfo('azure.login.az_account_show.complete', {
        azureConfigDir,
        cacheKey,
        exitCode: result.code,
        elapsed: Date.now() - checkStartTime,
      });
      state.value = result.code === 0;
      state.checkedAt = Date.now();
      return state.value;
    } catch (err) {
      logInfo('azure.login.az_account_show.error', {
        azureConfigDir,
        cacheKey,
        error: (err as Error).message,
        elapsed: Date.now() - checkStartTime,
      });
      state.value = false;
      state.checkedAt = Date.now();
      return false;
    } finally {
      state.inFlight = null;
    }
  })();

  return state.inFlight;
}

/**
 * Manages an interactive `az login --use-device-code` session. The device code
 * is surfaced to the caller while the CLI keeps polling Azure in the background.
 */
export class AzureLoginManager {
  private proc: ChildProcess | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private state: LoginState = 'idle';
  private lastMessage = '';
  private deviceInfo: DeviceCodeInfo | null = null;
  private diagnostics: AzureLoginDiagnostics = {};
  private readonly envProvider: () => Record<string, string>;
  readonly _instanceId: string;

  constructor(envProvider: () => Record<string, string>) {
    this.envProvider = envProvider;
    this._instanceId = `azlogin_${Math.random().toString(36).slice(2, 9)}`;
    logInfo('azure.login.manager.created', { instanceId: this._instanceId });
  }

  getStatus() {
    return {
      state: this.state,
      message: this.lastMessage,
      deviceInfo: this.deviceInfo,
      diagnostics: this.diagnostics,
    };
  }

  /**
   * Abandon an in-flight login: kill the `az login` child and stop the watchdog.
   *
   * Without this, replacing a pending login (e.g. the user clicks "Add Azure account"
   * twice) leaves the first `az login --use-device-code` polling Azure until its device
   * code expires. If the user then completes THAT code, the CLI writes credentials into a
   * config directory nothing references any more - a successful sign-in that never appears
   * in the app, plus a stray credentialed directory on disk.
   */
  cancel(reason = 'Azure login cancelled.'): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
    if (this.state === 'pending') {
      this.state = 'failed';
      this.lastMessage = reason;
    }
    this.deviceInfo = null;
    logInfo('azure.login.cancelled', { instanceId: this._instanceId, reason });
  }

  /**
   * Start device-code login and resolve once the code is available.
   * Without a tenantId, `az login` resolves whatever tenant is currently
   * the account's default - which may not be the tenant a given cluster
   * actually trusts (e.g. a guest/customer tenant). Passing one pins the
   * sign-in to that specific tenant instead.
   */
  start(tenantId?: string): Promise<DeviceCodeInfo> {
    if (this.state === 'pending') {
      return Promise.resolve(this.deviceInfo ?? { message: this.lastMessage });
    }
    this.state = 'pending';
    this.lastMessage = 'Starting Azure login…';
    this.deviceInfo = null;
    this.diagnostics = {};

    return new Promise((resolve) => {
      const azLoginArgs = tenantId
        ? ['login', '--use-device-code', '--tenant', tenantId]
        : ['login', '--use-device-code'];
      const azCandidates = buildAzCandidates();

      let candidateIndex = 0;
      this.watchdog = null;
      let sawDeviceCode = false;
      let outputBuffer = '';

      const parseDeviceInfo = (): void => {
        const urlMatch = outputBuffer.match(/https?:\/\/\S+/i);
        const codeMatch =
          outputBuffer.match(/enter\s+(?:the\s+)?code\s+([A-Z0-9-]+)/i) ??
          outputBuffer.match(/\bcode\s+([A-Z0-9-]{8,})\b/i);
        if (urlMatch || codeMatch) {
          sawDeviceCode = true;
          if (this.watchdog) clearTimeout(this.watchdog);
          this.deviceInfo = {
            message: this.lastMessage || 'Azure device code received.',
            verificationUrl: urlMatch?.[0],
            userCode: codeMatch?.[1],
          };
          logInfo('azure.login.device_code.found', {
            instanceId: this._instanceId,
            hasUrl: !!urlMatch,
            hasCode: !!codeMatch,
            url: urlMatch?.[0] ?? null,
            code: codeMatch?.[1] ?? null,
          });
        }
      };

      const handle = (chunk: Buffer) => {
        const text = chunk.toString();
        const trimmed = text.trim();
        if (trimmed && !isAzureDeviceCodeNoise(trimmed)) {
          this.lastMessage = trimmed;
        }
        outputBuffer = `${outputBuffer}${text}`;
        // Keep a bounded rolling window; device-code prompt is short and near the tail.
        if (outputBuffer.length > 4096) outputBuffer = outputBuffer.slice(-4096);
        parseDeviceInfo();
      };

      const trySpawn = () => {
        const cmd = azCandidates[candidateIndex];
        if (!cmd) {
          this.state = 'failed';
          this.lastMessage = 'Azure CLI executable not found. Install Azure CLI and ensure az is on PATH.';
          if (this.watchdog) clearTimeout(this.watchdog);
          return;
        }
        this.diagnostics.lastAzCandidate = cmd;
        const env = this.envProvider();
        const resolvedExecutablePath = resolveExecutablePath(cmd, {
          PATH: process.env.PATH ?? '',
          Path: process.env.Path ?? '',
        });
        logInfo('azure.login.exec.start', {
          cmd,
          executablePath: resolvedExecutablePath,
          commandPath: cmd,
          resolvedExecutablePath,
          kubeconfigPath: env.KUBECONFIG,
          azureConfigDir: env.AZURE_CONFIG_DIR,
          args: azLoginArgs,
          candidateIndex,
          candidateCommands: azCandidates,
          commandLine: commandLine(cmd, azLoginArgs),
          platform: process.platform,
        });

        const isWindowsScript =
          process.platform === 'win32' && (cmd.toLowerCase().endsWith('.cmd') || cmd.toLowerCase().endsWith('.bat'));

        let child: ChildProcess;
        try {
          if (isWindowsScript) {
            // On Windows, use shell: true to invoke .cmd files properly with stdio pipes
            const cmdLine = cmd.includes(' ') ? `"${cmd}"` : cmd;
            const args = azLoginArgs.map(arg => (arg.includes(' ') ? `"${arg}"` : arg)).join(' ');
            child = spawn(`${cmdLine} ${args}`, [], {
              env: { ...process.env, ...env, PYTHONUNBUFFERED: '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: true,
              windowsHide: true,
            });
          } else {
            child = spawn(cmd, azLoginArgs, {
              env: { ...process.env, ...env, PYTHONUNBUFFERED: '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
              shell: false,
            });
          }
        } catch (err) {
          const e = err as NodeJS.ErrnoException;
          if ((e.code === 'ENOENT' || e.code === 'EINVAL') && candidateIndex < azCandidates.length - 1) {
            logError('azure.login.exec.spawn_fallback', {
              cmd,
              executablePath: resolvedExecutablePath,
              commandPath: cmd,
              resolvedExecutablePath,
              kubeconfigPath: env.KUBECONFIG,
              azureConfigDir: env.AZURE_CONFIG_DIR,
              candidateCommands: azCandidates,
              fallbackExecutablePath: azCandidates[candidateIndex + 1] ?? null,
              code: e.code,
            });
            candidateIndex += 1;
            trySpawn();
            return;
          }
          this.state = 'failed';
          this.lastMessage = `Failed to start az: ${e.message}`;
          logCommandOutcome('error', 'azure.login.exec.spawn_failed', 'failed', cmd, azLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            kubeconfigPath: env.KUBECONFIG,
            azureConfigDir: env.AZURE_CONFIG_DIR,
            candidateCommands: azCandidates,
            commandLine: commandLine(cmd, azLoginArgs),
            code: e.code,
            message: e.message,
          }, commandReason(e));
          if (this.watchdog) clearTimeout(this.watchdog);
          return;
        }

        this.proc = child;
        this.lastMessage = 'Waiting for Azure device code…';

        this.watchdog = setTimeout(() => {
          if (this.state !== 'pending') return;
          this.state = 'failed';
          this.lastMessage =
            'Azure login did not produce a device code before timeout. ' +
            'Check Azure CLI connectivity and retry.';
          logCommandOutcome('error', 'azure.login.exec.timeout', 'timedout', cmd, azLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            kubeconfigPath: env.KUBECONFIG,
            azureConfigDir: env.AZURE_CONFIG_DIR,
            candidateCommands: azCandidates,
            commandLine: commandLine(cmd, azLoginArgs),
            state: this.state,
            sawDeviceCode,
          }, 'Azure login did not produce a device code within 30s');
          this.proc?.kill('SIGKILL');
          this.proc = null;
        }, 30_000);
        this.watchdog.unref();

        child.stdout?.on('data', handle);
        child.stderr?.on('data', handle);

        child.on('error', (err) => {
          const e = err as NodeJS.ErrnoException;
          if ((e.code === 'ENOENT' || e.code === 'EINVAL') && candidateIndex < azCandidates.length - 1) {
            logError('azure.login.exec.error_fallback', {
              cmd,
              executablePath: resolvedExecutablePath,
              commandPath: cmd,
              resolvedExecutablePath,
              kubeconfigPath: env.KUBECONFIG,
              azureConfigDir: env.AZURE_CONFIG_DIR,
              candidateCommands: azCandidates,
              fallbackExecutablePath: azCandidates[candidateIndex + 1] ?? null,
              code: e.code,
            });
            if (this.watchdog) clearTimeout(this.watchdog);
            candidateIndex += 1;
            trySpawn();
            return;
          }
          this.state = 'failed';
          this.lastMessage = `Failed to start az: ${err.message}`;
          logCommandOutcome('error', 'azure.login.exec.error', 'failed', cmd, azLoginArgs, {
            cmd,
            executablePath: resolvedExecutablePath,
            commandPath: cmd,
            resolvedExecutablePath,
            kubeconfigPath: env.KUBECONFIG,
            azureConfigDir: env.AZURE_CONFIG_DIR,
            candidateCommands: azCandidates,
            commandLine: commandLine(cmd, azLoginArgs),
            code: e.code,
            message: err.message,
          }, commandReason(err));
          if (this.watchdog) clearTimeout(this.watchdog);
        });

        child.on('close', (code) => {
          this.proc = null;
          logInfo('azure.login.process.close', {
            instanceId: this._instanceId,
            code,
            currentState: this.state,
            sawDeviceCode,
          });
          if (this.state !== 'pending' && this.watchdog) clearTimeout(this.watchdog);
          if (code === 0) {
            this.state = 'succeeded';
            this.lastMessage = 'Azure login succeeded.';
            const activeAzureConfigDir = this.envProvider().AZURE_CONFIG_DIR;
            if (activeAzureConfigDir) {
              invalidateAzureCliLoginCache(activeAzureConfigDir);
            }
            logInfo('azure.login.state.succeeded', {
              instanceId: this._instanceId,
            });
            logCommandOutcome('info', 'azure.login.exec.finish', 'success', cmd, azLoginArgs, {
              cmd,
              executablePath: resolvedExecutablePath,
              commandPath: cmd,
              resolvedExecutablePath,
              kubeconfigPath: env.KUBECONFIG,
              azureConfigDir: env.AZURE_CONFIG_DIR,
              candidateCommands: azCandidates,
              commandLine: commandLine(cmd, azLoginArgs),
              code,
              state: this.state,
              sawDeviceCode,
            }, 'Azure login completed successfully');
          } else if (this.state !== 'succeeded') {
            if (code === -4058) {
              if (candidateIndex < azCandidates.length - 1) {
                if (this.watchdog) clearTimeout(this.watchdog);
                candidateIndex += 1;
                trySpawn();
                return;
              }
              if (this.watchdog) clearTimeout(this.watchdog);
              this.state = 'failed';
              this.lastMessage =
                'Azure CLI executable not found for backend process (Windows ENOENT). ' +
                'Ensure az is on PATH for the process running backend, then restart backend.';
              logCommandOutcome('error', 'azure.login.exec.not_found', 'failed', cmd, azLoginArgs, {
                cmd,
                executablePath: resolvedExecutablePath,
                commandPath: cmd,
                resolvedExecutablePath,
                kubeconfigPath: env.KUBECONFIG,
                azureConfigDir: env.AZURE_CONFIG_DIR,
                candidateCommands: azCandidates,
                commandLine: commandLine(cmd, azLoginArgs),
                code,
              }, 'Azure CLI executable not found');
            } else if (!sawDeviceCode && this.state === 'pending') {
              // Keep status as pending; the watchdog will mark timeout/failure if no
              // device code appears within the allowed window.
              this.lastMessage = 'Waiting for Azure device code…';
            } else {
              if (this.watchdog) clearTimeout(this.watchdog);
              this.state = 'failed';
              if (!this.lastMessage || this.lastMessage === 'Starting Azure login…' || isAzureDeviceCodeNoise(this.lastMessage)) {
                this.lastMessage = `az login exited with code ${code}`;
              }
              logCommandOutcome('error', 'azure.login.exec.finish', 'failed', cmd, azLoginArgs, {
                cmd,
                executablePath: resolvedExecutablePath,
                commandPath: cmd,
                resolvedExecutablePath,
                kubeconfigPath: env.KUBECONFIG,
                azureConfigDir: env.AZURE_CONFIG_DIR,
                candidateCommands: azCandidates,
                commandLine: commandLine(cmd, azLoginArgs),
                code,
                state: this.state,
                sawDeviceCode,
              }, this.lastMessage || `az login exited with code ${code}`);
            }
          }
        });
      };

      trySpawn();
      resolve({ message: this.lastMessage });
    });
  }
}

interface AzureExecOptions {
  env?: Record<string, string>;
  /** Which signed-in account/tenant/subscription this call is operating against, for debug logging. */
  identity?: CallIdentity;
}

/** Every `az` invocation in this file needs the same candidate-executable resolution. */
function runAz(args: string[], options: AzureExecOptions = {}) {
  return run('az', args, { ...options, candidates: buildAzCandidates() });
}

function runAzOrThrow(args: string[], options: AzureExecOptions = {}) {
  return runOrThrow('az', args, { ...options, candidates: buildAzCandidates() });
}

export async function azAccountShow(options: AzureExecOptions = {}): Promise<unknown | null> {
  const res = await runAz(['account', 'show', '--output', 'json'], options);
  if (res.code !== 0) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

export async function azListSubscriptions(options: AzureExecOptions & { refresh?: boolean } = {}): Promise<unknown[]> {
  // Without --refresh, `az account list` reads the local on-disk profile cache, which is only
  // as fresh as the last `az login`/list call - it can miss subscriptions granted (directly or
  // via Azure Lighthouse delegation) since then, even though the Azure Portal already shows
  // them live. --refresh forces a real round trip to re-enumerate from the server.
  const args = ['account', 'list', '--all', '--output', 'json'];
  if (options.refresh) args.push('--refresh');
  const res = await runAz(args, options);
  if (res.code !== 0) {
    logWarn('azure.account_list.failed', {
      code: res.code,
      stderr: res.stderr,
      stdout: res.stdout,
    });
    return [];
  }
  return JSON.parse(res.stdout || '[]');
}

/**
 * `az account list` only carries each subscription's tenantId, not a
 * friendly tenant name. `az account tenant list` would give us that, but it
 * lives in the optional `account` CLI extension - a non-interactive `az`
 * invocation hits that command's "install extension? (Y/n)" prompt and fails
 * immediately with EOF, and auto-installing an extension mid-request is its
 * own source of latency/failure (network access, proxies). `az rest` is a
 * built-in core command, so hit the ARM Tenants API directly instead.
 */
export async function azListTenants(options: AzureExecOptions = {}): Promise<unknown[]> {
  const res = await runAz(
    ['rest', '--method', 'get', '--url', 'https://management.azure.com/tenants?api-version=2022-12-01', '--output', 'json'],
    options,
  );
  if (res.code !== 0) {
    logWarn('azure.tenant_list.failed', {
      code: res.code,
      stderr: res.stderr,
      stdout: res.stdout,
    });
    return [];
  }
  try {
    const parsed = JSON.parse(res.stdout || '{}');
    return Array.isArray(parsed?.value) ? parsed.value : [];
  } catch (err) {
    logWarn('azure.tenant_list.parse_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export async function azLogout(
  options: AzureExecOptions & { username?: string } = {},
): Promise<void> {
  // Logout can return non-zero if no sessions are present; treat that as non-fatal.
  // When a username is supplied, only that account is signed out — the Azure CLI
  // config dir can hold multiple accounts at once.
  const args = ['logout'];
  if (options.username) args.push('--username', options.username);
  const res = await runAz(args, options);
  if (res.code !== 0) {
    const msg = `${res.stderr || res.stdout}`.toLowerCase();
    if (!msg.includes('not logged in') && !msg.includes('no subscriptions')) {
      throw new Error((res.stderr || res.stdout || 'Azure logout failed').trim());
    }
  }
}

export async function azSetSubscription(id: string, options: AzureExecOptions = {}): Promise<void> {
  await runAzOrThrow(['account', 'set', '--subscription', id], options);
}

export async function azListAks(
  subscription?: string,
  options: AzureExecOptions = {},
): Promise<unknown[]> {
  const args = ['aks', 'list', '--output', 'json'];
  if (subscription) args.push('--subscription', subscription);
  const { stdout } = await runAzOrThrow(args, options);
  return JSON.parse(stdout || '[]');
}

export async function azGetAksCredentials(opts: {
  resourceGroup: string;
  name: string;
  subscription?: string;
  admin?: boolean;
  kubeconfigPath?: string;
  env?: Record<string, string>;
  identity?: CallIdentity;
}): Promise<void> {
  const args = [
    'aks',
    'get-credentials',
    '--resource-group',
    opts.resourceGroup,
    '--name',
    opts.name,
    '--overwrite-existing',
  ];
  if (opts.subscription) args.push('--subscription', opts.subscription);
  if (opts.admin) args.push('--admin');
  if (opts.kubeconfigPath || config.kubeconfigPath) args.push('--file', opts.kubeconfigPath ?? config.kubeconfigPath!);
  await runAzOrThrow(args, { env: opts.env, identity: opts.identity });

  // Post-process the kubeconfig to use azurecli method instead of devicecode
  // to avoid interactive hangs when kubelogin is invoked by the Kubernetes client
  const kubeconfigPath = opts.kubeconfigPath ?? config.kubeconfigPath;
  if (kubeconfigPath) {
    try {
      // Normally this is the caller's private scratch file, but it falls back to the SHARED
      // kubeconfig when no path is given - so take the lock and write atomically rather than
      // relying on which path happened to be passed.
      await withFileLock(kubeconfigPath, async () => {
        const kubeconfigContent = await fsp.readFile(kubeconfigPath, 'utf-8');
        // Replace devicecode login method with azurecli to use cached Azure CLI credentials
        const patchedContent = kubeconfigContent.replace(
          /(\s+- )devicecode/g,
          '$1azurecli'
        );
        if (patchedContent !== kubeconfigContent) {
          await writeFileAtomic(kubeconfigPath, patchedContent);
        }
      });
    } catch (err) {
      // Log but don't fail if kubeconfig patching fails
      logError('azure.get_aks_credentials.patch_kubeconfig_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
