import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Remove the named contexts (and any clusters/users they exclusively reference)
 * from a kubeconfig file on disk, fixing `current-context` if it pointed at one
 * of them. Returns true if anything was removed. Safe to call when the file is
 * missing/empty or none of the names are present (returns false).
 */
export async function removeContextsFromKubeconfigFile(kubeconfigPath: string, names: Set<string>): Promise<boolean> {
  if (names.size === 0) return false;
  let doc: any;
  try {
    doc = yaml.load(await fsp.readFile(kubeconfigPath, 'utf8'));
  } catch {
    return false;
  }
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

  await fsp.writeFile(kubeconfigPath, yaml.dump(doc), { encoding: 'utf8' });
  return true;
}
