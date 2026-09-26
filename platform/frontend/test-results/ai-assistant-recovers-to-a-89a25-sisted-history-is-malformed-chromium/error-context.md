# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ai-assistant.spec.ts >> recovers to a fresh chat when persisted history is malformed
- Location: e2e\ai-assistant.spec.ts:373:1

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('FocusKube AI Assistant')
Expected: visible
Error: strict mode violation: getByText('FocusKube AI Assistant') resolved to 2 elements:
    1) <span class="ai-dock-title">FocusKube AI Assistant</span> aka getByText('FocusKube AI Assistant', { exact: true })
    2) <div class="ai-panel-empty">FocusKube AI Assistant is ready to help you diagn…</div> aka getByText('FocusKube AI Assistant is')

Call log:
  - Expect "toBeVisible" getByText('FocusKube AI Assistant') with timeout 5000ms
  - waiting for getByText('FocusKube AI Assistant')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]: FocusKube AI Assistant
    - generic [ref=e6]:
      - button "New chat" [ref=e7] [cursor=pointer]: +
      - button "Chat history" [ref=e8] [cursor=pointer]: 🕘
      - button "Close AI Assistant" [ref=e9] [cursor=pointer]: ✕
  - generic [ref=e10]:
    - generic [ref=e12]:
      - generic [ref=e13]: "Plan: pro"
      - generic [ref=e14]:
        - text: "Quota remaining: 42"
        - generic "Each AI lookup (reading logs, resources, events, etc.) uses 1 unit — a question that needs several lookups before answering uses more than 1, even though it's a single message." [ref=e15]: ⓘ
    - generic [ref=e17]:
      - generic [ref=e18]: FocusKube AI Assistant is ready to help you diagnose issues and suggest fixes for your cluster resources.
      - generic [ref=e19]: Connecting to the AI assistant…
      - generic [ref=e21]:
        - textbox "Ask about resource…" [ref=e22]
        - generic [ref=e23]:
          - generic [ref=e24]:
            - button "Attach image" [ref=e25] [cursor=pointer]
            - button "Skills" [ref=e30] [cursor=pointer]
          - button "Send" [disabled] [ref=e33]
```

# Test source

```ts
  278 |   ['Namespaces', 'List the namespaces in this cluster'],
  279 |   ['Recent events', 'Show me the most recent warning events'],
  280 |   ['Logs', 'Summarize any errors from recent logs'],
  281 |   ['Storage', 'What persistent volumes and claims exist'],
  282 |   ['Security', 'Are any pods running as root, privileged'],
  283 | ] as const;
  284 | 
  285 | for (const [skill, expectedPrompt] of skillPrompts) {
  286 |   test(`puts the ${skill.toLowerCase()} skill prompt in the composer`, async ({ page }) => {
  287 |     const sent = await mockAssistantSocket(page, (socket, message) => {
  288 |       if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  289 |     });
  290 |     await openAssistant(page);
  291 | 
  292 |     await page.getByRole('button', { name: 'Skills' }).click();
  293 |     await page.getByRole('button', { name: skill }).click();
  294 |     const input = page.getByPlaceholder('Ask about resource…');
  295 |     await expect.poll(() => input.inputValue()).toContain(expectedPrompt);
  296 |     await page.getByRole('button', { name: 'Send' }).click();
  297 |     await expect.poll(() => sent).toContainEqual(expect.objectContaining({ type: 'user_message', text: expect.stringContaining(expectedPrompt) }));
  298 |   });
  299 | }
  300 | 
  301 | test('keeps Shift+Enter in the draft instead of submitting the message', async ({ page }) => {
  302 |   const sent = await mockAssistantSocket(page, () => undefined);
  303 |   await openAssistant(page);
  304 | 
  305 |   const input = page.getByPlaceholder('Ask about resource…');
  306 |   await input.fill('Check the pod status');
  307 |   await input.press('Shift+Enter');
  308 | 
  309 |   await expect(input).toHaveValue('Check the pod status\n');
  310 |   expect(sent.filter((message) => message.type === 'user_message')).toHaveLength(0);
  311 |   await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
  312 | });
  313 | 
  314 | test('restores backend chat history across reload and supports editing a sent turn', async ({ page }) => {
  315 |   const sent = await mockAssistantSocket(page, (socket, message) => {
  316 |     if (message.type === 'user_message' || message.type === 'edit_message') {
  317 |       socket.send(JSON.stringify({ type: 'token', token: 'The pod is pending.' }));
  318 |       socket.send(JSON.stringify({ type: 'stop' }));
  319 |     }
  320 |   });
  321 |   await openAssistant(page);
  322 |   await expect(page.locator('.ai-gate-session-title')).toHaveCount(0);
  323 | 
  324 |   const saveResponse = page.waitForResponse((response) =>
  325 |     response.url().includes('/api/ai/sessions/') &&
  326 |     response.request().method() === 'PUT' &&
  327 |     response.ok() &&
  328 |     response.request().postDataJSON()?.messages?.some((message: { content?: string }) => message.content === 'Why is api-0 pending?'),
  329 |   );
  330 |   await page.getByPlaceholder('Ask about resource…').fill('Why is api-0 pending?');
  331 |   await page.getByRole('button', { name: 'Send' }).click();
  332 |   await expect(page.getByText('The pod is pending.')).toBeVisible();
  333 |   await saveResponse;
  334 | 
  335 |   await page.reload();
  336 |   await expect(page.getByRole('paragraph').filter({ hasText: 'Why is api-0 pending?' })).toBeVisible();
  337 |   await expect(page.locator('.ai-gate-session-title')).toHaveText('Why is api-0 pending?');
  338 |   await page.getByRole('button', { name: 'Edit' }).click();
  339 |   await page.locator('.ai-message-edit-input').fill('Why is api-1 pending?');
  340 |   await page.getByRole('button', { name: 'Save' }).click();
  341 | 
  342 |   await expect.poll(() => sent).toContainEqual(
  343 |     expect.objectContaining({ type: 'edit_message', text: 'Why is api-1 pending?' }),
  344 |   );
  345 | });
  346 | 
  347 | test('starts a separate chat, reopens a saved session, and deletes it from history', async ({ page }) => {
  348 |   await mockAssistantSocket(page, (socket, message) => {
  349 |     if (message.type === 'user_message') {
  350 |       socket.send(JSON.stringify({ type: 'token', token: 'Saved response.' }));
  351 |       socket.send(JSON.stringify({ type: 'stop' }));
  352 |     }
  353 |   });
  354 |   await openAssistant(page);
  355 | 
  356 |   await page.getByPlaceholder('Ask about resource…').fill('Inspect checkout deployment');
  357 |   await page.getByRole('button', { name: 'Send' }).click();
  358 |   await expect(page.getByText('Saved response.')).toBeVisible();
  359 |   await page.getByRole('button', { name: 'New chat' }).click();
  360 |   await expect(page.getByText('Inspect checkout deployment')).toHaveCount(0);
  361 | 
  362 |   await page.getByRole('button', { name: 'Chat history' }).click();
  363 |   const savedSession = page.getByRole('button', { name: /Inspect checkout deployment/ });
  364 |   await expect(savedSession).toBeVisible();
  365 |   await savedSession.click();
  366 |   await expect(page.getByRole('paragraph').filter({ hasText: 'Inspect checkout deployment' })).toBeVisible();
  367 | 
  368 |   await page.getByRole('button', { name: 'Chat history' }).click();
  369 |   await page.getByRole('button', { name: /Inspect checkout deployment/ }).getByLabel('Delete chat').click();
  370 |   await expect(page.getByRole('button', { name: /Inspect checkout deployment/ })).toHaveCount(0);
  371 | });
  372 | 
  373 | test('recovers to a fresh chat when persisted history is malformed', async ({ page }) => {
  374 |   await page.addInitScript(() => localStorage.setItem('k8sExplorer.aiChatSessions', '{invalid json'));
  375 |   await mockAssistantSocket(page, () => undefined);
  376 |   await page.goto('/e2e/ai-assistant.html');
  377 | 
> 378 |   await expect(page.getByText('FocusKube AI Assistant')).toBeVisible();
      |                                                          ^ Error: expect(locator).toBeVisible() failed
  379 |   await expect(page.getByPlaceholder('Ask about resource…')).toBeEnabled();
  380 | });
  381 | 
  382 | test('renders completed read-tool output on demand and identifies tool errors', async ({ page }) => {
  383 |   await mockAssistantSocket(page, (socket, message) => {
  384 |     if (message.type === 'user_message') {
  385 |       socket.send(JSON.stringify({ type: 'tool_call', id: 'get-pods', name: 'list_pods', input: { namespace: 'payments' } }));
  386 |       socket.send(JSON.stringify({
  387 |         type: 'tool_result',
  388 |         id: 'get-pods',
  389 |         name: 'list_pods',
  390 |         output: JSON.stringify([{ name: 'checkout-0', phase: 'Running' }]),
  391 |         isError: false,
  392 |       }));
  393 |       socket.send(JSON.stringify({ type: 'tool_call', id: 'get-events', name: 'list_events', input: { namespace: 'payments' } }));
  394 |       socket.send(JSON.stringify({
  395 |         type: 'tool_result',
  396 |         id: 'get-events',
  397 |         name: 'list_events',
  398 |         output: 'Forbidden: cannot list events',
  399 |         isError: true,
  400 |       }));
  401 |       socket.send(JSON.stringify({ type: 'stop' }));
  402 |     }
  403 |   });
  404 |   await openAssistant(page);
  405 | 
  406 |   await page.getByPlaceholder('Ask about resource…').fill('Inspect pods and recent events');
  407 |   await page.getByRole('button', { name: 'Send' }).click();
  408 |   const showOutput = page.getByRole('button', { name: /Show output/ });
  409 |   await expect(showOutput).toHaveCount(2);
  410 |   await showOutput.first().click();
  411 |   await expect(page.getByText('checkout-0')).toBeVisible();
  412 |   await page.getByRole('button', { name: /Show output/ }).click();
  413 |   await expect(page.getByText('Forbidden: cannot list events')).toBeVisible();
  414 | });
  415 | 
  416 | test('expands and collapses a large tool response without losing its content', async ({ page }) => {
  417 |   const longOutput = Array.from({ length: 45 }, (_, index) => `event-${index + 1}`).join('\n');
  418 |   await mockAssistantSocket(page, (socket, message) => {
  419 |     if (message.type === 'user_message') {
  420 |       socket.send(JSON.stringify({ type: 'tool_call', id: 'long-events', name: 'list_events', input: {} }));
  421 |       socket.send(JSON.stringify({ type: 'tool_result', id: 'long-events', name: 'list_events', output: longOutput, isError: false }));
  422 |       socket.send(JSON.stringify({ type: 'stop' }));
  423 |     }
  424 |   });
  425 |   await openAssistant(page);
  426 | 
  427 |   await page.getByPlaceholder('Ask about resource…').fill('Show all recent events');
  428 |   await page.getByRole('button', { name: 'Send' }).click();
  429 |   await page.getByRole('button', { name: /Show output/ }).click();
  430 |   const expand = page.getByRole('button', { name: /Show \d+ more lines/ });
  431 |   await expect(expand).toBeVisible();
  432 |   await expand.click();
  433 |   await expect(page.locator('.ai-tool-output code')).toContainText('event-45');
  434 |   await page.getByRole('button', { name: 'Show less' }).click();
  435 |   await expect(page.getByRole('button', { name: /Show \d+ more lines/ })).toBeVisible();
  436 | });
  437 | 
  438 | test('attaches and serializes a supported image with the user message', async ({ page }) => {
  439 |   const sent = await mockAssistantSocket(page, (socket, message) => {
  440 |     if (message.type === 'user_message') socket.send(JSON.stringify({ type: 'stop' }));
  441 |   });
  442 |   await openAssistant(page);
  443 | 
  444 |   const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64');
  445 |   await page.locator('input[type="file"]').setInputFiles({ name: 'pod.png', mimeType: 'image/png', buffer: png });
  446 |   await expect(page.locator('.ai-attached-image-thumb img')).toHaveCount(1);
  447 |   await page.getByPlaceholder('Ask about resource…').fill('What is shown in this screenshot?');
  448 |   await page.getByRole('button', { name: 'Send' }).click();
  449 | 
  450 |   await expect.poll(() => sent).toContainEqual(
  451 |     expect.objectContaining({
  452 |       type: 'user_message',
  453 |       text: 'What is shown in this screenshot?',
  454 |       images: [expect.objectContaining({ mediaType: 'image/jpeg', data: expect.any(String) })],
  455 |     }),
  456 |   );
  457 | });
  458 | 
  459 | test('enforces the per-message image limit and allows removing an attachment', async ({ page }) => {
  460 |   await mockAssistantSocket(page, () => undefined);
  461 |   await openAssistant(page);
  462 | 
  463 |   const image = {
  464 |     name: 'pod.png',
  465 |     mimeType: 'image/png',
  466 |     buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=', 'base64'),
  467 |   };
  468 |   const chooser = page.locator('input[type="file"]');
  469 |   await chooser.setInputFiles([image, image, image]);
  470 |   await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  471 |   await expect(page.getByRole('button', { name: 'Attach image' })).toBeDisabled();
  472 | 
  473 |   await page.getByRole('button', { name: 'Remove image' }).first().click();
  474 |   await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(2);
  475 |   await expect(page.getByRole('button', { name: 'Attach image' })).toBeEnabled();
  476 |   await chooser.setInputFiles(image);
  477 |   await expect(page.locator('.ai-attached-image-thumb')).toHaveCount(3);
  478 |   await chooser.setInputFiles(image);
```