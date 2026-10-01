import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realResources = await import('../kube/resources.js');
const realHelmService = await import('./helmService.js');
let getResourceMock: (...args: any[]) => Promise<any> = realResources.getResource;
let replaceResourceMock: (...args: any[]) => Promise<any> = realResources.replaceResource;
let listReleasesMock: (...args: any[]) => Promise<any[]> = realHelmService.listReleases;
let previewInstallMock: (...args: any[]) => Promise<string> = realHelmService.previewInstall;

mock.module('../kube/resources.js', {
  namedExports: {
    ...realResources,
    getResource: (...args: any[]) => getResourceMock(...args),
    replaceResource: (...args: any[]) => replaceResourceMock(...args),
  },
});
mock.module('./helmService.js', {
  namedExports: {
    ...realHelmService,
    listReleases: (...args: any[]) => listReleasesMock(...args),
    previewInstall: (...args: any[]) => previewInstallMock(...args),
  },
});

const { HttpError } = await import('../util/httpError.js');
const {
  READ_TOOLS,
  WRITE_TOOLS,
  describeProposedAction,
  isInvestigationTool,
  isWriteTool,
  okList,
  dryRunWriteTool,
  prepareActionProposal,
  requiresDeleteCapability,
  toolCatalogForRole,
} = await import('./aiToolExecutor.js');

const proposalContext = {
  context: 'test-context',
  kubeOptions: {} as any,
  role: 'admin' as const,
  helm: null,
};

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

test('Auto-mode workload validation uses Kubernetes dry-run and reports failures', async () => {
  let dryRunFlag: boolean | undefined;
  getResourceMock = async () => ({
    spec: { template: { metadata: {}, spec: { containers: [] } } },
  });
  replaceResourceMock = async (_manifest, _context, _options, dryRun) => {
    dryRunFlag = dryRun;
    return {};
  };

  const result = await dryRunWriteTool('scale_deployment', {
    name: 'checkout', namespace: 'payments', replicas: 2,
  }, proposalContext);
  assert.equal(dryRunFlag, true);
  assert.equal(result.isError, false);

  replaceResourceMock = async () => { throw new Error('API server rejected dry-run'); };
  const rejected = await dryRunWriteTool('scale_deployment', {
    name: 'checkout', namespace: 'payments', replicas: 2,
  }, proposalContext);
  assert.equal(rejected.isError, true);
  assert.match(rejected.output, /API server rejected dry-run/);
});

test('apply_manifest blocks approval when the target already exists', async () => {
  getResourceMock = async () => ({ kind: 'ConfigMap', metadata: { name: 'settings' } });

  const proposal = await prepareActionProposal('apply_manifest', {
    manifest: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'team' } },
  }, proposalContext);

  assert.match(proposal.blocked ?? '', /already exists/);
  assert.ok(proposal.diff?.before);
});

test('apply_manifest proposes approval only after a confirmed not-found lookup', async () => {
  getResourceMock = async () => { throw new HttpError(404, 'Not found'); };

  const proposal = await prepareActionProposal('apply_manifest', {
    manifest: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'team' } },
  }, proposalContext);

  assert.equal(proposal.blocked, undefined);
  assert.ok(proposal.diff?.after);
});

test('apply_manifest blocks approval when existence cannot be verified', async () => {
  getResourceMock = async () => { throw new HttpError(403, 'Forbidden'); };

  const proposal = await prepareActionProposal('apply_manifest', {
    manifest: { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'settings', namespace: 'team' } },
  }, proposalContext);

  assert.match(proposal.blocked ?? '', /Could not verify/);
  assert.equal(proposal.diff, undefined);
});

test('helm_install blocks approval when the release already exists', async () => {
  listReleasesMock = async () => [{ name: 'demo', namespace: 'team' }];
  previewInstallMock = async () => { throw new Error('preview should not run'); };

  const proposal = await prepareActionProposal('helm_install', {
    chart: 'example/demo', releaseName: 'demo', namespace: 'team',
  }, { ...proposalContext, helm: { session: {} as any, scoped: {} as any } });

  assert.match(proposal.blocked ?? '', /already exists/);
  assert.match(proposal.blocked ?? '', /helm_upgrade/);
});

test('helm_install proposes approval after a successful check finds no release', async () => {
  listReleasesMock = async () => [];
  previewInstallMock = async () => 'kind: Deployment';

  const proposal = await prepareActionProposal('helm_install', {
    chart: 'example/demo', releaseName: 'demo', namespace: 'team',
  }, { ...proposalContext, helm: { session: {} as any, scoped: {} as any } });

  assert.equal(proposal.blocked, undefined);
  assert.equal(proposal.diff?.after, 'kind: Deployment');
});

test('helm_install blocks approval when release existence cannot be checked', async () => {
  listReleasesMock = async () => { throw new Error('cluster unavailable'); };

  const proposal = await prepareActionProposal('helm_install', {
    chart: 'example/demo', releaseName: 'demo', namespace: 'team',
  }, { ...proposalContext, helm: { session: {} as any, scoped: {} as any } });

  assert.match(proposal.blocked ?? '', /Could not verify or preview/);
  assert.equal(proposal.diff, undefined);
});
