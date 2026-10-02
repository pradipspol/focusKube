import assert from 'node:assert/strict';
import test from 'node:test';
import { availableTools, hasPaidMcpAccess } from './mcpServer.js';

test('MCP access includes active trials and paid plans', () => {
  for (const plan of ['trial', 'pro', 'team']) {
    assert.equal(hasPaidMcpAccess({ licenseKey: 'license', plan, status: 'active' }), true);
  }

  for (const entitlement of [
    { licenseKey: 'license', plan: 'trial', status: 'inactive' },
    { licenseKey: 'license', plan: 'pro', status: 'inactive' },
    { licenseKey: null, plan: 'team', status: 'active' },
    { licenseKey: 'license', plan: 'unknown', status: 'active' },
  ]) {
    assert.equal(hasPaidMcpAccess(entitlement), false);
  }
});

test('MCP access allows the development entitlement', () => {
  assert.equal(hasPaidMcpAccess({ licenseKey: 'dev-key', plan: 'dev', status: 'active' }), true);
});

test('MCP catalog exposes FocusKube AI investigation as a read-only tool', () => {
  const tools = availableTools({ enabled: true, port: 47821, allowWrite: false, token: 'test-token' });
  const investigation = tools.find((tool) => tool.name === 'investigate_resources');

  assert.ok(investigation);
  const definition = investigation as {
    annotations?: { readOnlyHint?: boolean };
    inputSchema?: { properties?: Record<string, unknown> };
  };
  assert.equal(definition.annotations?.readOnlyHint, true);
  assert.ok(definition.inputSchema?.properties?.targets);
});