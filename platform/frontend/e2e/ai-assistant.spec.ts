import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

type OutboundMessage = { type: string; [key: string]: unknown };

async function mockAssistantApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
      onMessage(socket, message);
    });
  });
  return sent;
}

async function openAssistant(page: Page): Promise<void> {
  await page.goto('/e2e/ai-assistant.html');
  await expect(page.getByText('FocusKube AI Assistant')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
}

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

  await expect(page.getByText('Is checkout healthy?')).toBeVisible();
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

  await expect(page.getByText('Why is checkout unavailable?')).toBeVisible();
  await expect(page.getByText('I will check the cluster state.')).toBeVisible();
  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'user_message', text: 'Why is checkout unavailable?' }),
  );
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
          name: 'scale_deployment',
          input: { name: 'checkout', namespace: 'payments', replicas: 0 },
          summary: 'Scale deployment "checkout" in namespace "payments" to 0 replica(s)',
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
  await expect(page.getByText('Scale deployment "checkout" in namespace "payments" to 0 replica(s)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();

  await page.getByPlaceholder('Ask about resource…').fill('Do something else');
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
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
  const sent = await mockAssistantSocket(page, (_socket, _message) => undefined);
  await openAssistant(page);

  const input = page.getByPlaceholder('Ask about resource…');
  await input.fill('Check the pod status');
  await input.press('Shift+Enter');

  await expect(input).toHaveValue('Check the pod status\n');
  expect(sent).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
});

test('persists chat history across reload and supports editing a sent turn', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message' || message.type === 'edit_message') {
      socket.send(JSON.stringify({ type: 'token', token: 'The pod is pending.' }));
      socket.send(JSON.stringify({ type: 'stop' }));
    }
  });
  await openAssistant(page);

  await page.getByPlaceholder('Ask about resource…').fill('Why is api-0 pending?');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('The pod is pending.')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('k8sExplorer.aiChatSessions'))).toContain('Why is api-0 pending?');

  await page.reload();
  await expect(page.getByText('Why is api-0 pending?')).toBeVisible();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.locator('.ai-message-edit-input').fill('Why is api-1 pending?');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'edit_message', text: 'Why is api-1 pending?' }),
  );
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
  await expect(page.getByText('Inspect checkout deployment')).toBeVisible();

  await page.getByRole('button', { name: 'Chat history' }).click();
  await page.getByRole('button', { name: /Inspect checkout deployment/ }).getByLabel('Delete chat').click();
  await expect(page.getByRole('button', { name: /Inspect checkout deployment/ })).toHaveCount(0);
});

test('recovers to a fresh chat when persisted history is malformed', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('k8sExplorer.aiChatSessions', '{invalid json'));
  await mockAssistantSocket(page, () => undefined);
  await page.goto('/e2e/ai-assistant.html');

  await expect(page.getByText('FocusKube AI Assistant')).toBeVisible();
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
  await page.locator('input[type="file"]').setInputFiles({ name: 'pod.png', mimeType: 'image/png', buffer: png });
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

test('enforces the per-message image limit and allows removing an attachment', async ({ page }) => {
  await mockAssistantSocket(page, () => undefined);
  await openAssistant(page);

  const image = {
    name: 'pod.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64'),
  };
  const chooser = page.locator('input[type="file"]');
  await chooser.setInputFiles([image, image, image]);
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Attach image' })).toBeDisabled();

  await page.getByRole('button', { name: 'Remove image' }).first().click();
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Attach image' })).toBeEnabled();
  await chooser.setInputFiles(image);
  await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  await chooser.setInputFiles(image);
  await expect(page.getByText('Attach at most 3 images per message.')).toBeVisible();
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

test('sends the session-scoped approval choice and renders an auto-approved later action', async ({ page }) => {
  const sent = await mockAssistantSocket(page, (socket, message) => {
    if (message.type === 'user_message' && message.text === 'Scale checkout') {
      socket.send(JSON.stringify({
        type: 'action_proposed',
        id: 'scale-once',
        name: 'scale_deployment',
        input: { name: 'checkout', namespace: 'payments', replicas: 2 },
        summary: 'Scale checkout to 2 replicas',
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

  await page.getByPlaceholder('Ask about resource…').fill('Scale checkout');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByRole('button', { name: 'Allow for this session' }).click();
  await expect.poll(() => sent).toContainEqual(
    expect.objectContaining({ type: 'action_decision', id: 'scale-once', approved: true, remember: true }),
  );

  await page.getByPlaceholder('Ask about resource…').fill('Scale checkout again');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Scale checkout to 3 replicas')).toBeVisible();
  await expect(page.getByText('(auto-approved — allowed for this session)')).toBeVisible();
});
