# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: ai-assistant.spec.ts >> expands and collapses a large tool response without losing its content
- Location: e2e\ai-assistant.spec.ts:416:1

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
  1   | import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
  2   | 
  3   | type OutboundMessage = { type: string; [key: string]: unknown };
  4   | 
  5   | async function mockAssistantApi(page: Page): Promise<void> {
  6   |   const sessions = new Map<string, { id: string; title: string; messages: unknown[]; updatedAt: number }>();
  7   |   await page.route('**/api/**', async (route) => {
  8   |     const url = new URL(route.request().url());
  9   |     const pathname = url.pathname;
  10  |     if (!pathname.startsWith('/api/')) {
  11  |       await route.fallback();
  12  |       return;
  13  |     }
  14  |     if (pathname === '/api/ai/entitlement') {
  15  |       await route.fulfill({ json: { enabled: true, plan: 'pro', status: 'active', quotaRemaining: 42 } });
  16  |       return;
  17  |     }
  18  |     if (pathname === '/api/resources/_kinds') {
  19  |       await route.fulfill({ json: [] });
  20  |       return;
  21  |     }
  22  |     if (pathname === '/api/ai/sessions') {
  23  |       await route.fulfill({ json: { sessions: [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt) } });
  24  |       return;
  25  |     }
  26  |     if (pathname.startsWith('/api/ai/sessions/')) {
  27  |       const segments = pathname.split('/');
  28  |       const id = decodeURIComponent(segments[4] ?? '');
  29  |       const key = `${url.searchParams.get('context') ?? 'default'}:${id}`;
  30  |       if (route.request().method() === 'DELETE') {
  31  |         sessions.delete(key);
  32  |         await route.fulfill({ status: 204 });
  33  |         return;
  34  |       }
  35  |       const body = route.request().postDataJSON() as { title: string; messages: unknown[] };
  36  |       if (route.request().method() === 'POST') {
  37  |         if (!sessions.has(key)) sessions.set(key, { id, ...body, updatedAt: Date.now() });
  38  |       } else {
  39  |         sessions.set(key, { id, ...body, updatedAt: Date.now() });
  40  |       }
  41  |       await route.fulfill({ json: sessions.get(key) });
  42  |       return;
  43  |     }
  44  |     await route.fulfill({ json: {} });
  45  |   });
  46  | }
  47  | 
  48  | async function mockAssistantSocket(
  49  |   page: Page,
  50  |   onMessage: (socket: WebSocketRoute, message: OutboundMessage) => void,
  51  | ): Promise<OutboundMessage[]> {
  52  |   const sent: OutboundMessage[] = [];
  53  |   await page.routeWebSocket('**/ws/ai*', (socket) => {
  54  |     socket.onMessage((raw) => {
  55  |       const message = JSON.parse(raw.toString()) as OutboundMessage;
  56  |       sent.push(message);
  57  |       if (message.type === 'restore_session') {
  58  |         socket.send(JSON.stringify({ type: 'session_restored', sessionId: message.sessionId }));
  59  |       }
  60  |       onMessage(socket, message);
  61  |     });
  62  |   });
  63  |   return sent;
  64  | }
  65  | 
  66  | async function openAssistant(page: Page): Promise<void> {
  67  |   await page.goto('/e2e/ai-assistant.html');
> 68  |   await expect(page.getByText('FocusKube AI Assistant')).toBeVisible();
      |                                                          ^ Error: expect(locator).toBeVisible() failed
  69  |   await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  70  | }
  71  | 
  72  | test.beforeEach(async ({ page }) => {
  73  |   await mockAssistantApi(page);
  74  | });
  75  | 
  76  | test('sends a prompt and renders a streamed Markdown answer incrementally', async ({ page }) => {
  77  |   const sent = await mockAssistantSocket(page, (socket, message) => {
  78  |     if (message.type === 'user_message') {
  79  |       socket.send(JSON.stringify({ type: 'token', token: '## Diagnosis\n\n' }));
  80  |       socket.send(JSON.stringify({ type: 'token', token: '**checkout-api** is healthy.' }));
  81  |       socket.send(JSON.stringify({ type: 'stop' }));
  82  |     }
  83  |   });
  84  |   await openAssistant(page);
  85  | 
  86  |   const input = page.getByPlaceholder('Ask about resource…');
  87  |   await input.fill('Is checkout healthy?');
  88  |   await page.getByRole('button', { name: 'Send' }).click();
  89  | 
  90  |   await expect(page.getByRole('paragraph').filter({ hasText: 'Is checkout healthy?' })).toBeVisible();
  91  |   await expect(page.getByRole('heading', { name: 'Diagnosis' })).toBeVisible();
  92  |   await expect(page.getByText('checkout-api', { exact: true })).toBeVisible();
  93  |   await expect.poll(() => sent).toContainEqual(expect.objectContaining({ type: 'user_message', text: 'Is checkout healthy?' }));
  94  |   await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  95  | });
  96  | 
  97  | test('submits a prompt with Enter and sends its text over the assistant socket', async ({ page }) => {
  98  |   const sent = await mockAssistantSocket(page, (socket, message) => {
  99  |     if (message.type === 'user_message') {
  100 |       socket.send(JSON.stringify({ type: 'token', token: 'I will check the cluster state.' }));
  101 |       socket.send(JSON.stringify({ type: 'stop' }));
  102 |     }
  103 |   });
  104 |   await openAssistant(page);
  105 | 
  106 |   const input = page.getByPlaceholder('Ask about resource…');
  107 |   await input.fill('Why is checkout unavailable?');
  108 |   await input.press('Enter');
  109 | 
  110 |   await expect(page.getByRole('paragraph').filter({ hasText: 'Why is checkout unavailable?' })).toBeVisible();
  111 |   await expect(page.getByText('I will check the cluster state.')).toBeVisible();
  112 |   await expect.poll(() => sent).toContainEqual(
  113 |     expect.objectContaining({ type: 'user_message', text: 'Why is checkout unavailable?' }),
  114 |   );
  115 | });
  116 | 
  117 | test('imports old browser history once and restores by backend session ID', async ({ page }) => {
  118 |   const sent = await mockAssistantSocket(page, () => undefined);
  119 |   await page.addInitScript(() => {
  120 |     localStorage.setItem(
  121 |       'k8sExplorer.aiChatSessions',
  122 |       JSON.stringify({
  123 |         activeSessionId: 'session-prior',
  124 |         sessions: [
  125 |           {
  126 |             id: 'session-prior',
  127 |             title: 'Earlier diagnosis',
  128 |             updatedAt: 1,
  129 |             messages: [
  130 |               { id: 'u1', kind: 'text', role: 'user', content: 'Why did checkout fail?' },
  131 |               { id: 'a1', kind: 'text', role: 'assistant', content: 'I found a failed readiness probe.' },
  132 |               { id: 't1', kind: 'tool', name: 'get_events', input: {}, status: 'done', output: 'Readiness probe failed' },
  133 |             ],
  134 |           },
  135 |         ],
  136 |       }),
  137 |     );
  138 |   });
  139 | 
  140 |   await openAssistant(page);
  141 | 
  142 |   await expect.poll(() => sent).toContainEqual(
  143 |     expect.objectContaining({
  144 |       type: 'restore_session',
  145 |       sessionId: 'session-prior',
  146 |     }),
  147 |   );
  148 |   expect(sent.find((message) => message.type === 'restore_session')).not.toHaveProperty('history');
  149 |   await expect.poll(() => page.evaluate(() => localStorage.getItem('k8sExplorer.aiChatSessions'))).toBeNull();
  150 | });
  151 | 
  152 | test('shows a session restore error instead of remaining in the connecting state', async ({ page }) => {
  153 |   await mockAssistantSocket(page, (socket, message) => {
  154 |     if (message.type === 'restore_session') {
  155 |       socket.send(JSON.stringify({ type: 'error', message: 'Chat session not found.' }));
  156 |     }
  157 |   });
  158 |   await openAssistant(page);
  159 | 
  160 |   await expect(page.getByText('Chat session not found.')).toBeVisible();
  161 |   await expect(page.getByText('Connecting to the AI assistant…')).toHaveCount(0);
  162 | });
  163 | 
  164 | test('shows a stream error and allows the user to try another prompt', async ({ page }) => {
  165 |   const sent = await mockAssistantSocket(page, (socket, message) => {
  166 |     if (message.type === 'user_message') {
  167 |       socket.send(JSON.stringify({ type: 'error', message: 'AI provider temporarily unavailable' }));
  168 |     }
```