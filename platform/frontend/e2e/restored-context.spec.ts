import { expect, test } from '@playwright/test';

test('restores the Kubernetes context belonging to the active persisted tab on launch', async ({ page }) => {
  const activeTabId = 'overview:minikube:restored';
  await page.addInitScript(({ tabId }) => {
    localStorage.setItem('k8sExplorer.openTabs', JSON.stringify([{
      id: tabId,
      label: 'Cluster Overview',
      view: { type: 'overview' },
      originContext: 'minikube',
      originSource: 'minikube',
    }]));
    localStorage.setItem('k8sExplorer.activeTab', tabId);
  }, { tabId: activeTabId });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) {
      await route.fallback();
      return;
    }
    if (url.pathname === '/api/auth/me') {
      await route.fulfill({ json: { user: { id: 'test-user', email: 'test@example.com', role: 'admin' } } });
      return;
    }
    if (url.pathname === '/api/contexts') {
      await route.fulfill({ json: {
        active: 'other-cluster',
        contexts: [
          { name: 'other-cluster', cluster: 'other-cluster', user: 'other-user', active: true, source: { provider: 'local' } },
          { name: 'minikube', cluster: 'minikube', user: 'minikube', active: false, source: { provider: 'minikube' } },
        ],
        localKubeconfigs: [],
      } });
      return;
    }
    if (url.pathname === '/api/contexts/active' && route.request().method() === 'POST') {
      await route.fulfill({ json: { active: 'minikube' } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  const restoredContextRequest = page.waitForRequest((request) =>
    new URL(request.url()).pathname === '/api/contexts/active' && request.method() === 'POST',
  );
  await page.goto('/');
  const request = await restoredContextRequest;

  expect(request.postDataJSON()).toMatchObject({ name: 'minikube', source: 'minikube' });
});
