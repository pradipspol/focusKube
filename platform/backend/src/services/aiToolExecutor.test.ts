import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_TOOLS,
  WRITE_TOOLS,
  describeProposedAction,
  isInvestigationTool,
  isWriteTool,
  okList,
  requiresDeleteCapability,
  toolCatalogForRole,
} from './aiToolExecutor.js';

test('AI tool catalog never offers mutation tools to read-only roles', () => {
  for (const role of ['viewer', undefined, null] as const) {
    const names = toolCatalogForRole(role).map((tool) => tool.name);
    assert.deepEqual(names, READ_TOOLS.map((tool) => tool.name));
  }
});

test('AI tool catalog grants only the authorized write tier', () => {
  const rwonly = new Set(toolCatalogForRole('rwonly').map((tool) => tool.name));
  const editor = new Set(toolCatalogForRole('editor').map((tool) => tool.name));
  const admin = new Set(toolCatalogForRole('admin').map((tool) => tool.name));

  for (const tool of WRITE_TOOLS) {
    if (requiresDeleteCapability(tool.name)) {
      assert.equal(rwonly.has(tool.name), false, `${tool.name} requires delete`);
      assert.equal(editor.has(tool.name), true, `${tool.name} is available to an editor`);
    } else {
      assert.equal(rwonly.has(tool.name), true, `${tool.name} is available to rwonly`);
    }
    assert.equal(admin.has(tool.name), true, `${tool.name} is available to an admin`);
  }
  assert.equal(isWriteTool('delete_resource'), true);
  assert.equal(isWriteTool('get_logs'), false);
  assert.equal(isInvestigationTool('investigate_resources'), true);
});

test('AI list output remains valid JSON when capped', () => {
  const result = okList(Array.from({ length: 400 }, (_, index) => ({ name: `pod-${index}`, detail: 'x'.repeat(100) })));
  const rows = JSON.parse(result.output) as Array<{ name: string }>;
  assert.equal(result.isError, false);
  assert.ok(result.output.length <= 16 * 1024);
  assert.match(rows.at(-1)?.name ?? '', /truncated/);
});

test('write proposals always identify the exact target and scope', () => {
  assert.equal(
    describeProposedAction('delete_resource', { kind: 'secrets', name: 'payment-token', namespace: 'production' }),
    'Delete secrets "payment-token" in namespace "production"',
  );
  assert.equal(
    describeProposedAction('scale_deployment', { name: 'checkout', namespace: 'payments', replicas: 0 }),
    'Scale deployment "checkout" in namespace "payments" to 0 replica(s)',
  );
});
