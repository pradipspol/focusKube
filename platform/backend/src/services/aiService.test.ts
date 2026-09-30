import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let licenseKey: string | null = 'test-license';
mock.module('../runtime/aiLicenseStore.js', {
  namedExports: {
    getLicenseKey: async () => licenseKey,
    getEntitlementState: async () => ({ licenseKey, status: licenseKey ? 'active' : undefined }),
  },
});

const { AiService } = await import('./aiService.js');

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  );
}

test('relay stream parser handles fragmented tokens, tool calls, and terminal completion', async (t) => {
  licenseKey = 'test-license';
  t.mock.method(globalThis, 'fetch', async () =>
    sseResponse([
      'data: {"type":"token","token":"Hel',
      'lo"}\n\ndata: {"type":"tool_use","id":"call-1","name":"get_events","input":{"limit":5}}\n\n',
      'data: [DONE]\n\n',
    ]),
  );
  const chunks: Array<{ type: string; data: any }> = [];

  await new AiService().sendChatToRelay({ cluster: { context: 'cluster-a' } }, [{ role: 'user', content: 'help' }], [], (chunk) => chunks.push(chunk));

  assert.deepEqual(chunks, [
    { type: 'token', data: { token: 'Hello' } },
    { type: 'tool_use', data: { type: 'tool_use', id: 'call-1', name: 'get_events', input: { limit: 5 } } },
    { type: 'stop', data: {} },
  ]);
});

test('relay stream reports a terminal provider error once, without an extra disconnect error', async (t) => {
  licenseKey = 'test-license';
  t.mock.method(globalThis, 'fetch', async () => sseResponse(['data: {"type":"error","message":"quota exhausted"}\n\n']));
  const chunks: Array<{ type: string; data: any }> = [];

  await new AiService().sendChatToRelay({ cluster: { context: 'cluster-a' } }, [{ role: 'user', content: 'help' }], [], (chunk) => chunks.push(chunk));

  assert.deepEqual(chunks, [{ type: 'error', data: { message: 'quota exhausted' } }]);
});

test('relay client fails safely before network access when no license is configured', async (t) => {
  licenseKey = null;
  let called = false;
  t.mock.method(globalThis, 'fetch', async () => {
    called = true;
    return sseResponse([]);
  });
  const chunks: Array<{ type: string; data: any }> = [];

  await new AiService().sendChatToRelay({ cluster: { context: 'cluster-a' } }, [{ role: 'user', content: 'help' }], [], (chunk) => chunks.push(chunk));

  assert.equal(called, false);
  assert.deepEqual(chunks, [{ type: 'error', data: { code: 'NO_ENTITLEMENT', message: 'No active AI plan' } }]);
});
