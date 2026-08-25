import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservabilityService } from './observabilityService.js';

function createLifecycleMock() {
  return {
    getStatusCalls: [] as any[],
    startCalls: [] as any[],
    stopCalls: [] as any[],
    getStatus(context?: string, userId?: string) {
      this.getStatusCalls.push({ context, userId });
      return Promise.resolve({ context, userId, status: 'active' as const });
    },
    startRecording(context: string, userId: string, kubeconfigPath?: string, fallbackContext?: string) {
      this.startCalls.push({ context, userId, kubeconfigPath, fallbackContext });
      return Promise.resolve({ recordingId: 'r-1', status: 'active' as const });
    },
    stopRecording(context: string, userId: string, serverUrl?: string) {
      this.stopCalls.push({ context, userId, serverUrl });
      return Promise.resolve();
    },
  };
}

test('observabilityService delegates getStatus/start/stop to lifecycle', async () => {
  const lifecycle = createLifecycleMock();
  const service = new ObservabilityService({
    lifecycleFactory: () => lifecycle as any,
  });

  const status = await service.getStatus('ctx-a', 'user-a');
  assert.deepEqual(status, { context: 'ctx-a', userId: 'user-a', status: 'active' });
  assert.equal(lifecycle.getStatusCalls.length, 1);

  const started = await service.startRecording('ctx-a', 'user-a', 'kube-a', 'fallback-a');
  assert.deepEqual(started, { recordingId: 'r-1', status: 'active' });
  assert.equal(lifecycle.startCalls.length, 1);
  assert.deepEqual(lifecycle.startCalls[0], {
    context: 'ctx-a',
    userId: 'user-a',
    kubeconfigPath: 'kube-a',
    fallbackContext: 'fallback-a',
  });

  await service.stopRecording('ctx-a', 'user-a', 'https://cluster.local');
  assert.equal(lifecycle.stopCalls.length, 1);
  assert.deepEqual(lifecycle.stopCalls[0], {
    context: 'ctx-a',
    userId: 'user-a',
    serverUrl: 'https://cluster.local',
  });
});

test('observabilityService.getLifecycleInstance returns provided lifecycle', () => {
  const lifecycle = createLifecycleMock();
  const service = new ObservabilityService({
    lifecycleFactory: () => lifecycle as any,
  });

  assert.equal(service.getLifecycleInstance(), lifecycle as any);
});
