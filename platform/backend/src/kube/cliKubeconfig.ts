import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UserSessionState } from '../auth/session.js';
import { azureConfigDirForSource, kubeconfigPathForSource, resolveSessionScope, sessionEnvForSource, type SessionScope } from '../auth/session.js';
import { kube } from './client.js';

export interface CliKubeconfigOptions {
  session: UserSessionState;
  context?: string;
  source?: SessionScope;
  env?: Record<string, string>;
}

export interface PreparedCliKubeconfig {
  env: Record<string, string>;
  context: string;
  kubeconfigPath: string;
  cleanup: () => Promise<void>;
}

export async function prepareCliKubeconfig(options: CliKubeconfigOptions): Promise<PreparedCliKubeconfig> {
  const source = options.source ?? resolveSessionScope(options.session, options.context ?? options.session.activeContext);
  const kubeconfigPath = kubeconfigPathForSource(options.session, source);
  const azureConfigDir = azureConfigDirForSource(options.session, source);
  const context = await kube.resolveContextName(options.context, {
    kubeconfigPath,
    fallbackContext: options.session.activeContext,
  });
  const kubeConfig = await kube.rawConfig(context, {
    kubeconfigPath,
    fallbackContext: options.session.activeContext,
    azureConfigDir,
  });
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'focusKube-cli-'));
  const tempKubeconfigPath = path.join(tempDir, 'config');
  await fsp.writeFile(tempKubeconfigPath, kubeConfig.exportConfig(), { encoding: 'utf8' });

  return {
    env: {
      ...options.env,
      KUBECONFIG: tempKubeconfigPath,
      AZURE_CONFIG_DIR: azureConfigDir,
    },
    context,
    kubeconfigPath: tempKubeconfigPath,
    cleanup: () => fsp.rm(tempDir, { recursive: true, force: true }),
  };
}

export async function withCliKubeconfig<T>(
  options: CliKubeconfigOptions,
  action: (env: Record<string, string>, context: string) => Promise<T>,
): Promise<T> {
  const prepared = await prepareCliKubeconfig(options);
  try {
    return await action(prepared.env, prepared.context);
  } finally {
    await prepared.cleanup();
  }
}

export function sessionEnvForCliSource(req: any, source: SessionScope): Record<string, string> {
  return sessionEnvForSource(req, source);
}