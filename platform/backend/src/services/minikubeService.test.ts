import { describe, it } from 'node:test';
import assert from 'node:assert';
import { minikubeService } from './minikubeService.js';

describe('MinikubeService', () => {
  describe('getStatus', () => {
    it('should return status when minikube is installed', async () => {
      const status = await minikubeService.getStatus('minikube');
      assert.ok(status);
      assert.ok(status.name);
      assert.ok(['running', 'stopped', 'paused', 'not-installed'].includes(status.status));
    });

    it('should use default cluster name', async () => {
      const status = await minikubeService.getStatus();
      assert.strictEqual(status.name, 'minikube');
    });
  });

  describe('isMinikubeInstalled', () => {
    it('should return boolean', async () => {
      const installed = await minikubeService.isMinikubeInstalled();
      assert.strictEqual(typeof installed, 'boolean');
    });
  });

  describe('calculateAge', () => {
    it('should calculate age correctly', () => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Access private method via reflection for testing
      const service = minikubeService as any;
      const age = service.calculateAge(oneHourAgo);

      assert.ok(age.includes('h') || age.includes('m'));
    });

    it('should handle unknown dates', () => {
      const service = minikubeService as any;
      const age = service.calculateAge(undefined);
      assert.strictEqual(age, 'Unknown');
    });
  });
});
