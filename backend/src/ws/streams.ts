import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { PassThrough, Writable } from 'node:stream';
import { URL } from 'node:url';
import * as k8s from '@kubernetes/client-node';
import { kube } from '../kube/client.js';
import { resourceWatchPath, resolveKind } from '../kube/resources.js';
import { ensureContextAuthReady } from '../kube/authGuard.js';
import { activeSessionAzureConfigDir, activeSessionKubeconfigPath } from '../auth/session.js';
import { resolveAuthFromHeaders } from '../auth/session.js';
import { hasCapability } from '../auth/rbac.js';
import { commandLine, commandReason, logCommandOutcome } from '../util/commandLog.js';
import { logError, logInfo, logWarn } from '../util/logger.js';
import { handleTerminal } from './terminal.js';
import { observabilityWss, handleObservabilityUpgrade } from './observability.js';

const logsWss = new WebSocketServer({ noServer: true });
const execWss = new WebSocketServer({ noServer: true });
const portForwardWss = new WebSocketServer({ noServer: true });
const terminalWss = new WebSocketServer({ noServer: true });
const watchWss = new WebSocketServer({ noServer: true });
const metricsWss = new WebSocketServer({ noServer: true });

/** Decide which WS server should handle an HTTP upgrade based on the path. */
export async function routeUpgrade(req: any, socket: any, head: Buffer): Promise<boolean> {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  const upgradeHeaders = {
    ...req.headers,
    'x-focusKube-email': url.searchParams.get('email') ?? undefined,
  };

  try {
    const { user, state } = await resolveAuthFromHeaders(upgradeHeaders);
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
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const context = p.context || session.activeContext || undefined;
  if (!p.pod) {
    ws.send('error: pod is required');
    ws.close();
    return;
  }
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
    });
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  let log: k8s.Log;
  try {
    log = new k8s.Log(
      await kube.rawConfig(context, {
        kubeconfigPath,
        fallbackContext: session.activeContext,
      }),
    );
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  const stream = wsWritable(ws);
  let aborter: any;
  try {
    aborter = await log.log(p.namespace, p.pod, p.container ?? '', stream, {
      follow: p.follow,
      tailLines: Number.isFinite(p.tailLines) ? p.tailLines : 200,
      pretty: false,
      timestamps: p.timestamps,
    });
  } catch (err) {
    ws.send(`error: ${(err as Error).message}`);
    ws.close();
    return;
  }
  ws.on('close', () => abort(aborter));
  ws.on('error', () => abort(aborter));
}

async function handleExec(ws: WebSocket, req: any) {
  const p = params(req);
  const session = req.userSession;
  const kubeconfigPath = activeSessionKubeconfigPath(session);
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const context = p.context || session.activeContext || undefined;
  if (!p.pod) {
    ws.send('error: pod is required');
    ws.close();
    return;
  }
  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
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
    ws.send(`error: ${(err as Error).message}`);
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
  const resolvedAzureConfigDir = activeSessionAzureConfigDir(session);
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
    try {
      await ensureContextAuthReady({
        context,
        kubeconfigPath: resolvedKubeconfigPath,
        fallbackContext: session.activeContext,
        azureConfigDir: resolvedAzureConfigDir,
        userId: req.authUser?.id,
        azureLogin: session.azureLogin,
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
      const result = await spawnKubectl(kubectlArgs, session);
      child = result.child;
      kubectlExecutablePath = result.executablePath;
    } catch (err) {
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
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });
}

async function spawnKubectl(args: string[], session: any): Promise<{ child: ChildProcess; executablePath: string }> {
  const candidates = process.platform === 'win32' ? ['kubectl.exe', 'kubectl'] : ['kubectl'];
  const azureConfigDir = activeSessionAzureConfigDir(session) ?? undefined;
  const kubeconfigPath = activeSessionKubeconfigPath(session) ?? null;

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
        KUBECONFIG: activeSessionKubeconfigPath(session) ?? process.env.KUBECONFIG,
        ...(azureConfigDir ? { AZURE_CONFIG_DIR: azureConfigDir } : {}),
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
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const context = p.context || session.activeContext || undefined;
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

  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
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
      (err: any) => {
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
          ws.send(JSON.stringify({ type: 'ERROR', message: err.message ?? String(err), status: statusCode || undefined }));
        }
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      },
    );
  } catch (err) {
    ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
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
  const azureConfigDir = activeSessionAzureConfigDir(session);
  const context = p.context || session.activeContext || undefined;

  if (!p.pod) {
    ws.send(JSON.stringify({ type: 'ERROR', message: 'pod query parameter is required' }));
    ws.close();
    return;
  }

  try {
    await ensureContextAuthReady({
      context,
      kubeconfigPath,
      fallbackContext: session.activeContext,
      azureConfigDir,
      userId: req.authUser?.id,
      azureLogin: session.azureLogin,
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
      const api = (await kube.rawConfig(context, { kubeconfigPath, fallbackContext: session.activeContext })).makeApiClient(k8s.CustomObjectsApi);
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
        ws.send(JSON.stringify({ type: 'ERROR', message: (err as Error).message }));
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
