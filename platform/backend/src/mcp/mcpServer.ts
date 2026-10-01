import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hasCapability } from '../auth/rbac.js';
import { resolveAuthFromHeaders } from '../auth/session.js';
import { getAppSettings, type McpSettings } from '../runtime/appSettingsStore.js';
import { recordUsage } from '../runtime/usageStats.js';
import { resolveSessionHelmAccess, resolveSessionKubeAccess } from '../services/aiContextService.js';
import {
  READ_TOOLS,
  WRITE_TOOLS,
  dryRunWriteTool,
  executeReadTool,
  executeWriteTool,
  isInvestigationTool,
  isWriteTool,
  requiresDeleteCapability,
  type ToolDefinition,
} from '../services/aiToolExecutor.js';
import { logInfo, logWarn } from '../util/logger.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface McpServerStatus {
  running: boolean;
  url: string | null;
  error: string | null;
}

let server: http.Server | null = null;
let listeningPort: number | null = null;
let lastError: string | null = null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const contextProperty = {
  context: {
    type: 'string',
    description: 'Kubeconfig context to run against. Defaults to the cluster currently active in FocusKube.',
  },
};

const ACTIVE_CONTEXT_TOOL = {
  name: 'get_active_context',
  description: 'Returns the Kubernetes context currently selected in FocusKube, which tools use when no context is given.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};

function toMcpTool(tool: ToolDefinition, write: boolean) {
  const description = write
    ? tool.description.replace(/^Propose (\w)/, (_m, c: string) => c.toUpperCase()).replace(/\s*Requires the user's explicit approval.*$/, '')
    : tool.description;
  return {
    name: tool.name,
    description,
    inputSchema: { ...tool.input_schema, properties: { ...tool.input_schema.properties, ...contextProperty } },
    annotations: write
      ? { readOnlyHint: false, destructiveHint: requiresDeleteCapability(tool.name) }
      : { readOnlyHint: true },
  };
}

function availableTools(settings: McpSettings) {
  const tools: Array<Record<string, unknown>> = [ACTIVE_CONTEXT_TOOL];
  tools.push(...READ_TOOLS.filter((t) => !isInvestigationTool(t.name)).map((t) => toMcpTool(t, false)));
  if (settings.allowWrite) tools.push(...WRITE_TOOLS.map((t) => toMcpTool(t, true)));
  return tools;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

async function callTool(name: string, args: Record<string, unknown>, settings: McpSettings) {
  const { user, state } = await resolveAuthFromHeaders();
  if (!user || !state) return textResult('Sign in to FocusKube before using its MCP tools.', true);

  if (name === 'get_active_context') {
    return textResult(JSON.stringify({ context: state.activeContext ?? null, source: state.activeContextSource ?? null }, null, 2));
  }

  const known = READ_TOOLS.some((t) => t.name === name && !isInvestigationTool(name)) || isWriteTool(name);
  if (!known) throw new RpcError(-32602, `Unknown tool: ${name}`);
  if (isWriteTool(name)) {
    if (!settings.allowWrite) return textResult('Write tools are disabled in FocusKube Settings > Integrations > MCP server.', true);
    const capability = requiresDeleteCapability(name) ? 'delete' : 'write';
    if (!hasCapability(user.role, capability)) return textResult(`Your FocusKube role does not allow ${capability} operations.`, true);
  }

  const { context: requestedContext, ...input } = args;
  const context = typeof requestedContext === 'string' && requestedContext ? requestedContext : state.activeContext;
  if (!context) return textResult('No Kubernetes context is active in FocusKube. Connect to a cluster or pass "context".', true);

  const [kubeOptions, helm] = await Promise.all([
    resolveSessionKubeAccess(state, context),
    resolveSessionHelmAccess(state, context),
  ]);
  if (!kubeOptions) return textResult(`Cluster "${context}" is not reachable or not authenticated in FocusKube.`, true);

  const ctx = { context, kubeOptions, role: user.role, helm };
  recordUsage(`mcp.tool.${name}`);
  if (isWriteTool(name)) {
    const preview = await dryRunWriteTool(name, input, ctx);
    if (preview.isError) return textResult(preview.output, true);
    const result = await executeWriteTool(name, input, ctx);
    return textResult(result.output, result.isError);
  }
  const result = await executeReadTool(name, input, ctx);
  return textResult(result.output, result.isError);
}

async function handleRpc(message: JsonRpcRequest): Promise<unknown> {
  const settings = getAppSettings().mcp;
  switch (message.method) {
    case 'initialize': {
      const requested = message.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'focuskube', title: 'FocusKube', version: '1.0.0' },
        instructions:
          'Tools operate on the Kubernetes clusters connected in the FocusKube desktop app. Omit "context" to use the cluster currently selected in FocusKube.',
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: availableTools(settings) };
    case 'tools/call': {
      const name = message.params?.name;
      if (typeof name !== 'string') throw new RpcError(-32602, 'Tool name is required.');
      const args = message.params?.arguments && typeof message.params.arguments === 'object' ? message.params.arguments : {};
      return callTool(name, args, settings);
    }
    default:
      throw new RpcError(-32601, `Method not found: ${message.method}`);
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const provided = Buffer.from(match[1].trim());
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// Guards against DNS-rebinding: only loopback Host/Origin values may reach the server.
function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!LOOPBACK_HOSTNAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RpcError(-32600, 'Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const settings = getAppSettings().mcp;
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/mcp') return sendJson(res, 404, { error: 'Not found' });
  if (!isLoopbackRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });
  if (!tokenMatches(req.headers.authorization, settings.token)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return sendJson(res, 401, { error: 'Invalid or missing bearer token' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(await readBody(req));
  } catch (err) {
    const rpc = err instanceof RpcError ? err : new RpcError(-32700, 'Parse error');
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: rpc.code, message: rpc.message } });
  }
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') {
    return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }

  // Notifications (no id) get no response body.
  if (message.id === undefined || message.id === null) {
    res.writeHead(202).end();
    return;
  }

  try {
    const result = await handleRpc(message);
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, result });
  } catch (err) {
    const code = err instanceof RpcError ? err.code : -32603;
    const errorMessage = err instanceof Error ? err.message : 'Internal error';
    logWarn('mcp.request.failed', { method: message.method, error: errorMessage });
    sendJson(res, 200, { jsonrpc: '2.0', id: message.id, error: { code, message: errorMessage } });
  }
}

async function stopServer(): Promise<void> {
  const current = server;
  server = null;
  listeningPort = null;
  if (!current) return;
  await new Promise<void>((resolve) => current.close(() => resolve()));
  current.closeAllConnections?.();
  logInfo('mcp.server.stopped');
}

async function startServer(port: number): Promise<void> {
  const next = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logWarn('mcp.request.unhandled', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
    });
  });
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject);
    next.listen(port, '127.0.0.1', () => {
      next.off('error', reject);
      resolve();
    });
  });
  server = next;
  listeningPort = port;
  logInfo('mcp.server.listening', { url: `http://127.0.0.1:${port}/mcp` });
}

export async function applyMcpSettings(settings: McpSettings): Promise<void> {
  lastError = null;
  if (!settings.enabled) {
    await stopServer();
    return;
  }
  if (server && listeningPort === settings.port) return;
  await stopServer();
  try {
    await startServer(settings.port);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    logWarn('mcp.server.start_failed', { port: settings.port, error: lastError });
  }
}

export function getMcpServerStatus(): McpServerStatus {
  return {
    running: server !== null,
    url: listeningPort ? `http://127.0.0.1:${listeningPort}/mcp` : null,
    error: lastError,
  };
}
