import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import 'express-async-errors';
import { buildTestApp, makeTestAuthUser } from '../testUtils/testApp.js';

const sessions = new Map<string, { id: string; userId: string; context: string; title: string; messages: unknown[]; updatedAt: number }>();
const sessionKey = (userId: string, context: string, id: string) => `${userId}:${context}:${id}`;

mock.module('../services/aiChatSessionStore.js', {
  namedExports: {
    aiChatSessionStore: {
      list: (userId: string, context: string) =>
        [...sessions.values()].filter((session) => session.userId === userId && session.context === context),
      saveTranscript: (userId: string, context: string, id: string, title: string, messages: unknown[]) => {
        const session = { id, userId, context, title, messages, updatedAt: Date.now() };
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