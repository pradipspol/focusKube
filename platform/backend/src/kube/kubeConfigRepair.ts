import { promises as fs } from 'fs';
import yaml from 'js-yaml';
import { logWarn } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';
import { userRequiresAzureAuth } from './execAuthDetection.js';

/**
 * Repair deprecated Azure flags from kubeconfig content (string).
 * Does not modify files, just returns cleaned content.
 * Optionally injects AZURE_CONFIG_DIR into exec provider environment.
 */
export function repairKubeconfigContent(content: string, azureConfigDir?: string): string {
  let modified = content;
  // Only remove flags that are truly deprecated and not needed for authentication
  // Keep: server-id, tenant-id, client-id (these are Azure authentication credentials)
  // Remove: environment, api-server, authority-host (these are config variants)
  const deprecatedFlags = [
    'environment',
    'api-server',
    'authority-host',
  ];

  for (const flag of deprecatedFlags) {
    // Match YAML array items in args:
    //   - '--environment'
    //   - AzurePublicCloud
    // Pattern: - '--flagname' or - "--flagname" (with or without quotes)
    // followed by its value line (- value or - "value")
    const escapedFlag = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `\\n\\s*-\\s+['"]?--${escapedFlag}['"]?\\s*\\n\\s*-\\s+[^\\n]*`,
      'gi'
    );
    
    modified = modified.replace(pattern, '');  // Remove both lines entirely
  }

  // Convert devicecode -> azurecli in login method
  let loginChanged = modified
    .replace(/(\n\s*-\s*['"]--login['"]\s*\n\s*-\s*)devicecode\b/gi, '$1azurecli')
    .replace(/(['"]--login['"]\s*,\s*['"])devicecode(['"])/gi, '$1azurecli$2')
    .replace(/(--login[^\n\r]{0,40})devicecode\b/gi, '$1azurecli')
    .replace(/(\s+-\s+)devicecode\b/g, '$1azurecli');

  // Force every Azure/kubelogin exec user onto this scope's isolated AZURE_CONFIG_DIR, so the
  // actual `kubelogin`/`az` process the k8s client library spawns for API calls picks up the
  // SAME signed-in identity this app already resolved for the scope/account - instead of
  // whatever ~/.azure the exec plugin falls back to when the process env doesn't set it
  // (@kubernetes/client-node's exec auth only merges the kubeconfig's own exec.env, never a
  // caller-supplied env - see exec_auth.js). Done via a structural YAML edit rather than a
  // text regex: a regex tied to one exact key order/format (e.g. requiring a literal
  // `env: null` immediately followed by `command:`) silently no-ops - and therefore leaves
  // the context pointed at the wrong Azure identity - on any kubeconfig whose exec block
  // was written with different key order or already has a stale env array.
  if (azureConfigDir) {
    try {
      const doc = yaml.load(loginChanged) as any;
      let changed = false;
      for (const entry of Array.isArray(doc?.users) ? doc.users : []) {
        const exec = entry?.user?.exec;
        if (!userRequiresAzureAuth(entry?.user)) continue;
        const envList: Array<{ name?: string; value?: string }> = Array.isArray(exec.env) ? exec.env : [];
        const existing = envList.find((e) => e?.name === 'AZURE_CONFIG_DIR');
        if (existing) {
          if (existing.value !== azureConfigDir) {
            existing.value = azureConfigDir;
            changed = true;
          }
        } else {
          envList.push({ name: 'AZURE_CONFIG_DIR', value: azureConfigDir });
          changed = true;
        }
        if (exec.env !== envList) {
          exec.env = envList;
          changed = true;
        }
      }
      if (changed) {
        loginChanged = yaml.dump(doc);
      }
    } catch (err) {
      logWarn('kube.config.azure_config_dir_inject_failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return loginChanged;
}

export async function repairKubeconfig(kubeconfigPath: string, azureConfigDir?: string): Promise<boolean> {
  try {
    // This is a read-modify-write of a file that AKS/EKS imports and context removal also
    // rewrite, and it runs from the auth guard on essentially every request - without the
    // shared lock it is the likeliest thing to clobber a concurrent import.
    return await withFileLock(kubeconfigPath, async () => {
      const content = await fs.readFile(kubeconfigPath, 'utf-8');
      const repairedContent = repairKubeconfigContent(content, azureConfigDir);

      if (repairedContent !== content) {
        await writeFileAtomic(kubeconfigPath, repairedContent);
        logWarn('kube.config.repaired', {
          kubeconfigPath,
          message: 'Kubeconfig repaired: removed deprecated Azure flags, updated auth to azurecli',
        });
        return true;
      }
      return false;
    });
  } catch (err) {
    logWarn('kube.config.repair_failed', {
      kubeconfigPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
