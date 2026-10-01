import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

const sessions = new Map<string, {
  id: string;
  userId: string;
  context: string;
  title: string;
  messages: unknown[];
  modelMessages: unknown[];
  checkpoints: Array<{ turnId: string; index: number }>;
  updatedAt: number;
}>();
const sessionKey = (userId: string, context: string, id: string) => `${userId}:${context}:${id}`;

mock.module('../services/aiChatSessionStore.js', {
  namedExports: {
    aiChatSessionStore: {
      list: (userId: string, context: string) =>
        [...sessions.values()].filter((session) => session.userId === userId && session.context === context),
      saveTranscript: (userId: string, context: string, id: string, title: string, messages: unknown[]) => {
        const session = { id, userId, context, title, messages, modelMessages: [], checkpoints: [], updatedAt: Date.now() };
        sessions.set(sessionKey(userId, context, id), session);
        return session;
      },
      importSession: () => undefined,
      delete: (userId: string, context: string, id: string) => sessions.delete(sessionKey(userId, context, id)),
    },
  },
});

const { aiRouter } = await import('./ai.js');

function app(userId = 'test-user', activeContext = 'ctx-active') {
  return buildTestApp('/api/ai', aiRouter, {
    authUser: makeTestAuthUser({ id: userId }),
    session: { userId, activeContext } as any,
  });
}

test('AI sessions require authentication and are isolated by user and context', async () => {
  sessions.clear();
  const transcript = [{ id: 'message-1', kind: 'text', text: 'Question' }];

  const unauthenticated = buildTestApp('/api/ai', aiRouter, { authUser: null });
  assert.equal((await request(unauthenticated).get('/api/ai/sessions')).status, 401);

  const saved = await request(app()).put('/api/ai/sessions/session-1?context=cluster-a').send({ title: 'Chat', messages: transcript });
  assert.equal(saved.status, 200);
  const sameScope = await request(app()).get('/api/ai/sessions?context=cluster-a');
  const otherContext = await request(app()).get('/api/ai/sessions?context=cluster-b');
  const otherUser = await request(app('another-user')).get('/api/ai/sessions?context=cluster-a');
  assert.equal(sameScope.body.sessions.length, 1);
  assert.equal(otherContext.body.sessions.length, 0);
  assert.equal(otherUser.body.sessions.length, 0);
});

test('AI sessions recover a missing transcript from saved model history', async () => {
  sessions.clear();
  await request(app()).put('/api/ai/sessions/session-recovery?context=minikube').send({ title: 'Recovered chat', messages: [] });
  const stored = sessions.get(sessionKey('test-user', 'minikube', 'session-recovery'))!;
  stored.modelMessages = [
    { role: 'user', content: 'Why is this pod pending?' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'get_events', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Pod scheduled' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The pod is waiting for a node.' }] },
  ];
  stored.checkpoints = [{ turnId: 'turn-pending', index: 0 }];

  const response = await request(app()).get('/api/ai/sessions?context=minikube');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.sessions[0].messages, [
    {
      id: 'recovered-session-recovery-0',
      kind: 'text',
      role: 'user',
      content: 'Why is this pod pending?',
      turnId: 'turn-pending',
    },
    {
      id: 'recovered-session-recovery-3',
      kind: 'text',
      role: 'assistant',
      content: 'The pod is waiting for a node.',
    },
  ]);
});