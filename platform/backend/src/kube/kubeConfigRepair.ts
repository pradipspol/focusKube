import { promises as fs } from 'fs';
import { logWarn } from '../util/logger.js';
import { withFileLock, writeFileAtomic } from '../util/fileLock.js';

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

  // Inject AZURE_CONFIG_DIR into exec provider environment if provided
  if (azureConfigDir) {
    // Replace: env: null  with: env: [{ name: AZURE_CONFIG_DIR, value: <azureConfigDir> }]
    // $1 already starts with \n, so do not add an extra \n before each list item
    loginChanged = loginChanged.replace(
      /(\n(\s*))env:\s*null(\s*\n\s*(?:installHint|command):)/gi,
      `$1env:$1  - name: AZURE_CONFIG_DIR$1    value: ${azureConfigDir.replace(/\\/g, '\\\\')}$3`
    );
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
