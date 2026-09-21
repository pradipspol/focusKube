import { run, runOrThrow, type RunOptions, type RunResult } from '../util/run.js';
import { kube } from '../kube/client.js';
import { withCliKubeconfig } from '../kube/cliKubeconfig.js';
import { badRequest } from '../util/httpError.js';
import { azureConfigDirForSource, kubeconfigPathForSource, type UserSessionState } from '../auth/session.js';
import type { ScopedRequestContext } from '../routes/requestContext.js';

/**
 * Extracted from routes/helm.ts (Phase 2's AI-tool work needs the same Helm CLI plumbing the
 * human-facing routes already use, decoupled from Express's `req`) — every function here takes
 * an explicit `session`/`scoped` instead of reading `req.query`/`req.userSession`, but otherwise
 * builds the exact same `helm` CLI invocations `routes/helm.ts` used to build inline. That route
 * file is now a thin controller calling into this service.
 */

function helmEnv(session: UserSessionState, source: ScopedRequestContext['selectedScope']): Record<string, string> {
  return {
    KUBECONFIG: kubeconfigPathForSource(session, source),
    AZURE_CONFIG_DIR: azureConfigDirForSource(session, source),
    AWS_CONFIG_FILE: session.awsConfigFile,
    AWS_SHARED_CREDENTIALS_FILE: session.awsCredentialsFile,
    AWS_PROFILE: session.awsProfile,
    AWS_SDK_LOAD_CONFIG: '1',
  };
}

async function helmFlags(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  namespace: string | undefined,
  namespaceRequired = false,
): Promise<string[]> {
  const flags: string[] = [];
  const context = await kube.resolveContextName(scoped.requestedContext, {
    kubeconfigPath: scoped.selectedKubeconfigPath,
    fallbackContext: session.activeContext,
  });
  if (context) flags.push('--kube-context', context);

  if (namespace) flags.push('--namespace', namespace);
  else if (namespaceRequired) throw badRequest('namespace is required');
  return flags;
}

async function withHelmKubeconfig<T>(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  action: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  return withCliKubeconfig(
    { session, context: scoped.requestedContext, source: scoped.selectedScope, env: helmEnv(session, scoped.selectedScope) },
    (env) => action(env),
  );
}

async function runHelm(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  args: string[],
  options: Omit<RunOptions, 'env'> = {},
): Promise<RunResult> {
  return withHelmKubeconfig(session, scoped, (env) => run('helm', args, { identity: scoped.identity, ...options, env }));
}

async function runHelmOrThrow(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  args: string[],
  options: Omit<RunOptions, 'env'> = {},
): Promise<RunResult> {
  return withHelmKubeconfig(session, scoped, (env) => runOrThrow('helm', args, { identity: scoped.identity, ...options, env }));
}

/** `helm upgrade --dry-run`/`helm install --dry-run` prints a preamble (NAME, LAST DEPLOYED,
 * NOTES, etc.) before a `MANIFEST:` section — strip everything but the manifest itself so a
 * diff against `getReleaseManifest`'s raw YAML compares like for like instead of flagging the
 * preamble as noise. */
function extractManifestSection(dryRunOutput: string): string {
  const marker = 'MANIFEST:';
  const idx = dryRunOutput.indexOf(marker);
  return (idx === -1 ? dryRunOutput : dryRunOutput.slice(idx + marker.length)).trim();
}

export async function listReleases(session: UserSessionState, scoped: ScopedRequestContext, namespace?: string): Promise<any[]> {
  const args = ['list', '--output', 'json'];
  if (!namespace) args.push('--all-namespaces');
  args.push(...(await helmFlags(session, scoped, namespace)));
  const { stdout } = await runHelmOrThrow(session, scoped, args);
  return JSON.parse(stdout || '[]');
}

export async function addRepo(session: UserSessionState, scoped: ScopedRequestContext, name: string, url: string): Promise<void> {
  const result = await runHelm(session, scoped, ['repo', 'add', name, url]);
  if (result.code !== 0) throw badRequest('Failed to add Helm repository', (result.stderr || result.stdout).trim());
}

export async function listRepos(session: UserSessionState, scoped: ScopedRequestContext): Promise<any[]> {
  const result = await runHelm(session, scoped, ['repo', 'list', '--output', 'json']);
  if (result.code !== 0) return [];
  return JSON.parse(result.stdout || '[]');
}

export async function searchCharts(session: UserSessionState, scoped: ScopedRequestContext): Promise<any[]> {
  const result = await runHelm(session, scoped, ['search', 'repo', '--output', 'json']);
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout || '').trim();
    // "no repositories to show" should not be a hard error for the UI.
    if (/no repositories to show/i.test(details)) return [];
    throw badRequest('Helm charts lookup failed', details);
  }
  return JSON.parse(result.stdout || '[]');
}

export async function getReleaseHistory(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
): Promise<any[]> {
  const args = ['history', name, '--output', 'json', ...(await helmFlags(session, scoped, namespace, true))];
  const { stdout } = await runHelmOrThrow(session, scoped, args);
  return JSON.parse(stdout || '[]');
}

export async function getReleaseValues(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
): Promise<string> {
  const args = ['get', 'values', name, '--output', 'yaml', ...(await helmFlags(session, scoped, namespace, true))];
  const { stdout } = await runHelmOrThrow(session, scoped, args);
  return stdout;
}

export async function getReleaseManifest(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
  revision?: string,
): Promise<string> {
  const args = ['get', 'manifest', name, ...(revision ? ['--revision', revision] : []), ...(await helmFlags(session, scoped, namespace, true))];
  const { stdout } = await runHelmOrThrow(session, scoped, args);
  return stdout;
}

export async function diffRelease(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
  revision?: string,
): Promise<{ currentManifest: string; comparisonManifest: string }> {
  const currentManifest = await getReleaseManifest(session, scoped, name, namespace);
  if (!revision) return { currentManifest, comparisonManifest: '' };
  const comparisonManifest = await getReleaseManifest(session, scoped, name, namespace, revision);
  return { currentManifest, comparisonManifest };
}

export async function rollbackRelease(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
  revision: number,
): Promise<string> {
  const args = ['rollback', name, String(revision), '--wait', ...(await helmFlags(session, scoped, namespace, true))];
  const result = await runHelm(session, scoped, args);
  if (result.code !== 0) throw badRequest('Helm rollback failed', (result.stderr || result.stdout).trim());
  return (result.stdout || result.stderr).trim();
}

export interface InstallParams {
  chart: string;
  releaseName: string;
  namespace: string;
  values?: string;
  version?: string;
}

export async function installRelease(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  params: InstallParams,
  opts: { dryRun?: boolean } = {},
): Promise<string> {
  const args = ['install', params.releaseName, params.chart, '--namespace', params.namespace];
  if (params.version) args.push('--version', params.version);
  if (params.values) args.push('--values', '/dev/stdin');
  if (opts.dryRun) args.push('--dry-run');
  args.push(...(await helmFlags(session, scoped, undefined)));

  const result = await runHelm(session, scoped, args, { input: params.values || undefined });
  if (result.code !== 0) {
    throw badRequest(opts.dryRun ? 'Helm install preview failed' : 'Helm install failed', (result.stderr || result.stdout).trim());
  }
  return (result.stdout || result.stderr).trim();
}

/** Renders what `installRelease` would create, without actually installing anything — backs
 * the AI `helm_install` tool's approval-card preview (there is no "before" for a brand-new
 * release, only this "after"). */
export async function previewInstall(session: UserSessionState, scoped: ScopedRequestContext, params: InstallParams): Promise<string> {
  const output = await installRelease(session, scoped, params, { dryRun: true });
  return extractManifestSection(output);
}

export interface UpgradeParams {
  version?: string;
  values?: string;
}

/** `helm upgrade` (unlike install) doesn't take a chart argument from the caller — it looks up
 * the release's current chart via its own history, matching routes/helm.ts's original
 * behavior: a client can change the version/values, not swap to a different chart. */
async function resolveUpgradeChartName(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
): Promise<string> {
  const releaseHistory = await runHelmOrThrow(session, scoped, [
    'history',
    name,
    '--max',
    '1',
    '--output',
    'json',
    ...(await helmFlags(session, scoped, namespace, true)),
  ]);
  const history = JSON.parse(releaseHistory.stdout || '[]');
  if (history.length === 0) throw badRequest('Release not found');
  const chart = history[0].chart;
  return chart.split('-').slice(0, -1).join('-');
}

function buildUpgradeArgs(name: string, chartName: string, params: UpgradeParams, dryRun: boolean): string[] {
  const args = ['upgrade', name, chartName];
  if (params.version) args.push('--version', params.version);
  args.push('--reuse-values');
  if (!dryRun) args.push('--wait');
  if (dryRun) args.push('--dry-run');
  if (params.values) {
    args.splice(args.indexOf('--reuse-values'), 1); // remove --reuse-values if we're providing new values
    args.push('--values', '/dev/stdin');
  }
  return args;
}

export async function upgradeRelease(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
  params: UpgradeParams,
): Promise<string> {
  const chartName = await resolveUpgradeChartName(session, scoped, name, namespace);
  const args = [...buildUpgradeArgs(name, chartName, params, false), ...(await helmFlags(session, scoped, namespace, true))];
  const result = await runHelm(session, scoped, args, { input: params.values || undefined });
  if (result.code !== 0) throw badRequest('Helm upgrade failed', (result.stderr || result.stdout).trim());
  return (result.stdout || result.stderr).trim();
}

/** Renders what `upgradeRelease` would produce, without applying it — backs the AI
 * `helm_upgrade` tool's approval-card diff (paired with `getReleaseManifest` as the "before"). */
export async function previewUpgrade(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
  params: UpgradeParams,
): Promise<string> {
  const chartName = await resolveUpgradeChartName(session, scoped, name, namespace);
  const args = [...buildUpgradeArgs(name, chartName, params, true), ...(await helmFlags(session, scoped, namespace, true))];
  const result = await runHelm(session, scoped, args, { input: params.values || undefined });
  if (result.code !== 0) throw badRequest('Helm upgrade preview failed', (result.stderr || result.stdout).trim());
  return extractManifestSection((result.stdout || result.stderr).trim());
}

export async function uninstallRelease(
  session: UserSessionState,
  scoped: ScopedRequestContext,
  name: string,
  namespace: string,
): Promise<string> {
  const args = ['uninstall', name, ...(await helmFlags(session, scoped, namespace, true))];
  const result = await runHelm(session, scoped, args);
  if (result.code !== 0) throw badRequest('Helm uninstall failed', (result.stderr || result.stdout).trim());
  return (result.stdout || result.stderr).trim();
}

/** Chart repo lookups only ever talk to the repo index, never the cluster — no kubeconfig/
 * session scoping needed, matching routes/helm.ts's original `GET /charts/:name/values`. */
export async function getChartValues(chart: string, version?: string): Promise<string> {
  const args = ['show', 'values', chart];
  if (version) args.push('--version', version);
  const result = await run('helm', args);
  if (result.code !== 0) throw badRequest('Failed to fetch chart values', (result.stderr || result.stdout).trim());
  return result.stdout || '';
}
