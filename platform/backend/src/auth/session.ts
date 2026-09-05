import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import { AzureLoginManager } from '../azure/azure.js';
import { AwsLoginManager } from '../aws/aws.js';
import { config } from '../config.js';
import { HttpError } from '../util/httpError.js';
import { logError, logInfo, logWarn, setLogContext } from '../util/logger.js';
import { kube } from '../kube/client.js';
import { getAzureAccountConfigDir, listAzureAccounts } from '../runtime/azureAccountStore.js';
import { getDesktopContextSource } from '../runtime/desktopStore.js';
import type { CallIdentity } from '../util/callIdentity.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { type Role } from './rbac.js';

const runtimeByUserId = new Map<string, UserSessionState>();
const DESKTOP_EMAIL_HEADER = 'x-focusKube-email';
const DESKTOP_AUTH_STATE_FILE = 'desktop-auth.json';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface UserSessionState {
  userId: string;
  activeContext: string | null;
  activeContextSource: SessionScope | null;
  localKubeconfigPath: string;
  minikubeKubeconfigPath: string;
  localAzureConfigDir: string;
  cloudKubeconfigPath: string;
  cloudAzureConfigDir: string;
  awsKubeconfigPath: string;
  azureLogin: AzureLoginManager;
  azureLoginCloud: AzureLoginManager;
  azureLoginLocal: AzureLoginManager;
  /**
   * The in-flight "cloud" Azure login attempt, if any. Each attempt targets a fresh candidate
   * config dir (see runtime/azureAccountStore.ts) since the device-code flow doesn't reveal
   * which email will complete login until the user finishes in the browser; GET /login/status
   * reconciles it against the account registry by email once it succeeds, retrying up to
   * `finalizeAttempts` times rather than discarding a login it can't immediately identify.
   */
  azureLoginCloudPending: {
    manager: AzureLoginManager;
    configDirName: string;
    configDir: string;
    finalizeAttempts: number;
  } | null;
  contextSourceHints: Record<string, SessionScope>;
  awsConfigFile: string;
  awsCredentialsFile: string;
  awsProfile: string;
  awsLogin: AwsLoginManager;
}

/** 'cloud' means "Azure cloud kubeconfig" specifically — AWS EKS has its own 'aws' bucket. */
export type SessionScope = 'local' | 'minikube' | 'azure' | 'aws';

function setSessionLogContext(operation: string, fields: Record<string, unknown> = {}): void {
  setLogContext({ operation, ...fields });
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

async function ensureDirAsync(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

function defaultLocalKubeconfigPathFor(userId: string): string {
  const base = path.join(config.sessionStorageDir, userId, 'local');
  return path.join(base, 'config');
}

function defaultMinikubeKubeconfigPathFor(userId: string): string {
  return path.join(config.sessionStorageDir, userId, 'minikube', 'config');
}

function defaultAzureCloudKubeconfigPathFor(userId: string): string {
  const base = path.join(config.sessionStorageDir, userId, 'azure');
  return path.join(base, 'config');
}

function defaultAwsCloudKubeconfigPathFor(userId: string): string {
  const base = path.join(config.sessionStorageDir, userId, 'aws');
  return path.join(base, 'kubeconfig');
}

function defaultLocalAzureConfigDirFor(userId: string): string {
  const dir = path.join(config.sessionStorageDir, userId, 'local', '.azure');
  return dir;
}

function defaultLocalAwsConfigDirFor(userId: string): string {
  const dir = path.join(config.sessionStorageDir, userId, 'local', '.aws');
  return dir;
}

function defaultCloudAzureConfigDirFor(userId: string): string {
  const dir = path.join(config.sessionStorageDir, userId, 'azure', '.azure');
  return dir;
}

function defaultAwsConfigPathsFor(userId: string): { configFile: string; credentialsFile: string } {
  const dir = path.join(config.sessionStorageDir, userId, 'aws');
  return {
    configFile: path.join(dir, 'config'),
    credentialsFile: path.join(dir, 'credentials'),
  };
}

type PersistedDesktopAuthState = {
  lastEmail?: string | null;
};

let desktopAuthStateLoaded = false;
// Caches the in-flight load itself (not just a boolean flag set before the first `await`),
// so two concurrent callers before the first load finishes both wait for the SAME read
// instead of the second one observing a still-empty `desktopAuthLastEmail` and racing a
// redundant load - the same class of race fixed in azureAccountStore.ts/desktopStore.ts.
let desktopAuthLoadPromise: Promise<void> | null = null;
let desktopAuthLastEmail: string | null = null;

function desktopAuthStatePath(): string {
  return path.join(config.sessionStorageDir, DESKTOP_AUTH_STATE_FILE);
}

async function ensureDesktopAuthStateLoaded(): Promise<void> {
  if (desktopAuthStateLoaded) return;
  if (!desktopAuthLoadPromise) {
    desktopAuthLoadPromise = (async () => {
      try {
        const raw = await fsp.readFile(desktopAuthStatePath(), 'utf8');
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as PersistedDesktopAuthState;
          if (parsed && typeof parsed.lastEmail === 'string' && parsed.lastEmail.trim()) {
            desktopAuthLastEmail = parsed.lastEmail.trim().toLowerCase();
          }
        }
      } catch (err) {
        logError('auth.desktop_state.load_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        desktopAuthStateLoaded = true;
      }
    })();
  }
  await desktopAuthLoadPromise;
}

async function persistDesktopAuthState(): Promise<void> {
  await ensureDesktopAuthStateLoaded();

  try {
    const payload: PersistedDesktopAuthState = { lastEmail: desktopAuthLastEmail };
    // This is the one piece of desktop auth state every request's identity resolution reads
    // (resolveAuthFromHeaders, below) - write it the same locked+atomic way as every other
    // state file in this app, not a plain writeFileSync that a torn write could corrupt.
    await withFileLock(desktopAuthStatePath(), () =>
      writeFileAtomic(desktopAuthStatePath(), JSON.stringify(payload, null, 2)),
    );
  } catch (err) {
    logError('auth.desktop_state.persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function rememberDesktopAuthEmail(email: string): Promise<void> {
  await ensureDesktopAuthStateLoaded();
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;
  if (desktopAuthLastEmail === normalized) return;
  desktopAuthLastEmail = normalized;
  await persistDesktopAuthState();
}

export async function clearDesktopAuthState(): Promise<void> {
  await ensureDesktopAuthStateLoaded();
  desktopAuthLastEmail = null;
  await persistDesktopAuthState();
}

async function getPersistedDesktopAuthEmailAsync(): Promise<string | null> {
  await ensureDesktopAuthStateLoaded();
  return desktopAuthLastEmail;
}

async function ensureFileAsync(filePath: string): Promise<void> {
  await ensureDirAsync(path.dirname(filePath));
  try {
    await fsp.stat(filePath);
  } catch (err) {
    logError('auth.session.ensure_file_failed', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    await fsp.writeFile(filePath, '', { encoding: 'utf8' });
  }
}

async function copyIfMissingAsync(sourcePath: string, targetPath: string): Promise<void> {
  try {
    let sourceExists = false;
    let targetExists = false;
    try {
      await fsp.stat(sourcePath);
      sourceExists = true;
    } catch (err) {
      logWarn('auth.session.copy_source_stat_failed', {
        sourcePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      await fsp.stat(targetPath);
      targetExists = true;
    } catch (err) {
      logWarn('auth.session.copy_target_stat_failed', {
        targetPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (!sourceExists || targetExists) return;
    await ensureDirAsync(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  } catch {
    // Best effort: users can still authenticate if seed copy fails.
  }
}

async function ensureSessionKubeconfigAsync(kubeconfigPath: string): Promise<void> {
  try {
    // Runs on every session fetch, and seeds an EMPTY kubeconfig when the file looks missing
    // or zero-length. Take the same lock the import/removal/repair paths use so it can never
    // observe another writer's intermediate state and overwrite a real kubeconfig with an
    // empty one.
    await withFileLock(kubeconfigPath, async () => {
      let exists = false;
      let isFile = false;
      let size = 0;
      try {
        const stat = await fsp.stat(kubeconfigPath);
        exists = true;
        isFile = stat.isFile();
        size = stat.size;
      } catch {
        // Best effort only.
      }

      if (exists && isFile && size > 0) return;

      await ensureDirAsync(path.dirname(kubeconfigPath));
      // Keep a syntactically valid empty kubeconfig to avoid noisy parse errors
      // before a user imports credentials.
      await writeFileAtomic(
        kubeconfigPath,
        [
          'apiVersion: v1',
          'kind: Config',
          'clusters: []',
          'contexts: []',
          'users: []',
          'current-context: ""',
        ].join('\n') + '\n',
      );
    });
  } catch (err) {
    logError('auth.session.ensure_kubeconfig_failed', {
      kubeconfigPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function normalizeUserId(raw: string): string {
  // Keep IDs filesystem-safe for temp session folders.
  return raw.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function desktopUserIdForEmail(email: string): string {
  return `desktop_${normalizeUserId(email.toLowerCase())}`;
}

async function createSessionStateAsync(userId: string): Promise<UserSessionState> {
  const cloudKubeconfigPath = defaultAzureCloudKubeconfigPathFor(userId);
  const localKubeconfigPath = defaultLocalKubeconfigPathFor(userId);
  const minikubeKubeconfigPath = defaultMinikubeKubeconfigPathFor(userId);
  const awsKubeconfigPath = defaultAwsCloudKubeconfigPathFor(userId);
  await ensureSessionKubeconfigAsync(cloudKubeconfigPath);
  await ensureSessionKubeconfigAsync(localKubeconfigPath);
  await ensureSessionKubeconfigAsync(minikubeKubeconfigPath);
  await ensureSessionKubeconfigAsync(awsKubeconfigPath);
  const localAzureConfigDir = defaultLocalAzureConfigDirFor(userId);
  const cloudAzureConfigDir = defaultCloudAzureConfigDirFor(userId);
  await ensureDirAsync(localAzureConfigDir);
  await ensureDirAsync(cloudAzureConfigDir);
  const awsPaths = defaultAwsConfigPathsFor(userId);
  // const sourceAwsConfig = process.env.AWS_CONFIG_FILE || path.join(os.homedir(), '.aws', 'config');
  // const sourceAwsCredentials =
  //   process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(os.homedir(), '.aws', 'credentials');
  // await copyIfMissingAsync(sourceAwsConfig, awsPaths.configFile);
  // await copyIfMissingAsync(sourceAwsCredentials, awsPaths.credentialsFile);
  await ensureFileAsync(awsPaths.configFile);
  await ensureFileAsync(awsPaths.credentialsFile);
  const state: UserSessionState = {
    userId,
    activeContext: null,
    activeContextSource: null,
    localKubeconfigPath,
    minikubeKubeconfigPath,
    localAzureConfigDir,
    cloudKubeconfigPath,
    cloudAzureConfigDir,
    awsKubeconfigPath,
    azureLogin: undefined as unknown as AzureLoginManager,
    azureLoginCloud: undefined as unknown as AzureLoginManager,
    azureLoginLocal: undefined as unknown as AzureLoginManager,
    azureLoginCloudPending: null,
    contextSourceHints: {},
    awsConfigFile: awsPaths.configFile,
    awsCredentialsFile: awsPaths.credentialsFile,
    awsProfile: process.env.AWS_PROFILE || 'default',
    awsLogin: undefined as unknown as AwsLoginManager,
  };

  const envProvider = () => ({
    KUBECONFIG: cloudKubeconfigPath,
    AZURE_CONFIG_DIR: cloudAzureConfigDir,
  });

  const localEnvProvider = () => ({
    KUBECONFIG: localKubeconfigPath,
    AZURE_CONFIG_DIR: localAzureConfigDir,
  });

  const awsEnvProvider = () => ({
    AWS_CONFIG_FILE: awsPaths.configFile,
    AWS_SHARED_CREDENTIALS_FILE: awsPaths.credentialsFile,
    AWS_PROFILE: state.awsProfile,
    AWS_SDK_LOAD_CONFIG: '1',
  });

  setSessionLogContext('session.runtime.paths', {
    userId,
    activeContext: null,
    activeContextSource: null,
    localKubeconfigPath,
    minikubeKubeconfigPath,
    localAzureConfigDir,
    cloudKubeconfigPath,
    cloudAzureConfigDir,
    awsKubeconfigPath,
    awsConfigFile: awsPaths.configFile,
    awsCredentialsFile: awsPaths.credentialsFile,
    awsProfile: state.awsProfile,
  });
  logInfo('session.runtime.paths', {
    userId,
    activeContext: null,
    activeContextSource: null,
    localKubeconfigPath,
    minikubeKubeconfigPath,
    localAzureConfigDir,
    cloudKubeconfigPath,
    cloudAzureConfigDir,
    awsKubeconfigPath,
    awsConfigFile: awsPaths.configFile,
    awsCredentialsFile: awsPaths.credentialsFile,
    awsProfile: state.awsProfile,
  });

  state.azureLoginCloud = new AzureLoginManager(envProvider);
  state.azureLoginLocal = new AzureLoginManager(localEnvProvider);
  state.azureLogin = state.azureLoginCloud;
  state.awsLogin = new AwsLoginManager(awsEnvProvider);
  return state;
}

async function getRuntimeSessionAsync(userId: string): Promise<UserSessionState> {
  let state = runtimeByUserId.get(userId);
  if (!state) {
    state = await createSessionStateAsync(userId);
  }
  await ensureSessionKubeconfigAsync(state.cloudKubeconfigPath);
  await ensureSessionKubeconfigAsync(state.awsKubeconfigPath);
  runtimeByUserId.set(userId, state);
  return state;
}

async function restoreImportedContextsIfNeeded(state: UserSessionState): Promise<void> {
  // Never override an explicitly local context selection.
  if (state.activeContextSource === 'local') {
    return;
  }

  const active = state.activeContext;
  if (!active || state.activeContextSource != null) return;

  // Load contexts to see if we already have AKS/EKS contexts loaded. Imported
  // cloud contexts live directly in the session's cloud/aws kubeconfig, so there is
  // nothing further to restore from a database in the desktop-only build.
  try {
    const cloudContexts = await kube.getContexts(state.cloudKubeconfigPath, state.activeContext);
    if (cloudContexts.some((ctx) => ctx.name === active)) {
      state.activeContextSource = 'azure';
      return;
    }
  } catch {
    // If we can't load contexts, skip restoration.
  }

  try {
    const awsContexts = await kube.getContexts(state.awsKubeconfigPath, state.activeContext);
    if (awsContexts.some((ctx) => ctx.name === active)) {
      state.activeContextSource = 'aws';
    }
  } catch {
    // If we can't load contexts, skip restoration.
  }
}

export async function attachUserSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  setSessionLogContext('session.attach.start', {
    path: req.path,
    activeContext: req.userSession?.activeContext ?? null,
    activeContextSource: req.userSession?.activeContextSource ?? null,
  });
  logInfo('session.attach.start', {
    path: req.path,
    activeContext: req.userSession?.activeContext ?? null,
    activeContextSource: req.userSession?.activeContextSource ?? null,
  });
  
  const resolved = await resolveAuthFromHeaders(req.headers);
  setSessionLogContext('session.attach.after_resolve', {
    path: req.path,
    userId: resolved.state?.userId ?? resolved.user?.id ?? null,
    activeContext: resolved.state?.activeContext ?? null,
    activeContextSource: resolved.state?.activeContextSource ?? null,
  });
  logInfo('session.attach.after_resolve', {
    path: req.path,
    userId: resolved.state?.userId ?? resolved.user?.id ?? null,
    activeContext: resolved.state?.activeContext ?? null,
    activeContextSource: resolved.state?.activeContextSource ?? null,
  });

  req.authUser = resolved.user;
  req.userSession = resolved.state as UserSessionState;

  setLogContext({
    userId: resolved.user?.id ?? resolved.state?.userId ?? null,
    userEmail: resolved.user?.email ?? null,
    userRole: resolved.user?.role ?? null,
  });

  if (req.userSession) {
    void restoreImportedContextsIfNeeded(req.userSession).catch((err) => {
      setSessionLogContext('session.runtime.kubeconfig.restore_failed', {
        userId: req.userSession.userId,
        activeContext: req.userSession.activeContext ?? null,
        activeContextSource: req.userSession.activeContextSource ?? null,
        kubeconfigPath: req.userSession.cloudKubeconfigPath,
        azureConfigDir: req.userSession.cloudAzureConfigDir,
      });
      logError('session.runtime.kubeconfig.restore_failed', {
        userId: req.userSession.userId,
        activeContext: req.userSession.activeContext ?? null,
        activeContextSource: req.userSession.activeContextSource ?? null,
        kubeconfigPath: req.userSession.cloudKubeconfigPath,
        azureConfigDir: req.userSession.cloudAzureConfigDir,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  setSessionLogContext('session.attach.before_next', {
    path: req.path,
    userId: req.userSession?.userId ?? resolved.state?.userId ?? resolved.user?.id ?? null,
    activeContext: req.userSession?.activeContext ?? resolved.state?.activeContext ?? null,
    activeContextSource: req.userSession?.activeContextSource ?? resolved.state?.activeContextSource ?? null,
  });
  logInfo('session.attach.before_next', {
    path: req.path,
    userId: req.userSession?.userId ?? resolved.state?.userId ?? resolved.user?.id ?? null,
    activeContext: req.userSession?.activeContext ?? resolved.state?.activeContext ?? null,
    activeContextSource: req.userSession?.activeContextSource ?? resolved.state?.activeContextSource ?? null,
  });
  next();
}

export async function resolveAuthFromHeaders(
  headers: IncomingHttpHeaders,
): Promise<{ user: AuthUser | null; state: UserSessionState | null }> {
  const headerValue = headers[DESKTOP_EMAIL_HEADER];
  const rawEmail = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  let email = rawEmail?.trim().toLowerCase() || (await getPersistedDesktopAuthEmailAsync());

  // Default to the seeded local identity if no email is provided.
  if (!email) {
    email = config.defaultAdminEmail;
  }

  await rememberDesktopAuthEmail(email);

  const userId = desktopUserIdForEmail(email);
  setLogContext({
    userId,
    userEmail: email,
    userRole: 'admin',
  });
  return {
    user: {
      id: userId,
      email,
      role: 'admin',
    },
    state: await getRuntimeSessionAsync(userId),
  };
}

export function sessionEnv(req: Request): Record<string, string> {
  if (!req.userSession) {
    throw new HttpError(401, 'Authentication required');
  }
  return sessionEnvForSource(req, resolveSessionScope(req.userSession, req.userSession.activeContext));
}

export function normalizeSessionScope(scope: string | null | undefined): SessionScope {
  if (scope === 'local' || scope === 'minikube' || scope === 'aws') return scope;
  return 'azure';
}

export function setSessionContextSourceHint(state: UserSessionState, contextName: string | null | undefined, source: SessionScope): void {
  const name = (contextName ?? '').trim();
  if (!name) return;
  state.contextSourceHints[name] = source;
}

export function resolveSessionScope(state: UserSessionState, contextName?: string | null): SessionScope {
  const requested = (contextName ?? '').trim();
  if (requested) {
    const hinted = state.contextSourceHints[requested];
    if (hinted) return hinted;
    if (state.activeContext === requested && state.activeContextSource) {
      return state.activeContextSource;
    }
  }
  if (state.activeContextSource) return state.activeContextSource;
  return 'azure';
}

export async function resolveSessionScopeForContext(
  state: UserSessionState,
  contextName?: string | null,
  requestedSource?: string | null,
): Promise<SessionScope> {
  const requested = (contextName ?? '').trim();
  const sourceParam = (requestedSource ?? '').trim();

  if (sourceParam) {
    const forced = normalizeSessionScope(sourceParam);
    if (!requested) {
      if (state.activeContext) {
        state.activeContextSource = forced;
      }
      return forced;
    }

    const hasContextInSource = async (source: SessionScope): Promise<boolean> => {
      try {
        const contexts = await kube.getContexts(kubeconfigPathForSource(state, source), state.activeContext);
        return contexts.some((ctx) => ctx.name === requested);
      } catch {
        return false;
      }
    };

    // Trust explicit source when it actually contains the requested context.
    if (await hasContextInSource(forced)) {
      setSessionContextSourceHint(state, requested, forced);
      if (state.activeContext === requested) {
        state.activeContextSource = forced;
      }
      return forced;
    }

    // Strict contract: each scope is read only from its own kubeconfig. Never auto-switch sources.
    const otherScopes: SessionScope[] = (['local', 'minikube', 'azure', 'aws'] as SessionScope[]).filter((s) => s !== forced);
    const foundIn = (await Promise.all(otherScopes.map((s) => hasContextInSource(s))))
      .map((found, i) => (found ? otherScopes[i] : null))
      .filter((s): s is SessionScope => s !== null);
    const existsInOpposite = foundIn.length > 0;
    const oppositeSource = foundIn[0];
    setSessionLogContext('session.scope.source_mismatch', {
      requestedContext: requested,
      requestedSource: forced,
      activeContext: state.activeContext ?? null,
      activeContextSource: state.activeContextSource ?? null,
      existsInOpposite,
      oppositeSource,
    });
    logInfo('session.scope.source_mismatch', {
      requestedContext: requested,
      requestedSource: forced,
      activeContext: state.activeContext ?? null,
      activeContextSource: state.activeContextSource ?? null,
      existsInOpposite,
      oppositeSource,
    });
    throw new HttpError(
      400,
      `Context "${requested}" is not available in ${forced} source.`,
      {
        code: 'CONTEXT_SOURCE_MISMATCH',
        context: requested,
        source: forced,
        existsInOpposite,
        oppositeSource,
      },
    );
  }

  if (!requested) {
    return resolveSessionScope(state, contextName);
  }

  const direct = resolveSessionScope(state, requested);
  if (state.contextSourceHints[requested] || (state.activeContext === requested && state.activeContextSource)) {
    return direct;
  }

  try {
    const minikubeContexts = await kube.getContexts(state.minikubeKubeconfigPath, state.activeContext);
    if (minikubeContexts.some((ctx) => ctx.name === requested)) {
      setSessionContextSourceHint(state, requested, 'minikube');
      return 'minikube';
    }
  } catch {
    // Best effort probe only.
  }

  try {
    const localContexts = await kube.getContexts(state.localKubeconfigPath, state.activeContext);
    if (localContexts.some((ctx) => ctx.name === requested)) {
      setSessionContextSourceHint(state, requested, 'local');
      return 'local';
    }
  } catch {
    // Best effort probe only.
  }

  try {
    const cloudContexts = await kube.getContexts(state.cloudKubeconfigPath, state.activeContext);
    if (cloudContexts.some((ctx) => ctx.name === requested)) {
      setSessionContextSourceHint(state, requested, 'azure');
      return 'azure';
    }
  } catch {
    // Best effort probe only.
  }

  try {
    const awsContexts = await kube.getContexts(state.awsKubeconfigPath, state.activeContext);
    if (awsContexts.some((ctx) => ctx.name === requested)) {
      setSessionContextSourceHint(state, requested, 'aws');
      return 'aws';
    }
  } catch {
    // Best effort probe only.
  }

  return direct;
}

export function kubeconfigPathForSource(state: UserSessionState, source: SessionScope): string {
  if (source === 'local') return state.localKubeconfigPath;
  if (source === 'minikube') return state.minikubeKubeconfigPath;
  if (source === 'aws') return state.awsKubeconfigPath;
  return state.cloudKubeconfigPath;
}

export function azureConfigDirForSource(state: UserSessionState, source: SessionScope): string {
  return source === 'local' ? state.localAzureConfigDir : state.cloudAzureConfigDir;
}

export function sessionEnvForSource(req: Request, source: SessionScope): Record<string, string> {
  if (!req.userSession) {
    throw new HttpError(401, 'Authentication required');
  }
  return {
    KUBECONFIG: kubeconfigPathForSource(req.userSession, source),
    AZURE_CONFIG_DIR: azureConfigDirForSource(req.userSession, source),
    AWS_CONFIG_FILE: req.userSession.awsConfigFile,
    AWS_SHARED_CREDENTIALS_FILE: req.userSession.awsCredentialsFile,
    AWS_PROFILE: req.userSession.awsProfile,
    AWS_SDK_LOAD_CONFIG: '1',
  };
}

export function azureLoginManagerForSource(state: UserSessionState, source: SessionScope): AzureLoginManager {
  return source === 'local' ? state.azureLoginLocal : state.azureLoginCloud;
}

export function cloudSessionEnv(req: Request): Record<string, string> {
  return sessionEnvForSource(req, 'azure');
}

export function activeSessionKubeconfigPath(state: UserSessionState, contextName?: string | null): string {
  return kubeconfigPathForSource(state, resolveSessionScope(state, contextName));
}

/**
 * Resolves both the isolated Azure config dir AND the call identity for `contextName` off a
 * single lookup of its persisted context-source doc, for `'azure'`/`'aws'` scope. Both used to
 * fetch that same doc independently (`azureConfigDirForContext` and `resolveCallIdentity`),
 * which meant `resolveScopedRequestContext` paid for it twice on every request - merged here,
 * with `azureConfigDirForContext`/`resolveCallIdentity` kept as thin single-field wrappers for
 * call sites that only need one half.
 */
async function resolveAzureContextInfo(
  state: UserSessionState,
  source: SessionScope,
  contextName?: string | null,
): Promise<{ dir: string; identity: CallIdentity }> {
  const identity: CallIdentity = {
    userId: state.userId,
    scope: source,
    context: (contextName ?? '').trim() || undefined,
  };
  const fallbackDir = azureConfigDirForSource(state, source);
  const name = identity.context;
  if ((source !== 'azure' && source !== 'aws') || !name) {
    return { dir: fallbackDir, identity };
  }

  const doc = await getDesktopContextSource(state.userId, source, name);
  if (!doc) return { dir: fallbackDir, identity };

  identity.accountId = doc.accountId;
  identity.tenantId = doc.tenantId;
  identity.tenantName = doc.tenantName;
  identity.subscriptionId = doc.subscriptionId;
  identity.subscriptionName = doc.subscriptionName;
  identity.resourceGroup = doc.resourceGroup;
  identity.clusterName = doc.clusterName;

  let dir = fallbackDir;
  if (source === 'azure' && doc.accountId) {
    const accountDir = await getAzureAccountConfigDir(state.userId, doc.accountId);
    if (accountDir) dir = accountDir;
    const accounts = await listAzureAccounts(state.userId);
    identity.accountEmail = accounts.find((account) => account.accountId === doc.accountId)?.email;
  }

  return { dir, identity };
}

/**
 * Like `azureConfigDirForSource`, but for `'azure'` scope resolves the SPECIFIC account that
 * owns `contextName` (via its persisted `accountId` tag), instead of the single shared cloud
 * dir. Falls back to the shared dir when no context is given, or the context predates
 * per-account tagging (imported before this isolation was added).
 */
export async function azureConfigDirForContext(
  state: UserSessionState,
  source: SessionScope,
  contextName?: string | null,
): Promise<string> {
  return (await resolveAzureContextInfo(state, source, contextName)).dir;
}

export async function activeSessionAzureConfigDir(state: UserSessionState, contextName?: string | null): Promise<string> {
  return azureConfigDirForContext(state, resolveSessionScope(state, contextName), contextName);
}

/**
 * Resolves exactly which signed-in account/tenant/subscription owns `contextName`, for
 * debug logging on every az/kube/helm/kubectl call. Never throws and never affects
 * which config dir/kubeconfig is actually used - it is read-only, sourced from the same
 * `accountId` tag `azureConfigDirForContext` already uses, plus the account registry and
 * the context's persisted tenant/subscription metadata.
 */
export async function resolveCallIdentity(
  state: UserSessionState,
  source: SessionScope,
  contextName?: string | null,
): Promise<CallIdentity> {
  return (await resolveAzureContextInfo(state, source, contextName)).identity;
}

/**
 * Convenience wrapper for the `resolveSessionScope` + `resolveCallIdentity` pair every WS
 * handler (terminal/logs/exec/port-forward/watch/metrics) needs before calling
 * `ensureContextAuthReady` - keeps that two-line resolution from being repeated at each call site.
 */
export async function resolveSessionAuthContext(
  state: UserSessionState,
  contextName?: string | null,
): Promise<{ scope: SessionScope; identity: CallIdentity }> {
  const scope = resolveSessionScope(state, contextName);
  const identity = await resolveCallIdentity(state, scope, contextName);
  return { scope, identity };
}

/**
 * Same merged resolution as `resolveSessionAuthContext`, but also returns the Azure config
 * dir - for callers (namely `resolveScopedRequestContext`) that need both and would otherwise
 * fetch the same context-source doc twice.
 */
export async function resolveScopedAzureContext(
  state: UserSessionState,
  source: SessionScope,
  contextName?: string | null,
): Promise<{ dir: string; identity: CallIdentity }> {
  return resolveAzureContextInfo(state, source, contextName);
}
