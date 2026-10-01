import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

type OutboundMessage = { type: string; [key: string]: unknown };

async function mockAssistantApi(page: Page): Promise<void> {
  const sessions = new Map<string, { id: string; context: string; title: string; messages: unknown[]; updatedAt: number }>();
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      await route.fallback();
      return;
    }
    if (pathname === '/api/ai/entitlement') {
      await route.fulfill({ json: { enabled: true, plan: 'pro', status: 'active', quotaRemaining: 42 } });
      return;
    }
    if (pathname === '/api/resources/_kinds') {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === '/api/ai/sessions') {
      const context = url.searchParams.get('context') ?? 'default';
      await route.fulfill({ json: { sessions: [...sessions.values()].filter((session) => session.context === context).sort((a, b) => b.updatedAt - a.updatedAt) } });
      return;
    }
    if (pathname.startsWith('/api/ai/sessions/')) {
      const segments = pathname.split('/');
      const id = decodeURIComponent(segments[4] ?? '');
      const context = url.searchParams.get('context') ?? 'default';
      const key = `${context}:${id}`;
      if (route.request().method() === 'DELETE') {
        sessions.delete(key);
        await route.fulfill({ status: 204 });
        return;
      }
      const body = route.request().postDataJSON() as { title: string; messages: unknown[] };
      if (route.request().method() === 'POST') {
        if (!sessions.has(key)) sessions.set(key, { id, context, ...body, updatedAt: Date.now() });
      } else {
        sessions.set(key, { id, context, ...body, updatedAt: Date.now() });
      }
      await route.fulfill({ json: sessions.get(key) });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function mockAssistantSocket(
  page: Page,
  onMessage: (socket: WebSocketRoute, message: OutboundMessage) => void,
): Promise<OutboundMessage[]> {
  const sent: OutboundMessage[] = [];
  await page.routeWebSocket('**/ws/ai*', (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(raw.toString()) as OutboundMessage;
      sent.push(message);
      if (message.type === 'restore_session') {
        socket.send(JSON.stringify({ type: 'session_restored', sessionId: message.sessionId }));
      }
      onMessage(socket, message);
    });
  });
  return sent;
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto('/e2e/ai-assistant.html');
  await expect(page.getByText('FocusKube AI Assistant', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
}

test('composer starts without an internal scrollbar and account details live in the bottom-bar popover', async ({ page }) => {
  await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  await expect(page.locator('.ai-composer-context-name')).toHaveText('focus-e2e');
  const input = page.getByPlaceholder('Ask about resource…');
  expect(await input.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(48);
  await expect(input).toHaveCSS('overflow-y', 'hidden');
  await expect(page.getByText('Plan: pro')).toHaveCount(0);
  await page.getByRole('button', { name: 'AI account information' }).click();
  await expect(page.getByRole('dialog', { name: 'AI account information' })).toContainText('pro');
  await expect(page.getByRole('dialog', { name: 'AI account information' })).toContainText('42');
});

test('permission mode is sent with each prompt', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  });
  await openAssistant(page);

  await page.getByRole('button', { name: 'Permission mode: Manual' }).click();
  await page.getByRole('menuitemradio', { name: /Plan/ }).click();
  await page.getByPlaceholder('Ask about resource…').fill('Suggest a safe rollout');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => sent).toContainEqual(expect.objectContaining({
    type: 'user_message',
    text: 'Suggest a safe rollout',
    permissionMode: 'plan',
  }));
});

test('closes assistant popups on outside click and clears attachment focus on cancel', async ({ page }) => {
  await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  const modeButton = page.getByRole('button', { name: 'Permission mode: Manual' });
  await modeButton.click();
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toBeVisible();
  await page.getByText('FocusKube AI Assistant', { exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toHaveCount(0);

  const infoButton = page.getByRole('button', { name: 'AI account information' });
  await infoButton.click();
  await expect(page.getByRole('dialog', { name: 'AI account information' })).toBeVisible();
  await page.getByPlaceholder('Ask about resource…').click();
  await expect(page.getByRole('dialog', { name: 'AI account information' })).toHaveCount(0);

  const attachButton = page.getByRole('button', { name: 'Attach images or text files' });
  await attachButton.click();
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toBeVisible();
  await page.getByPlaceholder('Ask about resource…').click();
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toHaveCount(0);
  await attachButton.click();
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toBeVisible();
  await page.locator('input[accept^="image/"]').evaluate((input) => input.dispatchEvent(new Event('cancel')));
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toHaveCount(0);
  await expect(page.getByPlaceholder('Ask about resource…')).toBeFocused();
  await modeButton.click();
  await expect(page.getByRole('menu', { name: 'Permission mode' })).toBeVisible();
});

test.beforeEach(async ({ page }) => {
  await mockAssistantApi(page);
});

test('sends a prompt and renders a streamed Markdown answer incrementally', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: '## Diagnosis\n\n' }));
      socket.send(JSON.stringify({ type: 'token', token: '**checkout-api** is healthy.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Is checkout healthy?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('paragraph').filter({ hasText: 'Is checkout healthy?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Diagnosis' })).toBeVisible();
  await expect(page.getByText('checkout-api', { exact: true })).toBeVisible();
  await expect.poll(() => sent).toContainEqual(expect.objectContaining({ type: 'user_message', text: 'Is checkout healthy?' }));
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
});

test('submits a prompt with Enter and sends its text over the assistant socket', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'I will check the cluster state.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Why is checkout unavailable?');
  await input.press('Enter');

  await expect(page.getByRole('paragraph').filter({ hasText: 'Why is checkout unavailable?' })).toBeVisible();
  await expect(page.getByText('I will check the cluster state.')).toBeVisible();
  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'user_message', text: 'Why is checkout unavailable?' }),
  );
});

test('imports old browser history once and restores by backend session ID', async ({ page }) => {
  const sent = await mockAssistantSocket(page, () => undefined);
  await page.addInitScript(() => {
    localStorage.setItem(
      'k8sExplorer.aiChatSessions',
      JSON.stringify({
        activeSessionId: 'session-prior',
        sessions: [
          {
            id: 'session-prior',
            title: 'Earlier diagnosis',
            updatedAt: 1,
            messages: [
              { id: 'u1', kind: 'text', role: 'user', content: 'Why did checkout fail?' },
              { id: 'a1', kind: 'text', role: 'assistant', content: 'I found a failed readiness probe.' },
              { id: 't1', kind: 'tool', name: 'get_events', input: {}, status: 'done', output: 'Readiness probe failed' },
            ],
          },
        ],
      }),
    );
  });

  await openAssistant(page);

  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({
      type: 'restore_session',
      sessionId: 'session-prior',
    }),
  );
  expect(sent.find((message) => message.type === 'restore_session')).not.toHaveProperty('history');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('k8sExplorer.aiChatSessions'))).toBeNull();
});

test('shows a session restore error instead of remaining in the connecting state', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'restore_session') {
      socket.send(JSON.stringify({ type: 'error', message: 'Chat session not found.' }));
    }
  });
  await openAssistant(page);

  await expect(page.getByText('Chat session not found.')).toBeVisible();
  await expect(page.getByText('Connecting to the AI assistant…')).toHaveCount(0);
});

test('shows a stream error and allows the user to try another prompt', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'error', message: 'AI provider temporarily unavailable' }));
    }
  });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Explain this deployment');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('AI provider temporarily unavailable')).toBeVisible();
  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'user_message', text: 'Explain this deployment' }),
  );
  await input.fill('Try again');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('stops an in-progress response without discarding text already streamed', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'Investigating the Pod…' }));
    }
    if (message.type === 'stop') {
      socket.send(JSON.stringify({ type: 'stopped' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Why is checkout restarting?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Investigating the Pod…')).toBeVisible();
  await page.getByRole('button', { name: 'Stop generating' }).click();

  await expect.poll(() => sent.some((message) => message.type === 'stop')).toBe(true);
  await expect(page.getByText('Investigating the Pod…')).toBeVisible();
  const input = page.getByPlaceholder('Ask about resource…');
  await expect(input).toBeEnabled();
  await input.fill('Check the recent events');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('requires an explicit decision before a proposed write action is resolved', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(
        JSON.stringify({
          type: 'action_proposed',
          id: 'scale-checkout',
          name: 'delete_resource',
          input: { kind: 'deployments', name: 'checkout', namespace: 'payments' },
          summary: 'Delete deployment "checkout" in namespace "payments"',
        }),
      );
    }
    if (message.type === 'action_decision') {
      socket.send(JSON.stringify({ type: 'action_result', id: 'scale-checkout', status: 'rejected' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Scale checkout to zero');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Delete deployment "checkout" in namespace "payments"')).toBeVisible();
  await expect(page.getByText('Review and approve')).toBeVisible();
  await expect(page.getByText('Destructive action')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();

  await expect(page.getByPlaceholder('Ask about resource…')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeEnabled();
  await page.getByRole('button', { name: 'Reject' }).click();

  await expect.poll(() => sent).toContainEqual(expect.objectContaining({ type: 'action_decision', id: 'scale-checkout', approved: false }));
  await expect(page.getByText('Rejected — no change was made.')).toBeVisible();
});

test('sends an approval decision and renders the completed write action', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(
        JSON.stringify({
          type: 'action_proposed',
          id: 'restart-checkout',
          name: 'restart_deployment',
          input: { name: 'checkout', namespace: 'payments' },
          summary: 'Restart deployment "checkout" in namespace "payments"',
        }),
      );
    }
    if (message.type === 'action_decision') {
      socket.send(JSON.stringify({ type: 'action_result', id: 'restart-checkout', status: 'approved' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Restart checkout');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Restart deployment "checkout" in namespace "payments"')).toBeVisible();
  await page.getByRole('button', { name: 'Approve' }).click();

  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'action_decision', id: 'restart-checkout', approved: true }),
  );
  await expect(page.getByText('Approved — executed.')).toBeVisible();
});

test('approves all pending proposals from the review bar', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      for (const [id, name] of [['restart-api', 'restart_deployment'], ['scale-worker', 'scale_deployment']]) {
        socket.send(JSON.stringify({
          type: 'action_proposed',
          id,
          name,
          input: { name: id, namespace: 'default' },
          summary: `${name} ${id}`,
        }));
      }
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Restart the api and scale the worker');
  await page.getByRole('button', { name: 'Send' }).click();
  const reviewBar = page.getByRole('group', { name: 'Pending actions' });
  await expect(reviewBar).toContainText('2 actions require a decision');
  expect(await reviewBar.evaluate((element) => element.closest('.ai-panel-messages'))).toBeNull();
  expect(await page.locator('.ai-panel-input-row').evaluate((element) => element.previousElementSibling?.classList.contains('ai-action-review-bar'))).toBe(true);
  await expect(page.getByPlaceholder('Ask about resource…')).toBeDisabled();
  await page.getByRole('button', { name: 'Approve all' }).click();

  await expect.poll(() => sent.filter((message) => message.type === 'action_decision')).toHaveLength(2);
  expect(sent.filter((message) => message.type === 'action_decision')).toEqual([
    expect.objectContaining({ id: 'restart-api', approved: true }),
    expect.objectContaining({ id: 'scale-worker', approved: true }),
  ]);
});

test('disables the composer while an assistant response is streaming', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'token', token: 'Still working…' }));
    if (message.type === 'stop') socket.send(JSON.stringify({ type: 'stopped' }));
  });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Inspect the cluster');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Still working…')).toBeVisible();
  await expect(input).toBeDisabled();
  const stopButton = page.getByRole('button', { name: 'Stop generating' });
  await expect(stopButton).toBeEnabled();
  const expectedDangerColor = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--danger)';
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  await page.mouse.move(0, 0);
  await expect(stopButton).toHaveCSS('background-color', expectedDangerColor);
  await stopButton.click();
  await expect(input).toBeEnabled();
});

test('keeps individual decisions available and rejects all remaining proposals', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      for (const id of ['delete-api', 'delete-worker', 'delete-scheduler']) {
        socket.send(JSON.stringify({
          type: 'action_proposed',
          id,
          name: 'delete_resource',
          input: { kind: 'deployments', name: id, namespace: 'default' },
          summary: `Delete deployment ${id}`,
        }));
      }
    }
    if (message.type === 'action_decision') {
      socket.send(JSON.stringify({
        type: 'action_result',
        id: message.id,
        status: message.approved ? 'approved' : 'rejected',
      }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Remove the old deployments');
  await page.getByRole('button', { name: 'Send' }).click();
  const reviewBar = page.getByRole('group', { name: 'Pending actions' });
  await expect(reviewBar).toContainText('3 actions require a decision');
  const firstProposal = page.locator('.ai-action-card').filter({ hasText: 'Delete deployment delete-api' });
  await firstProposal.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(firstProposal).toContainText('Approved — executed.');
  await expect(reviewBar).toContainText('2 actions require a decision');
  await reviewBar.getByRole('button', { name: 'Reject all' }).click();

  await expect.poll(() => sent.filter((message) => message.type === 'action_decision')).toHaveLength(3);
  expect(sent.filter((message) => message.type === 'action_decision')).toEqual([
    expect.objectContaining({ id: 'delete-api', approved: true }),
    expect.objectContaining({ id: 'delete-worker', approved: false }),
    expect.objectContaining({ id: 'delete-scheduler', approved: false }),
  ]);
});

test('Stop cancels all pending proposals and blocks another message until stopped', async ({ page }) => {
  const proposals = [
    { id: 'delete-api', name: 'delete_resource', summary: 'Delete deployment api' },
    { id: 'delete-worker', name: 'delete_resource', summary: 'Delete deployment worker' },
  ];
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      for (const proposal of proposals) {
        socket.send(JSON.stringify({
          type: 'action_proposed',
          ...proposal,
          input: { kind: 'deployments', name: proposal.id, namespace: 'default' },
        }));
      }
    }
    if (message.type === 'stop') {
      for (const proposal of proposals) {
        socket.send(JSON.stringify({ type: 'action_result', id: proposal.id, status: 'cancelled' }));
      }
      socket.send(JSON.stringify({ type: 'stopped' }));
    }
  });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Clean up the old deployments');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('button', { name: 'Stop generating' })).toBeEnabled();
  await expect(input).toBeDisabled();
  expect(sent.filter((message) => message.type === 'user_message')).toHaveLength(1);

  await page.getByRole('button', { name: 'Stop generating' }).click();
  await expect(page.locator('.ai-action-card-cancelled')).toHaveCount(2);
  await expect(input).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(sent.filter((message) => message.type === 'action_decision')).toHaveLength(0);
  expect(sent.filter((message) => message.type === 'stop')).toHaveLength(1);
});

const skillPrompts = [
  ['Cluster overview', 'Give me an overview of this cluster'],
  ['Nodes', 'What is the status and resource usage (CPU/memory) of each node'],
  ['Pods', 'How many pods are running right now'],
  ['Deployments', 'List the deployments in this cluster'],
  ['Services', 'What services are exposed in this cluster'],
  ['Namespaces', 'List the namespaces in this cluster'],
  ['Recent events', 'Show me the most recent warning events'],
  ['Logs', 'Summarize any errors from recent logs'],
  ['Storage', 'What persistent volumes and claims exist'],
  ['Security', 'Are any pods running as root, privileged'],
] as const;

for (const [skill, expectedPrompt] of skillPrompts) {
  test(`puts the ${skill.toLowerCase()} skill prompt in the composer`, async ({ page }) => {
    const sent = await mockAssistantSocket(page, (socket, message) => {
      if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
    });
    await openAssistant(page);

    await page.getByRole('button', { name: 'Skills' }).click();
    await page.getByRole('button', { name: skill }).click();
    const input = page.getByPlaceholder('Ask about resource…');
    await expect.poll(() => input.inputValue()).toContain(expectedPrompt);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect.poll(() => sent).toContainEqual(expect.objectContaining({ type: 'user_message', text: expect.stringContaining(expectedPrompt) }));
  });
}

test('keeps Shift+Enter in the draft instead of submitting the message', async ({ page }) => {
  const sent = await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Check the pod status');
  await input.press('Shift+Enter');

  await expect(input).toHaveValue('Check the pod status\n');
  expect(sent.filter((message) => message.type === 'user_message')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('restores backend chat history across reload and supports editing a sent turn', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message' || message.type === 'edit_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'The pod is pending.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);
  await expect(page.locator('.ai-gate-session-title')).toHaveCount(0);

  const saveResponse = page.waitForResponse((response) =>
    response.url().includes('/api/ai/sessions/') &&
    response.request().method() === 'PUT' &&
    response.ok() &&
    response.request().postDataJSON()?.messages?.some((message: { content?: string }) => message.content === 'Why is api-0 pending?'),
  );
  await page.getByPlaceholder('Ask about resource…').fill('Why is api-0 pending?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The pod is pending.')).toBeVisible();
  await saveResponse;

  await page.reload();
  await expect(page.getByRole('paragraph').filter({ hasText: 'Why is api-0 pending?' })).toBeVisible();
  await expect(page.locator('.ai-gate-session-title')).toHaveText('Why is api-0 pending?');
  const userBubble = page.locator('.ai-panel-message-user .ai-panel-message-bubble').filter({ hasText: 'Why is api-0 pending?' });
  await userBubble.click();
  const editInput = page.locator('.ai-message-edit-input');
  await expect(editInput).toBeVisible();
  await page.getByPlaceholder('Ask about resource…').click();
  await expect(editInput).toHaveCount(0);
  await expect(page.getByRole('paragraph').filter({ hasText: 'Why is api-0 pending?' })).toBeVisible();

  const editButton = page.getByRole('button', { name: 'Edit' });
  await editButton.hover();
  await expect(editButton).toHaveAttribute('title', 'Edit');
  await editButton.click();
  await expect.poll(() => editInput.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(240);
  await editInput.fill('Why is api-1 pending?');
  await page.getByPlaceholder('Ask about resource…').click();
  const discardDialog = page.getByRole('alertdialog', { name: 'Unsaved message changes' });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editInput).toHaveValue('Why is api-1 pending?');
  await editInput.press('Escape');
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'edit_message', text: 'Why is api-1 pending?' }),
  );

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.ai-message-edit-input').fill('Discard this edit');
  await page.getByPlaceholder('Ask about resource…').click();
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole('button', { name: 'Discard' }).click();
  await expect(page.locator('.ai-message-edit-input')).toHaveCount(0);
  await expect(page.getByRole('paragraph').filter({ hasText: 'Why is api-1 pending?' })).toBeVisible();
});

test('preserves chat history when switching Kubernetes contexts before the save debounce fires', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'Minikube response.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Keep this Minikube conversation');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Minikube response.')).toBeVisible();

  const contextPicker = page.getByRole('combobox', { name: 'Test Kubernetes context' });
  await contextPicker.selectOption('minikube');
  await expect(page.locator('.ai-composer-context-name')).toHaveText('minikube');
  await expect(page.getByText('Keep this Minikube conversation')).toHaveCount(0);

  await contextPicker.selectOption('focus-e2e');
  await expect(page.locator('.ai-composer-context-name')).toHaveText('focus-e2e');
  await expect(page.getByRole('paragraph').filter({ hasText: 'Keep this Minikube conversation' })).toBeVisible();
  await expect(page.getByText('Minikube response.')).toBeVisible();
});

test('starts a separate chat, reopens a saved session, and deletes it from history', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'Saved response.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Inspect checkout deployment');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Saved response.')).toBeVisible();
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByText('Inspect checkout deployment')).toHaveCount(0);

  await page.getByRole('button', { name: 'Chat history' }).click();
  const savedSession = page.getByRole('button', { name: /Inspect checkout deployment/ });
  await expect(savedSession).toBeVisible();
  await savedSession.click();
  await expect(page.getByRole('paragraph').filter({ hasText: 'Inspect checkout deployment' })).toBeVisible();

  await page.getByRole('button', { name: 'Chat history' }).click();
  await page.locator('.ai-history-item').filter({ hasText: 'Inspect checkout deployment' }).getByRole('button', { name: 'Delete chat' }).click();
  await expect(page.getByRole('button', { name: /Inspect checkout deployment/ })).toHaveCount(0);
});

test('recovers to a fresh chat when persisted history is malformed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('k8sExplorer.aiChatSessions', '{invalid json'));
  await mockAssistantSocket(page, () => undefined);
  await page.goto('/e2e/ai-assistant.html');

  await expect(page.getByText('FocusKube AI Assistant', { exact: true })).toBeVisible();
  await expect(page.getByPlaceholder('Ask about resource…')).toBeEnabled();
});

test('renders completed read-tool output on demand and identifies tool errors', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'tool_call', id: 'get-pods', name: 'list_pods', input: { namespace: 'payments' } }));
      socket.send(JSON.stringify({
        type: 'tool_result',
        id: 'get-pods',
        name: 'list_pods',
        output: JSON.stringify([{ name: 'checkout-0', phase: 'Running' }]),
        isError: false,
      }));
      socket.send(JSON.stringify({ type: 'tool_call', id: 'get-events', name: 'list_events', input: { namespace: 'payments' } }));
      socket.send(JSON.stringify({
        type: 'tool_result',
        id: 'get-events',
        name: 'list_events',
        output: 'Forbidden: cannot list events',
        isError: true,
      }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Inspect pods and recent events');
  await page.getByRole('button', { name: 'Send' }).click();
  const showOutput = page.getByRole('button', { name: /Show output/ });
  await expect(showOutput).toHaveCount(2);
  await showOutput.first().click();
  await expect(page.getByText('checkout-0')).toBeVisible();
  await page.getByRole('button', { name: /Show output/ }).click();
  await expect(page.getByText('Forbidden: cannot list events')).toBeVisible();
});

test('expands and collapses a large tool response without losing its content', async ({ page }) => {
  const longOutput = Array.from({ length: 45 }, (_, index) => `event-${index + 1}`).join('\n');
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'tool_call', id: 'long-events', name: 'list_events', input: {} }));
      socket.send(JSON.stringify({ type: 'tool_result', id: 'long-events', name: 'list_events', output: longOutput, isError: false }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Show all recent events');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: /Show output/ }).click();
  const expand = page.getByRole('button', { name: /Show \d+ more lines/ });
  await expect(expand).toBeVisible();
  await expand.click();
  await expect(page.locator('.ai-tool-output code')).toContainText('event-45');
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(page.getByRole('button', { name: /Show \d+ more lines/ })).toBeVisible();
});

test('attaches and serializes a supported image with the user message', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  });
  await openAssistant(page);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64');
  await page.getByRole('button', { name: 'Attach images or text files' }).click();
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Upload images' }).click();
  await page.locator('input[accept^="image/"]').setInputFiles({ name: 'pod.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.ai-attached-image-thumb img')).toHaveCount(1);
  await page.getByPlaceholder('Ask about resource…').fill('What is shown in this screenshot?');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({
      type: 'user_message',
      text: 'What is shown in this screenshot?',
      images: [expect.objectContaining({ mediaType: 'image/jpeg', data: expect.any(String) })],
    }),
  );
});

test('attaches a text file, displays its name, and submits its contents', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  });
  await openAssistant(page);

  await page.getByRole('button', { name: 'Attach images or text files' }).click();
  await expect(page.getByRole('menu', { name: 'Add an attachment' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Upload text files' }).click();
  await page.locator('input[accept^="."]').setInputFiles({
    name: 'incident.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('The api pod is failing its readiness probe.'),
  });
  await expect(page.locator('.ai-attached-file')).toContainText('incident.txt');
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(() => sent).toContainEqual(expect.objectContaining({
    type: 'user_message',
    files: [{ name: 'incident.txt', content: 'The api pod is failing its readiness probe.' }],
  }));
  await expect(page.locator('.ai-message-file')).toContainText('incident.txt');
});

test('drops a text file onto the chat to attach it', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  });
  await openAssistant(page);

  await page.locator('.ai-panel-chat-col').evaluate((element) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['Dropped incident details'], 'dropped.txt', { type: 'text/plain' }));
    element.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });

  await expect(page.locator('.ai-attached-file')).toContainText('dropped.txt');
  await expect(page.getByText('Drop images or text files to attach')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect.poll(() => sent).toContainEqual(expect.objectContaining({
    type: 'user_message',
    files: [{ name: 'dropped.txt', content: 'Dropped incident details' }],
  }));
});

test('enforces the per-message image limit and allows removing an attachment', async ({ page }) => {
  await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  const image = {
    name: 'pod.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64'),
  };
  const chooser = page.locator('input[accept^="image/"]');
  await chooser.setInputFiles([image, image, image]);
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Attach images or text files' })).toBeEnabled();

  await page.getByRole('button', { name: 'Remove image' }).first().click();
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Attach images or text files' })).toBeEnabled();
  await chooser.setInputFiles(image);
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  await chooser.setInputFiles(image);
  await expect(page.getByText('Attach at most 3 images per message.')).toBeVisible();
});

test('limits text attachments and allows removing one to make room', async ({ page }) => {
  await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  const file = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`Contents of ${name}`) });
  const chooser = page.locator('input[accept^="."]');
  await chooser.setInputFiles([file('one.txt'), file('two.txt'), file('three.txt'), file('four.txt')]);
  await expect(page.locator('.ai-attached-file')).toHaveCount(3);
  await expect(page.getByText('Attach at most 3 text files per message.')).toBeVisible();

  await page.getByRole('button', { name: 'Remove attachment' }).first().click();
  await chooser.setInputFiles(file('four.txt'));
  await expect(page.locator('.ai-attached-file')).toHaveCount(3);
  await expect(page.locator('.ai-attached-file').filter({ hasText: 'four.txt' })).toHaveCount(1);
});

test('does not allow model output to create executable HTML', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: '<img src=x onerror=window.__assistantXss=true>' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Show an unsafe HTML example');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByText('<img src=x onerror=window.__assistantXss=true>')).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as Window & { __assistantXss?: boolean }).__assistantXss)).toBeUndefined();
});

test('keeps the assistant behind the entitlement gate when AI is not enabled', async ({ page }) => {
  let socketOpened = false;
  await page.route('**/api/ai/entitlement', (route) => route.fulfill({ json: { enabled: false } }));
  await page.routeWebSocket('**/ws/ai*', () => {
    socketOpened = true;
  });
  await page.goto('/e2e/ai-assistant.html');

  await expect(page.getByRole('heading', { name: 'FocusKube Assistant is a Pro feature' })).toBeVisible();
  await expect(page.getByPlaceholder('Ask about resource…')).toHaveCount(0);
  expect(socketOpened).toBe(false);
});

test('keeps chat controls usable without horizontal overflow on a narrow viewport', async ({ page }) => {
  await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'A concise mobile answer.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Check node readiness');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('A concise mobile answer.')).toBeVisible();
  const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(hasHorizontalOverflow).toBe(false);
});

test('Auto mode asks once for consent and renders later actions as dry-run applied', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message' && message.text === 'Scale checkout') {
      socket.send(JSON.stringify({
        type: 'action_proposed',
        id: 'scale-once',
        name: 'scale_deployment',
        input: { name: 'checkout', namespace: 'payments', replicas: 2 },
        summary: 'Scale checkout to 2 replicas',
        permissionMode: 'auto',
      }));
    } else if (message.type === 'action_decision') {
      socket.send(JSON.stringify({ type: 'action_result', id: 'scale-once', status: 'approved' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    } else if (message.type === 'user_message') {
      socket.send(JSON.stringify({
        type: 'action_auto',
        id: 'scale-again',
        name: 'scale_deployment',
        input: { name: 'checkout', namespace: 'payments', replicas: 3 },
        summary: 'Scale checkout to 3 replicas',
        status: 'approved',
        output: 'Deployment scaled',
      }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByRole('button', { name: 'Permission mode: Manual' }).click();
  await page.getByRole('menuitemradio', { name: /Auto/ }).click();
  await page.getByPlaceholder('Ask about resource…').fill('Scale checkout');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Approve and enable Auto' }).click();
  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'action_decision', id: 'scale-once', approved: true }),
  );
  expect(sent.find((message) => message.type === 'action_decision')).not.toHaveProperty('remember');

  await page.getByPlaceholder('Ask about resource…').fill('Scale checkout again');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Scale checkout to 3 replicas')).toBeVisible();
  await expect(page.getByText('(approved once; dry-run passed before apply)')).toBeVisible();
});
