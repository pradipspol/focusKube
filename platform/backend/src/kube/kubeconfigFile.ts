import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

/**
 * Read a kubeconfig from disk.
 *
 * Returns `null` only when the file genuinely isn't there (or is empty). Anything else -
 * a YAML syntax error, a permissions error, a document that isn't a mapping - throws.
 * Conflating those with "absent" would silently replace a recoverable-but-damaged
 * kubeconfig with an empty one, destroying every context the user had imported.
 */
async function readKubeconfigDoc(kubeconfigPath: string): Promise<any | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(kubeconfigPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!raw.trim()) return null;
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`Kubeconfig at ${kubeconfigPath} is not a valid kubeconfig document.`);
  }
  return doc;
}

/**
 * Remove the named contexts (and any clusters/users they exclusively reference)
 * from a kubeconfig file on disk, fixing `current-context` if it pointed at one
 * of them. Returns true if anything was removed. Safe to call when the file is
 * missing/empty or none of the names are present (returns false); throws if the file
 * exists but can't be parsed, rather than reporting a silent no-op.
 */
export async function removeContextsFromKubeconfigFile(kubeconfigPath: string, names: Set<string>): Promise<boolean> {
  if (names.size === 0) return false;
  return withFileLock(kubeconfigPath, () => removeContextsFromKubeconfigFileUnlocked(kubeconfigPath, names));
}

async function removeContextsFromKubeconfigFileUnlocked(kubeconfigPath: string, names: Set<string>): Promise<boolean> {
  const doc = await readKubeconfigDoc(kubeconfigPath);
  if (!doc || !Array.isArray(doc.contexts)) return false;

  const removed = doc.contexts.filter((c: any) => names.has(c?.name));
  if (removed.length === 0) return false;
  doc.contexts = doc.contexts.filter((c: any) => !names.has(c?.name));

  const stillUsedClusters = new Set(doc.contexts.map((c: any) => c?.context?.cluster).filter(Boolean));
  const stillUsedUsers = new Set(doc.contexts.map((c: any) => c?.context?.user).filter(Boolean));
  const clustersToDrop = new Set(removed.map((c: any) => c?.context?.cluster).filter(Boolean));
  const usersToDrop = new Set(removed.map((c: any) => c?.context?.user).filter(Boolean));

  if (Array.isArray(doc.clusters)) {
    doc.clusters = doc.clusters.filter(
      (cl: any) => !(clustersToDrop.has(cl?.name) && !stillUsedClusters.has(cl?.name)),
    );
  }
  if (Array.isArray(doc.users)) {
    doc.users = doc.users.filter(
      (u: any) => !(usersToDrop.has(u?.name) && !stillUsedUsers.has(u?.name)),
    );
  }
  if (names.has(doc['current-context'])) {
    doc['current-context'] = doc.contexts[0]?.name ?? '';
  }

  await writeFileAtomic(kubeconfigPath, yaml.dump(doc));
  return true;
}

function emptyKubeconfigDoc(): any {
  return { apiVersion: 'v1', kind: 'Config', preferences: {}, clusters: [], users: [], contexts: [], 'current-context': '' };
}

/**
 * Merge the single cluster/user/context entry that `az aks get-credentials --file
 * <sourceKubeconfigPath>` just wrote into a scratch file, into the shared target kubeconfig -
 * renaming that entry first via `resolveContextName`.
 *
 * This exists because `az aks get-credentials` names its cluster/user/context entries purely
 * from the AKS cluster name and resource group, with no subscription or tenant in the name. Two
 * different signed-in accounts (or two subscriptions in different tenants) can easily have a
 * cluster with the same name in a same-named resource group; importing straight into a shared
 * kubeconfig with `--overwrite-existing` would then silently overwrite one account's credentials
 * with the other's. Importing into an isolated scratch file first and merging by a name we
 * control here sidesteps that - `resolveContextName` picks a disambiguated name when the
 * caller detects the default name is already claimed by a different subscription.
 *
 * The cluster and user entries are normally written under the same final name as the context,
 * but never at the cost of re-pointing somebody else's context: `clusters`/`users`/`contexts`
 * are separate namespaces, so a name that is free as a context can still be in use as a
 * cluster or user by an unrelated context. See `pickFreeEntryName`.
 *
 * `resolveContextName` is invoked inside the file lock, so a caller that needs to consult
 * shared state to choose the name (and then write that state) can do so without racing
 * another concurrent import.
 */
export async function mergeAksCredentialsIntoKubeconfig(
  sourceKubeconfigPath: string,
  targetKubeconfigPath: string,
  resolveContextName: (defaultContextName: string) => string | Promise<string>,
  /**
   * Runs inside the same lock, immediately after the merge is written. Lets the caller record
   * its claim on `contextName` (e.g. the owning account tag) without a window in which a
   * concurrent import could read pre-claim state and pick the same name.
   */
  onMerged?: (contextName: string) => void | Promise<void>,
): Promise<{ contextName: string }> {
  return withFileLock(targetKubeconfigPath, async () => {
    const sourceDoc: any = yaml.load(await fsp.readFile(sourceKubeconfigPath, 'utf8'));
    const sourceContext = sourceDoc?.contexts?.[0];
    if (!sourceContext?.name || !sourceContext.context) {
      throw new Error('az aks get-credentials did not produce a usable context');
    }
    const sourceCluster = (sourceDoc.clusters ?? []).find((c: any) => c?.name === sourceContext.context.cluster);
    const sourceUser = (sourceDoc.users ?? []).find((u: any) => u?.name === sourceContext.context.user);
    if (!sourceCluster || !sourceUser) {
      throw new Error('az aks get-credentials produced an incomplete context');
    }

    const contextName = await resolveContextName(sourceContext.name);

    const targetDoc: any = (await readKubeconfigDoc(targetKubeconfigPath)) ?? emptyKubeconfigDoc();
    targetDoc.clusters = Array.isArray(targetDoc.clusters) ? targetDoc.clusters : [];
    targetDoc.users = Array.isArray(targetDoc.users) ? targetDoc.users : [];
    targetDoc.contexts = Array.isArray(targetDoc.contexts) ? targetDoc.contexts : [];

    // Whatever a previous import of THIS context name pointed at is ours to replace - but only
    // that. Capture it before dropping the context, since the context is the only link to it.
    const priorContext = targetDoc.contexts.find((c: any) => c?.name === contextName);
    const priorCluster: string | undefined = priorContext?.context?.cluster;
    const priorUser: string | undefined = priorContext?.context?.user;

    targetDoc.contexts = targetDoc.contexts.filter((c: any) => c?.name !== contextName);

    // Recomputed AFTER removing our own context, so these are exactly the cluster/user entries
    // some OTHER context still depends on. They are off limits.
    const claimedClusters = new Set<string>(
      targetDoc.contexts.map((c: any) => c?.context?.cluster).filter(Boolean),
    );
    const claimedUsers = new Set<string>(targetDoc.contexts.map((c: any) => c?.context?.user).filter(Boolean));

    if (priorCluster && !claimedClusters.has(priorCluster)) {
      targetDoc.clusters = targetDoc.clusters.filter((c: any) => c?.name !== priorCluster);
    }
    if (priorUser && !claimedUsers.has(priorUser)) {
      targetDoc.users = targetDoc.users.filter((u: any) => u?.name !== priorUser);
    }

    const entryName = pickFreeEntryName(contextName, claimedClusters, claimedUsers);

    // Safe now: `entryName` is referenced by no other context, so any leftover entry under that
    // name is an orphan and replacing it cannot re-point anyone.
    targetDoc.clusters = targetDoc.clusters.filter((c: any) => c?.name !== entryName);
    targetDoc.users = targetDoc.users.filter((u: any) => u?.name !== entryName);

    targetDoc.clusters.push({ ...sourceCluster, name: entryName });
    targetDoc.users.push({ ...sourceUser, name: entryName });
    targetDoc.contexts.push({
      name: contextName,
      context: {
        cluster: entryName,
        user: entryName,
        ...(sourceContext.context.namespace ? { namespace: sourceContext.context.namespace } : {}),
      },
    });
    if (!targetDoc['current-context']) targetDoc['current-context'] = contextName;

    await writeFileAtomic(targetKubeconfigPath, yaml.dump(targetDoc));
    if (onMerged) await onMerged(contextName);
    return { contextName };
  });
}

/**
 * Pick a name for this import's `clusters`/`users` entries.
 *
 * Prefers the context's own name (so a re-import is stable and the file stays readable), but
 * falls back to a suffixed name when another context already references a cluster or user of
 * that name - otherwise merging would delete that entry and push ours under the same name,
 * silently re-pointing the unrelated context at this account's server and credentials.
 */
function pickFreeEntryName(contextName: string, claimedClusters: Set<string>, claimedUsers: Set<string>): string {
  const isFree = (name: string) => !claimedClusters.has(name) && !claimedUsers.has(name);
  if (isFree(contextName)) return contextName;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = `${contextName}--${randomUUID().slice(0, 8)}`;
    if (isFree(candidate)) return candidate;
  }
  throw new Error(`Could not find a free kubeconfig cluster/user name for context "${contextName}".`);
}
