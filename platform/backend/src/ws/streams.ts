import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { PassThrough, Writable } from 'node:stream';
import { URL } from 'node:url';
import * as k8s from '@kubernetes/client-node';
import { kube } from '../kube/client.js';
import { resourceWatchPath, resolveKind, matchesDeploymentSelector } from '../kube/resources.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { describeK8sError } from '../util/k8sError.js';
import { activeSessionAzureConfigDir, activeSessionKubeconfigPath, resolveSessionAuthContext } from '../auth/session.js';
import { resolveAuthFromHeaders } from '../auth/session.js';
import { hasCapability, type Role } from '../auth/rbac.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logError, logInfo, logWarn } from '../util/logger.js';
import { handleTerminal } from './terminal.js';
import { observabilityWss, handleObservabilityUpgrade } from './observability.js';
import { prepareCliKubeconfig, type PreparedCliKubeconfig } from '../kube/cliKubeconfig.js';
import { aiService, type ChatMessage, type ChatMessageContent } from '../services/aiService.js';
import { aiContextService, resolveSessionKubeAccess, resolveSessionHelmAccess, type ClusterContext } from '../services/aiContextService.js';
import {
  toolCatalogForRole,
  isWriteTool,
  requiresDeleteCapability,
  executeReadTool,
  executeWriteTool,
  prepareActionProposal,
  type ToolExecCtx,
} from '../services/aiToolExecutor.js';
import { getLicenseKey } from '../runtime/aiLicenseStore.js';

const logsWss = new WebSocketServer({ noServer: true });
const execWss = new WebSocketServer({ noServer: true });
const portForwardWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
const watchWss = new WebSocketServer({ noServer: true });
const metricsWss = new WebSocketServer({ noServer: true });
const aiWss = new WebSocketServer({ noServer: true });

/** Decide which WS server should handle an HTTP upgrade based on the path. */
export async function routeUpgrade(req: any, socket: any, head: Buffer): Promise<boolean> {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  try {
    const { user, state } = await resolveAuthFromHeaders();
    if (!state || !user) {
      logWarn('ws.auth.failed', {
        pathname,
        userResolved: !!user,
        stateResolved: !!state,
      });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return true;
    }
    req.authUser = user;
    req.userSession = state;
    if (pathname === '/ws/logs') {
      logsWss.handleUpgrade(req, socket, head, (ws) => handleLogs(ws, req));
      return true;
    }
    if (pathname === '/ws/exec') {
      // Exec into a pod is a write-capable action; read-only roles are denied.
      if (!hasCapability(user.role, 'write')) {
        socket.destroy();
        return true;
      }
      execWss.handleUpgrade(req, socket, head, (ws) => handleExec(ws, req));
      return true;
    }
    if (pathname === '/ws/port-forward') {
      // Port-forward changes access to pod/service ports, so keep it on the write path.
      if (!hasCapability(user.role, 'write')) {
        socket.destroy();
        return true;
      }
      portForwardWss.handleUpgrade(req, socket, head, (ws) => handlePortForward(ws, req));
      return true;
    }
    if (pathname === '/ws/terminal') {
      if (!hasCapability(user.role, 'write')) {
        socket.destroy();
        return true;
      }
      terminalWss.handleUpgrade(req, socket, head, (ws) => handleTerminal(ws, req));
      return true;
    }
    if (pathname === '/ws/watch') {
      watchWss.handleUpgrade(req, socket, head, (ws) => handleWatch(ws, req));
      return true;
    }
    if (pathname === '/ws/metrics') {
      metricsWss.handleUpgrade(req, socket, head, (ws) => handleMetrics(ws, req));
      return true;
    }
    if (pathname === '/ws/observability') {
      observabilityWss.handleUpgrade(req, socket, head, (ws) => {
        handleObservabilityUpgrade(ws, req).catch((err) => {
          logError('observability.ws.handler_error', {
            error: err instanceof Error ? err.message : String(err),
          });
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', error: 'Internal server error' }));
            ws.close(1011, 'Handler error');
          }
        });
      });
      return true;
    }
    if (pathname === '/ws/ai') {
      aiWss.handleUpgrade(req, socket, head, (ws) => handleAiChat(ws, req));
      return true;
    }
    socket.destroy();
    return false;
  } catch (err) {
    logError('ws.auth.error', {
      pathname,
      error: err instanceof Error ? err.message : String(err),
    });
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return true;
  }
}

function params(req: any) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  return {
    context: q.get('context') || undefined,
    namespace: q.get('namespace') || 'default',
    pod: q.get('pod') || '',
    container: q.get('container') || undefined,
    deployment: q.get('deployment') || '',
    follow: q.get('follow') !== 'false',
    tailLines: parseInt(q.get('tailLines') || '200', 10),
    command: q.get('command') || '/bin/sh',
    timestamps: q.get('timestamps') === 'true',
  };
}

function watchParams(req: any) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  const resourceVersion = q.get('resourceVersion');
  return {
    context: q.get('context') || undefined,
    namespace: q.get('namespace') || undefined,
    plural: q.get('plural') || '',
    resourceVersion: resourceVersion && resourceVersion.trim().length > 0 ? resourceVersion.trim() : undefined,
  };
}

function portForwardParams(req: any) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  return {
    context: q.get('context') || undefined,
  };
}

function wsWritable(ws: WebSocket): Writable {
  return new Writable({
    write(chunk, _enc, cb) {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk.toString());
      cb();
    },
  });
}

async function handleLogs(ws: WebSocket, req: any) {
  const p = params(req);
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const context = p.context || session.activeContext || undefined;
  const azureConfigDir = await activeSessionAzureConfigDir(session, context);
  if (!p.pod && !p.deployment) {
    ws.send('error: pod or deployment is required');
    ws.close();
    return;
  }
  const { scope, identity } = await resolveSessionAuthContext(session, context);
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      source: scope,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
      identity,
    });
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  let kubeConfig: k8s.KubeConfig;
  try {
    kubeConfig = await kube.rawConfig(context, {
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
    });
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  const log = new k8s.Log(kubeConfig);
  const stream = wsWritable(ws);

  if (p.deployment) {
    await handleDeploymentLogs(ws, log, stream, {
      namespace: p.namespace,
      deployment: p.deployment,
      container: p.container ?? '',
      follow: p.follow,
      tailLines: Number.isFinite(p.tailLines) ? p.tailLines : 200,
      timestamps: p.timestamps,
      context,
      kubeConfig,
    });
    return;
  }

  if (!p.pod) {
    ws.send('error: pod is required');
    ws.close();
    return;
  }

  let aborter: any;
  try {
    aborter = await log.log(p.namespace, p.pod, p.container ?? '', stream, {
      follow: p.follow,
      tailLines: Number.isFinite(p.tailLines) ? p.tailLines : 200,
      pretty: false,
      timestamps: p.timestamps,
    });
  } catch (err) {
    ws.send(`error: ${await describeK8sError(err, { azureConfigDir, context })}`);
    ws.close();
    return;
  }
  ws.on('close', () => abort(aborter));
  ws.on('error', () => abort(aborter));
}

async function handleDeploymentLogs(
  ws: WebSocket,
  log: k8s.Log,
  stream: Writable,
  params: {
    namespace: string;
    deployment: string;
    container: string;
    follow: boolean;
    tailLines: number;
    timestamps: boolean;
    context?: string;
    kubeConfig: k8s.KubeConfig;
  },
) {
  const { namespace, deployment, container, follow, tailLines, timestamps, context, kubeConfig } = params;
  const podsApi = k8s.KubernetesObjectApi.makeApiClient(kubeConfig);
  let deploymentObj: any;
  try {
    deploymentObj = await podsApi.read({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: deployment, namespace } });
  } catch (err) {
    ws.send(`error: ${await describeK8sError(err, { context })}`);
    ws.close();
    return;
  }

  const selector = deploymentObj.body?.spec?.selector?.matchLabels ?? {};
  let podList: any[] = [];
  try {
    const listRes = await podsApi.list('v1', 'Pod', namespace);
    podList = (listRes.body as any)?.items ?? [];
  } catch (err) {
    ws.send(`error: ${await describeK8sError(err, { context })}`);
    ws.close();
    return;
  }
  const matchingPods = podList.filter((pod) => {
    const podLabels = pod.metadata?.labels ?? {};
    return matchesDeploymentSelector(selector, podLabels);
  });

  if (matchingPods.length === 0) {
    ws.send('error: no pods matched this deployment selector');
    ws.close();
    return;
  }

  const aborters: any[] = [];
  try {
    const startedStreams = await Promise.all(
      matchingPods
        .map(async (pod) => {
          const podName = pod.metadata?.name;
          if (!podName) return null;
          const containers = pod.spec?.containers ?? [];
          const hasContainer = !container || containers.some((candidate: any) => candidate?.name === container);
          if (!hasContainer) {
            return null;
          }
          const aborter = await log.log(namespace, podName, container, stream, {
            follow,
            tailLines,
            pretty: false,
            timestamps,
          });
          return aborter;
        }),
    );
    const activeStreams = startedStreams.filter(Boolean) as any[];
    aborters.push(...activeStreams);
  } catch (err) {
    ws.send(`error: ${await describeK8sError(err, { context })}`);
    ws.close();
    return;
  }

  ws.on('close', () => aborters.forEach((aborter) => abort(aborter)));
  ws.on('error', () => aborters.forEach((aborter) => abort(aborter)));
}

async function handleExec(ws: WebSocket, req: any) {
  const p = params(req);
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const context = p.context || session.activeContext || undefined;
  const azureConfigDir = await activeSessionAzureConfigDir(session, context);
  if (!p.pod) {
    ws.send('error: pod is required');
    ws.close();
    return;
  }
  const { scope, identity } = await resolveSessionAuthContext(session, context);
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      source: scope,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
      identity,
    });
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  let exec: k8s.Exec;
  try {
    exec = new k8s.Exec(
      await kube.rawConfig(context, {
        kubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir,
      }),
    );
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  const stdin = new PassThrough();
  const stdout = wsWritable(ws);
  const stderr = wsWritable(ws);

  let k8sSocket: WebSocket | undefined;
  try {
    k8sSocket = (await exec.exec(
      p.namespace,
      p.pod,
      p.container ?? '',
      p.command,
      stdout,
      stderr,
      stdin,
      true,
      (status) => {
        if (status.status === 'Failure') {
          ws.send(`\r\n[exec failed: ${status.message ?? 'unknown error'}]\r\n`);
        }
      },
    )) as unknown as WebSocket;
  } catch (err) {
    ws.send(`error: ${await describeK8sError(err, { azureConfigDir, context })}`);
    ws.close();
    return;
  }

  ws.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString() : data.toString();
    // Control messages (terminal resize) arrive as JSON.
    if (text.startsWith('{')) {
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'resize' && k8sSocket && k8sSocket.readyState === WebSocket.OPEN) {
          // Channel 4 = resize stream in the k8s exec protocol.
          const payload = JSON.stringify({ Width: msg.cols, Height: msg.rows });
          k8sSocket.send(Buffer.concat([Buffer.from([4]), Buffer.from(payload)]));
          return;
        }
      } catch {
        /* not a control message, treat as input */
      }
    }
    stdin.write(text);
  });

  const cleanup = () => {
    stdin.end();
    try {
      k8sSocket?.close();
    } catch {
      /* ignore */
    }
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

async function handlePortForward(ws: WebSocket, req: any) {
  const p = portForwardParams(req);
  const session = req.userSession;
  const context = p.context || session.activeContext || undefined;
  let child: ChildProcess | undefined;
  let kubectlExecutablePath: string | undefined;
  let cliKubeconfig: PreparedCliKubeconfig | undefined;
  const resolvedAzureConfigDir = await activeSessionAzureConfigDir(session, context);
  const resolvedKubeconfigPath = activeSessionKubeconfigPath(session);
  const azureConfigDir = resolvedAzureConfigDir ?? undefined;
  const kubeconfigPath = resolvedKubeconfigPath ?? null;

  const send = (payload: Record<string, unknown>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const cleanup = () => {
    try {
      child?.kill();
    } catch {
      /* ignore */
    }
    void cliKubeconfig?.cleanup();
    cliKubeconfig = undefined;
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  ws.on('message', async (data, isBinary) => {
    const text = isBinary ? data.toString() : data.toString();
    if (!text.startsWith('{')) return;

    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.type === 'stop') {
      cleanup();
      return;
    }

    if (msg.type !== 'start' || child) return;

    const namespace = String(msg.namespace ?? '').trim();
    const targetKind = String(msg.targetKind ?? '').trim();
    const targetName = String(msg.targetName ?? '').trim();
    const targetPort = String(msg.targetPort ?? '').trim();
    const localPort = String(msg.localPort ?? '').trim();

    if (!targetKind || !targetName || !targetPort) {
      send({ type: 'ERROR', message: 'targetKind, targetName, and targetPort are required' });
      ws.close();
      return;
    }
    const { scope, identity: portForwardIdentity } = await resolveSessionAuthContext(session, context);
    try {
      await ensureContextAuthReady({
        context,
        kubeconfigPath: resolvedKubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir: resolvedAzureConfigDir,
        source: scope,
        userId: req.authUser?.id,
        azureLogin: session.azureLogin,
        identity: portForwardIdentity,
      });
    } catch (err) {
      send({ type: 'ERROR', message: (err as Error).message });
      ws.close();
      return;
    }

    let execConfig: k8s.KubeConfig;
    try {
      execConfig = await kube.rawConfig(context, {
        kubeconfigPath: resolvedKubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir: resolvedAzureConfigDir,
      });
    } catch (err) {
      send({ type: 'ERROR', message: (err as Error).message });
      ws.close();
      return;
    }

    const kubectlArgs = [
      '--context',
      execConfig.getCurrentContext() ?? context ?? session.activeContext ?? '',
      'port-forward',
      ...(namespace ? ['--namespace', namespace] : []),
      '--address',
      '127.0.0.1',
      `${targetKind}/${targetName}`,
      localPort ? `${localPort}:${targetPort}` : targetPort,
    ];

    send({ type: 'STARTING', namespace, targetKind, targetName, targetPort, localPort: localPort || undefined });

    try {
      cliKubeconfig = await prepareCliKubeconfig({
        session,
        context,
        env: {
          KUBECONFIG: resolvedKubeconfigPath ?? process.env.KUBECONFIG ?? '',
          ...(azureConfigDir ? { AZURE_CONFIG_DIR: azureConfigDir } : {}),
        },
      });
      const result = await spawnKubectl(kubectlArgs, cliKubeconfig.env);
      child = result.child;
      kubectlExecutablePath = result.executablePath;
    } catch (err) {
      await cliKubeconfig?.cleanup();
      cliKubeconfig = undefined;
      send({ type: 'ERROR', message: (err as Error).message });
      ws.close();
      return;
    }

    let stdoutBuffer = '';
    let stderrBuffer = '';
    let ready = false;

    const emitLines = (buffer: string, stream: 'stdout' | 'stderr') => {
      const parts = buffer.split(/\r?\n/);
      const trailing = parts.pop() ?? '';
      for (const line of parts) {
        if (!line) continue;
        send({ type: 'OUTPUT', stream, text: line });
        const match = line.match(/^Forwarding from (?:127\.0\.0\.1|localhost|::1):(\d+) -> (.+)$/);
        if (match && !ready) {
          ready = true;
          send({
            type: 'READY',
            localPort: Number(match[1]),
            target: match[2],
          });
        }
      }
      return trailing;
    };

    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      stdoutBuffer = emitLines(stdoutBuffer, 'stdout');
    });

    child.stderr?.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
      stderrBuffer = emitLines(stderrBuffer, 'stderr');
    });

    child.on('error', (err) => {
      logCommandOutcome('error', 'kubectl.port_forward.exec.error', 'failed', 'kubectl', kubectlArgs, {
        executablePath: kubectlExecutablePath,
        kubeconfigPath,
        azureConfigDir: azureConfigDir ?? null,
        identity: portForwardIdentity,
        error: err.message,
      }, commandReason(err));
      send({ type: 'ERROR', message: err.message });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    child.on('close', (code) => {
      const exitCode = code ?? -1;
      if (exitCode === 0) {
        logCommandOutcome('info', 'kubectl.port_forward.exec.finish', 'success', 'kubectl', kubectlArgs, {
          executablePath: kubectlExecutablePath,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          identity: portForwardIdentity,
          code: exitCode,
          namespace: namespace || null,
          targetKind,
          targetName,
          targetPort,
          localPort: localPort || null,
          commandLine: commandLine('kubectl', kubectlArgs),
        }, 'port-forward exited cleanly');
      } else {
        const reason = (stderrBuffer || stdoutBuffer || `exit code ${exitCode}`).trim();
        logCommandOutcome('error', 'kubectl.port_forward.exec.finish', 'failed', 'kubectl', kubectlArgs, {
          executablePath: kubectlExecutablePath,
          kubeconfigPath,
          azureConfigDir: azureConfigDir ?? null,
          identity: portForwardIdentity,
          code: exitCode,
          namespace: namespace || null,
          targetKind,
          targetName,
          targetPort,
          localPort: localPort || null,
          commandLine: commandLine('kubectl', kubectlArgs),
        }, `exit code ${exitCode}${reason ? ` - ${reason.slice(-400)}` : ''}`);
      }
      if (stdoutBuffer.trim()) send({ type: 'OUTPUT', stream: 'stdout', text: stdoutBuffer.trimEnd() });
      if (stderrBuffer.trim()) send({ type: 'OUTPUT', stream: 'stderr', text: stderrBuffer.trimEnd() });
      send({ type: 'STOPPED', code: exitCode });
      void cliKubeconfig?.cleanup();
      cliKubeconfig = undefined;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });
}

async function spawnKubectl(args: string[], env: Record<string, string>): Promise<{ child: ChildProcess; executablePath: string }> {
  const candidates = process.platform === 'win32' ? ['kubectl.exe', 'kubectl'] : ['kubectl'];
  const azureConfigDir = env.AZURE_CONFIG_DIR ?? undefined;
  const kubeconfigPath = env.KUBECONFIG ?? null;

  for (const cmd of candidates) {
    logInfo('kubectl.port_forward.exec.start', {
      cmd,
      executablePath: cmd,
      resolvedExecutablePath: cmd,
      kubeconfigPath,
      azureConfigDir: azureConfigDir ?? null,
      args,
      candidateCommands: candidates,
      commandLine: commandLine(cmd, args),
      platform: process.platform,
    });

    const child = spawn(cmd, args, {
      env: {
        ...process.env,
        ...env,
      },
      shell: false,
      windowsHide: true,
    });

    const outcome = await new Promise<{ child?: ChildProcess; error?: NodeJS.ErrnoException }>((resolve) => {
      const onError = (error: NodeJS.ErrnoException) => {
        child.off('spawn', onSpawn);
        resolve({ error });
      };
      const onSpawn = () => {
        child.off('error', onError);
        resolve({ child });
      };
      child.once('error', onError);
      child.once('spawn', onSpawn);
    });

    if (outcome.child) return { child: outcome.child, executablePath: cmd };
    logWarn('kubectl.port_forward.exec.spawn_fallback', {
      cmd,
      executablePath: cmd,
      resolvedExecutablePath: cmd,
      kubeconfigPath,
      azureConfigDir: azureConfigDir ?? null,
      candidateCommands: candidates,
      code: outcome.error?.code ?? null,
    });
    if (outcome.error?.code !== 'ENOENT' && outcome.error?.code !== 'EINVAL') {
      throw outcome.error;
    }
  }

  logError('kubectl.port_forward.exec.not_found', {
    cmd: candidates[0] ?? 'kubectl',
    executablePath: candidates[0] ?? 'kubectl',
    resolvedExecutablePath: candidates[0] ?? 'kubectl',
    kubeconfigPath,
    azureConfigDir: azureConfigDir ?? null,
    candidateCommands: candidates,
  });
  throw new Error('kubectl executable not found on the backend host');
}

async function handleWatch(ws: WebSocket, req: any) {
  const p = watchParams(req);
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const context = p.context || session.activeContext || undefined;
  const azureConfigDir = await activeSessionAzureConfigDir(session, context);
  if (!p.plural) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'plural is required' }));
    ws.close();
    return;
  }

  try {
    resolveKind(p.plural);
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
    ws.close();
    return;
  }

  const { scope, identity } = await resolveSessionAuthContext(session, context);
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      source: scope,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
      identity,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
    ws.close();
    return;
  }
  let watch: k8s.Watch;
  try {
    watch = new k8s.Watch(
      await kube.rawConfig(context, {
        kubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir,
      }),
    );
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
    ws.close();
    return;
  }
  const path = resourceWatchPath(p.plural, p.namespace);
  const query: Record<string, string | number | boolean> = {
    allowWatchBookmarks: true,
    timeoutSeconds: 300,
  };
  if (p.resourceVersion) {
    query.resourceVersion = p.resourceVersion;
  }
  let request: any;
  let closed = false;

  const cleanup = () => {
    closed = true;
    abort(request);
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  try {
    request = await watch.watch(
      path,
      query,
      (phase: string, obj: any) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
          type: phase,
          object: obj,
        }));
      },
      async (err: any) => {
        if (closed) return;
        const statusCode = Number(err?.statusCode ?? err?.response?.statusCode ?? err?.code ?? 0);
        if (statusCode === 410 && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'RESET',
              code: 'RESOURCE_VERSION_EXPIRED',
              message: 'Watch resourceVersion expired; reconnecting with a fresh watch state.',
            }),
          );
        }
        if (err && ws.readyState === WebSocket.OPEN) {
          const message = await describeK8sError(err, { azureConfigDir, context });
          ws.send(JSON.stringify({ type: 'ERROR', message, status: statusCode || undefined }));
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    );
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: await describeK8sError(err, { azureConfigDir, context }) }));
    ws.close();
  }
}

function abort(aborter: any) {
  try {
    if (!aborter) return;
    if (typeof aborter.abort === 'function') aborter.abort();
    else if (typeof aborter.destroy === 'function') aborter.destroy();
  } catch {
    /* ignore */
  }
}

function metricsParams(req: any) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  return {
    context: q.get('context') || undefined,
    namespace: q.get('namespace') || 'default',
    pod: q.get('pod') || '',
  };
}

async function handleMetrics(ws: WebSocket, req: any) {
  const p = metricsParams(req);
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const context = p.context || session.activeContext || undefined;
  const azureConfigDir = await activeSessionAzureConfigDir(session, context);

  if (!p.pod) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'pod query parameter is required' }));
    ws.close();
    return;
  }

  const { scope, identity } = await resolveSessionAuthContext(session, context);
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      source: scope,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
      identity,
    });
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
    ws.close();
    return;
  }

  let closed = false;
  let intervalId: NodeJS.Timeout | null = null;

  const cleanup = () => {
    closed = true;
    if (intervalId) clearInterval(intervalId);
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);

  const fetchMetrics = async () => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    try {
      const api = (await kube.rawConfig(context, { kubeconfigPath, fallbackContext: session.activeContext, azureConfigDir })).makeApiClient(k8s.CustomObjectsApi);
      const metricsRes = await (async () => {
        try {
          return await api.getNamespacedCustomObject('metrics.k8s.io', 'v1beta1', p.namespace, 'pods', p.pod);
        } catch (err: any) {
          if (err.statusCode === 404 || err.statusCode === 401) throw err;
          return undefined;
        }
      })();

      if (!metricsRes) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to fetch pod metrics' }));
        return;
      }

      const body: any = (metricsRes as any).body ?? metricsRes;
      const containers = Array.isArray(body.containers) ? body.containers : [];

      ws.send(JSON.stringify({
        type: 'METRICS',
        timestamp: body.timestamp,
        window: body.window,
        containers: containers.map((container: any) => ({
          name: container.name,
          cpu: container.usage?.cpu ?? '0',
          memory: container.usage?.memory ?? '0',
          cpuMillicores: cpuToMillicores(container.usage?.cpu ?? '0'),
          memoryBytes: memoryToBytes(container.usage?.memory ?? '0'),
        })),
      }));
    } catch (err) {
      if (!closed && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ERROR', message: await describeK8sError(err, { azureConfigDir, context }) }));
      }
    }
  };

  // Fetch metrics immediately on connect
  await fetchMetrics();

  // Then poll every 5 seconds
  if (!closed && ws.readyState === WebSocket.OPEN) {
    intervalId = setInterval(fetchMetrics, 5000);
  }
}

function aiChatParams(req: any) {
  const url = new URL(req.url, 'http://localhost');
  const q = url.searchParams;
  return {
    context: q.get('context') || undefined,
  };
}

// Bounds one user message's automatic read-tool loop (each round-trip is a real, billed relay
// call) — protects against a degenerate back-and-forth, e.g. a read tool whose own output
// prompts the model to call it again. Deliberately NOT shared across an action_decision's
// resumption: a write-tool round only ever continues after a human clicks Approve/Reject,
// which is its own natural rate limit.
const MAX_TOOL_ROUNDS = 6;

/** One relay round-trip's `tool_use` blocks — Claude can (and does) request several tools in
 * parallel within a single turn, e.g. reading two pods' logs at once. The Anthropic API
 * requires every tool_use block from one assistant turn to be answered by a tool_result in
 * the SAME following user turn, all at once — so when a round mixes read and write calls, the
 * read calls' results are computed immediately but held here until every write call in the
 * same round has been decided, and only then combined into one tool_result message. */
interface PendingRound {
  turnContext: ClusterContext;
  toolCtx: ToolExecCtx;
  /** tool_use ids from this round, in the order Claude emitted them — preserved so the
   * combined tool_result message lines up positionally with the assistant's own turn. */
  order: string[];
  results: Map<string, { content: string; is_error: boolean }>;
  /** Write-tool ids from this round not yet decided. Empty means the round is ready to close. */
  awaiting: Set<string>;
}

interface PendingAction {
  name: string;
  input: unknown;
  roundId: string;
}

async function handleAiChat(ws: WebSocket, req: any): Promise<void> {
  const session = req.userSession;
  if (!session) {
    ws.send(JSON.stringify({ type: 'error', message: 'No session' }));
    ws.close();
    return;
  }

  const requestedContext = aiChatParams(req).context;
  const role = (req.authUser?.role as Role | undefined) ?? undefined;
  // RBAC-filtered before Claude ever sees the catalog — a viewer/read-only session's model
  // must never be offered scale/restart/apply/delete as callable tools in the first place.
  const tools = toolCatalogForRole(role);

  const licenseKey = await getLicenseKey();
  if (!licenseKey) {
    ws.send(JSON.stringify({ type: 'error', message: 'AI feature not enabled' }));
    ws.close();
    return;
  }

  try {
    // Listen for messages from the client. All of `messages`/`pendingActions`/`pendingRounds`
    // live only for the lifetime of this one connection — there is no server-side conversation
    // store, so an unanswered proposal simply never executes if the socket closes first.
    const messages: ChatMessage[] = [];
    const pendingActions = new Map<string, PendingAction>();
    const pendingRounds = new Map<string, PendingRound>();
    let roundCounter = 0;
    // Tool names the user has approved with "Allow for this session" — scoped to this one
    // connection only (never persisted), same lifetime as `messages`/`pendingActions` above.
    // A tool in this set skips the approval card entirely and executes like a read tool.
    const sessionAutoApprovedTools = new Set<string>();
    // client turnId -> messages.length right before that turn's user content was pushed —
    // lets `edit_message` rewind `messages` back to right before a past turn and replay it with
    // different (or, for "regenerate", identical) text. Entries for turns made unreachable by a
    // later edit are dropped as part of that edit (see the `edit_message` handler below).
    const checkpoints = new Map<string, number>();
    // The AbortController for whichever relay round-trip is currently streaming, if any — `stop`
    // aborts it directly rather than going through `enqueue`, since the queued turn is exactly
    // what's being interrupted and would otherwise never get a chance to run.
    let currentRelayAbort: AbortController | null = null;

    // Serializes everything that mutates `messages`/`pendingActions` or talks to the relay, so
    // an action_decision and a fresh user_message on the same socket can't interleave mid-turn.
    let turnQueue: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>): void => {
      turnQueue = turnQueue.then(fn).catch((err) => {
        logError('ai_chat.turn_error', { error: err instanceof Error ? err.message : String(err) });
        ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' }));
      });
    };

    // Once every write call in a round has been decided, combine all of that round's tool
    // results (reads computed immediately, writes filled in as decisions arrive) into one
    // user turn, in original order, and resume the relay round-trip loop.
    const finishRoundIfReady = async (roundId: string): Promise<void> => {
      const round = pendingRounds.get(roundId);
      if (!round || round.awaiting.size > 0) return;
      pendingRounds.delete(roundId);
      const content: ChatMessageContent = round.order.map((id) => {
        const r = round.results.get(id)!;
        return { type: 'tool_result' as const, tool_use_id: id, content: r.content, is_error: r.is_error };
      });
      messages.push({ role: 'user', content });
      await runTurn(round.turnContext, round.toolCtx);
    };

    // Runs (and, for read-only rounds, loops) one or more relay round-trips until the
    // assistant's turn either truly ends or pauses on one or more write-tool proposals.
    const runTurn = async (turnContext: ClusterContext, toolCtx: ToolExecCtx | null): Promise<void> => {
      // Set once we've already nudged this turn (below) — bounds it to a single retry so a
      // model that keeps coming back empty can't loop forever instead of ending the turn.
      let nudgedForExplanation = false;
      for (let round = 0; ; round++) {
        if (round >= MAX_TOOL_ROUNDS) {
          ws.send(JSON.stringify({ type: 'error', message: 'Too many tool calls in one turn — try rephrasing.' }));
          return;
        }

        let assistantText = '';
        // Claude can request several tools in one turn (e.g. two get_logs calls at once) —
        // every tool_use block emitted this round-trip is collected, not just the last.
        const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
        let sawError = false;
        let stopped = false;

        const abortController = new AbortController();
        currentRelayAbort = abortController;
        try {
          await aiService.sendChatToRelay(
            turnContext,
            messages,
            tools,
            (chunk) => {
              if (chunk.type === 'token') {
                assistantText += chunk.data.token || '';
                ws.send(JSON.stringify({ type: 'token', token: chunk.data.token }));
              } else if (chunk.type === 'tool_use') {
                toolUses.push({ id: chunk.data.id, name: chunk.data.name, input: chunk.data.input });
              } else if (chunk.type === 'stopped') {
                stopped = true;
                ws.send(JSON.stringify({ type: 'stopped' }));
              } else if (chunk.type === 'error') {
                sawError = true;
                ws.send(JSON.stringify({ type: 'error', message: chunk.data.message }));
              }
              // 'stop' needs no handling here — the branches below react once sendChatToRelay's
              // await resolves, based on whether any tool_use showed up this round-trip.
            },
            abortController.signal,
          );
        } finally {
          currentRelayAbort = null;
        }

        if (sawError) return;

        if (stopped) {
          // Whatever text streamed before the abort stands as the assistant's turn — no further
          // tool_use processing (any that were mid-flight are simply dropped), and the turn ends
          // cleanly rather than looping for another round.
          messages.push({ role: 'assistant', content: assistantText });
          return;
        }

        if (toolUses.length === 0) {
          // The model used at least one tool this turn (the immediately-preceding message is
          // that round's tool_result batch) but came back with no text of its own — despite the
          // system prompt's explicit instruction not to, this is a real, observed failure mode
          // of the configured model: it treats the raw tool output as a self-explanatory answer
          // and stops. Rather than let that raw output stand as the whole reply, nudge it once,
          // in-band (appended to the same tool-result turn — see toOpenAiMessages' handling of a
          // trailing text block, which is what actually delivers this to the Azure OpenAI path).
          const lastMessage = messages[messages.length - 1];
          if (
            !assistantText.trim() &&
            !nudgedForExplanation &&
            lastMessage &&
            lastMessage.role === 'user' &&
            Array.isArray(lastMessage.content) &&
            lastMessage.content.some((block) => block.type === 'tool_result')
          ) {
            nudgedForExplanation = true;
            lastMessage.content = [
              ...lastMessage.content,
              {
                type: 'text',
                text: 'Explain what those results mean for my question, in your own words, citing the specific evidence — do not end your turn on the tool call alone.',
              },
            ];
            continue;
          }
          // A plain text turn, truly done.
          messages.push({ role: 'assistant', content: assistantText });
          ws.send(JSON.stringify({ type: 'stop' }));
          return;
        }

        const assistantContent: ChatMessageContent = [
          ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
          ...toolUses.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input })),
        ];
        messages.push({ role: 'assistant', content: assistantContent });

        if (!toolCtx) {
          // The tool catalog is only offered once cluster access resolves, so this shouldn't
          // normally happen — guard anyway rather than leaving the turn stuck.
          const content: ChatMessageContent = toolUses.map((t) => {
            const output = 'Cluster is not currently reachable — cannot run this tool.';
            ws.send(JSON.stringify({ type: 'tool_result', id: t.id, name: t.name, output, isError: true }));
            return { type: 'tool_result' as const, tool_use_id: t.id, content: output, is_error: true };
          });
          messages.push({ role: 'user', content });
          continue;
        }

        const roundId = `round-${++roundCounter}`;
        const thisRound: PendingRound = {
          turnContext,
          toolCtx,
          order: toolUses.map((t) => t.id),
          results: new Map(),
          awaiting: new Set(),
        };

        for (const t of toolUses) {
          if (isWriteTool(t.name)) {
            // The before/after diff is a read-only lookup either way, so fetch it up front
            // regardless of whether this call ends up auto-approved or shown as a card.
            const proposal = await prepareActionProposal(t.name, t.input, toolCtx);
            if (sessionAutoApprovedTools.has(t.name)) {
              // Already allowed for this session — run it now, same as a read tool, but still
              // surface it as a resolved (not pending) action card so the diff/outcome is visible.
              const result = await executeWriteTool(t.name, t.input, toolCtx);
              const status: 'approved' | 'failed' = result.isError ? 'failed' : 'approved';
              logInfo('ai_chat.action_decided', { userId: req.authUser?.id, tool: t.name, approved: true, remembered: true, status });
              ws.send(JSON.stringify({
                type: 'action_auto',
                id: t.id,
                name: t.name,
                input: t.input,
                summary: proposal.summary,
                diff: proposal.diff,
                status,
                output: result.output,
              }));
              thisRound.results.set(t.id, { content: result.output, is_error: result.isError });
            } else {
              thisRound.awaiting.add(t.id);
              pendingActions.set(t.id, { name: t.name, input: t.input, roundId });
              ws.send(JSON.stringify({
                type: 'action_proposed',
                id: t.id,
                name: t.name,
                input: t.input,
                summary: proposal.summary,
                diff: proposal.diff,
              }));
            }
          } else {
            ws.send(JSON.stringify({ type: 'tool_call', id: t.id, name: t.name, input: t.input }));
            const result = await executeReadTool(t.name, t.input, toolCtx);
            ws.send(JSON.stringify({ type: 'tool_result', id: t.id, name: t.name, output: result.output, isError: result.isError }));
            thisRound.results.set(t.id, { content: result.output, is_error: result.isError });
          }
        }

        if (thisRound.awaiting.size === 0) {
          // Every tool_use this round was a read tool — combine now and keep looping.
          const content: ChatMessageContent = thisRound.order.map((id) => {
            const r = thisRound.results.get(id)!;
            return { type: 'tool_result' as const, tool_use_id: id, content: r.content, is_error: r.is_error };
          });
          messages.push({ role: 'user', content });
          continue;
        }

        // At least one write call is pending approval — pause. Resumes via
        // finishRoundIfReady, from the action_decision branch below, once every write call in
        // this round (there may be more than one) has been decided.
        pendingRounds.set(roundId, thisRound);
        return;
      }
    };

    // Shared by a fresh `user_message` and an `edit_message` replay — the only difference
    // between them is whether `messages`/`checkpoints` got truncated first (see the
    // `edit_message` handler below).
    const runUserTurn = async (text: string, turnId: unknown, focusedResourceRaw: unknown): Promise<void> => {
      if (pendingActions.size > 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'Resolve the pending action proposal before sending another message.' }));
        return;
      }

      if (typeof turnId === 'string' && turnId) {
        checkpoints.set(turnId, messages.length);
      }
      messages.push({ role: 'user', content: text });

      // Reassemble context each turn so it reflects whatever resource the
      // user currently has focused, not just what was open when the socket connected.
      const focusedResource =
        focusedResourceRaw && typeof focusedResourceRaw === 'object'
          ? {
              kind: String((focusedResourceRaw as any).kind ?? ''),
              namespace: String((focusedResourceRaw as any).namespace ?? ''),
              name: String((focusedResourceRaw as any).name ?? ''),
            }
          : undefined;
      const context = requestedContext || session.activeContext || 'default';
      // Resolved once and reused for both the context-assembly and tool-execution paths —
      // each resolution is real I/O (kubeconfig repair, Azure token-cache warm-up, and for
      // Helm, its own scope/auth resolution). Independent of each other, so resolved in
      // parallel rather than one after the other.
      const [kubeOptions, helmCtx] = await Promise.all([
        resolveSessionKubeAccess(session, context),
        resolveSessionHelmAccess(session, context),
      ]);
      const turnContext = await aiContextService.assembleContext(session, focusedResource, requestedContext, kubeOptions);
      const toolCtx: ToolExecCtx | null = kubeOptions && role ? { context, kubeOptions, role, helm: helmCtx } : null;

      await runTurn(turnContext, toolCtx);
    };

    ws.on('message', (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' }));
        return;
      }

      if (msg.type === 'user_message') {
        enqueue(() => runUserTurn(msg.text, msg.turnId, msg.focusedResource));
        return;
      }

      if (msg.type === 'edit_message') {
        enqueue(async () => {
          if (pendingActions.size > 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'Resolve the pending action proposal before editing a message.' }));
            return;
          }
          const turnId = String(msg.turnId ?? '');
          const checkpoint = checkpoints.get(turnId);
          // A missing checkpoint means this turn predates the current socket (e.g. the
          // connection dropped/reopened, or the backend restarted, since either wipes this
          // in-memory map) — the exact history rewind is no longer possible, but the user still
          // asked a question and still expects an answer, so fall back to appending it as a
          // fresh turn instead of erroring out with nothing to show for the edit.
          if (checkpoint !== undefined) {
            // Drop everything this turn (and any later one) produced, including checkpoints for
            // turns that no longer exist once we rewind past them.
            messages.length = checkpoint;
            for (const [id, idx] of checkpoints) {
              if (idx >= checkpoint) checkpoints.delete(id);
            }
          }
          await runUserTurn(msg.text, turnId, msg.focusedResource);
        });
        return;
      }

      if (msg.type === 'stop') {
        // Deliberately NOT enqueued — the queued turn is exactly what this is meant to
        // interrupt, so waiting for it to reach the front of `turnQueue` would defeat the
        // point. A no-op if nothing is currently streaming.
        currentRelayAbort?.abort();
        return;
      }

      if (msg.type === 'action_decision') {
        enqueue(async () => {
          const id = String(msg.id ?? '');
          const pending = pendingActions.get(id);
          const round = pending ? pendingRounds.get(pending.roundId) : undefined;
          if (!pending || !round) {
            ws.send(JSON.stringify({ type: 'error', message: 'This proposal is no longer active.' }));
            return;
          }
          pendingActions.delete(id);

          const approved = !!msg.approved;
          const remember = approved && !!msg.remember;
          let output: string;
          let isError = false;
          let status: 'approved' | 'rejected' | 'failed';

          if (!approved) {
            output = 'User rejected this action.';
            status = 'rejected';
          } else if (!hasCapability(role, 'write') || (requiresDeleteCapability(pending.name) && !hasCapability(role, 'delete'))) {
            // Re-checked here, not just at catalog-build time — a long-lived socket can
            // outlive a role change between the proposal and the click.
            output = 'Your role no longer permits this action.';
            isError = true;
            status = 'failed';
          } else {
            // Recorded before executing, not after — "allow for this session" is a standing
            // choice about this tool going forward, not conditional on this one call succeeding.
            if (remember) sessionAutoApprovedTools.add(pending.name);
            const result = await executeWriteTool(pending.name, pending.input, round.toolCtx);
            output = result.output;
            isError = result.isError;
            status = result.isError ? 'failed' : 'approved';
          }

          logInfo('ai_chat.action_decided', {
            userId: req.authUser?.id,
            tool: pending.name,
            approved,
            remembered: remember,
            status,
          });

          ws.send(JSON.stringify({ type: 'action_result', id, status, output }));
          round.results.set(id, { content: output, is_error: isError });
          round.awaiting.delete(id);

          await finishRoundIfReady(pending.roundId);
        });
        return;
      }
    });

    ws.on('error', (err) => {
      logError('ai_chat.ws_error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } catch (err) {
    logError('ai_chat.handler_error', {
      error: err instanceof Error ? err.message : String(err),
    });
    ws.send(JSON.stringify({
      type: 'error',
      message: err instanceof Error ? err.message : 'Unknown error',
    }));
    ws.close();
  }
}

function cpuToMillicores(value: string): number {
  if (!value) return 0;
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1_000_000;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1_000;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
}

function memoryToBytes(value: string): number {
  if (!value) return 0;
  const match = /^([0-9.]+)([KMGTE]i|[kMGTPE]|m)?$/.exec(value);
  if (!match) return Number(value) || 0;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const factors: Record<string, number> = {
    '': 1,
    k: 1_000,
    M: 1_000_000,
    G: 1_000_000_000,
    T: 1_000_000_000_000,
    P: 1_000_000_000_000_000,
    E: 1_000_000_000_000_000_000,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
    m: 0.001,
  };
  return amount * (factors[unit] ?? 1);
}
