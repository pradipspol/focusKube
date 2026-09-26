import test from 'node:test';
import assert from 'node:assert/strict';
import { AiChatSessionStore, type AiChatSessionDoc } from './aiChatSessionStore.js';
import type { ChatMessage } from './aiService.js';

class MemoryCollection {
  docs: AiChatSessionDoc[] = [];

  find(predicate?: (doc: AiChatSessionDoc) => boolean): AiChatSessionDoc[] {
    return predicate ? this.docs.filter(predicate) : [...this.docs];
  }

  findOne(predicate: (doc: AiChatSessionDoc) => boolean): AiChatSessionDoc | undefined {
    return this.docs.find(predicate);
  }

  insertOne(doc: AiChatSessionDoc): AiChatSessionDoc {
    this.docs.push(doc);
    return doc;
  }

  updateOne(predicate: (doc: AiChatSessionDoc) => boolean, patch: Partial<AiChatSessionDoc>): AiChatSessionDoc | undefined {
    const doc = this.docs.find(predicate);
    if (doc) Object.assign(doc, patch);
    return doc;
  }

  deleteOne(predicate: (doc: AiChatSessionDoc) => boolean): boolean {
    const index = this.docs.findIndex(predicate);
    if (index < 0) return false;
    this.docs.splice(index, 1);
    return true;
  }

  deleteMany(predicate: (doc: AiChatSessionDoc) => boolean): number {
    const before = this.docs.length;
    this.docs = this.docs.filter((doc) => !predicate(doc));
    return before - this.docs.length;
  }
}

test('session records are isolated by user and cluster context and imports are idempotent', () => {
  const store = new AiChatSessionStore(new MemoryCollection());
  const transcript = [{ id: 'message-1', kind: 'text' as const, text: 'Hello' }];
  const modelMessages: ChatMessage[] = [{ role: 'user', content: 'Hello' }];

  store.importSession('user-a', 'cluster-a', 'session-1', 'First', transcript, modelMessages);
  store.importSession('user-a', 'cluster-a', 'session-1', 'Replacement', [], []);
  store.importSession('user-a', 'cluster-b', 'session-1', 'Other cluster', [], []);
  store.importSession('user-b', 'cluster-a', 'session-1', 'Other user', [], []);

  assert.equal(store.list('user-a', 'cluster-a').length, 1);
  assert.equal(store.get('user-a', 'session-1', 'cluster-a')?.title, 'First');
  assert.equal(store.get('user-a', 'session-1', 'cluster-b')?.title, 'Other cluster');
  assert.equal(store.get('user-b', 'session-1', 'cluster-a')?.title, 'Other user');
  assert.equal(store.delete('user-a', 'cluster-a', 'session-1'), true);
  assert.equal(store.get('user-a', 'session-1', 'cluster-a'), undefined);
  assert.equal(store.get('user-a', 'session-1', 'cluster-b')?.title, 'Other cluster');
});

test('model history trimming drops whole turns and rebases edit checkpoints', () => {
  const store = new AiChatSessionStore(new MemoryCollection());
  store.saveTranscript('user-a', 'cluster-a', 'session-1', 'Long chat', []);
  const content = 'x'.repeat(120_000);
  const messages: ChatMessage[] = [
    { role: 'user', content },
    { role: 'assistant', content },
    { role: 'user', content },
    { role: 'assistant', content },
    { role: 'user', content },
    { role: 'assistant', content },
  ];

  const saved = store.saveModelHistory('user-a', 'cluster-a', 'session-1', messages, [
    { turnId: 'turn-1', index: 0 },
    { turnId: 'turn-2', index: 2 },
    { turnId: 'turn-3', index: 4 },
  ]);

  assert.deepEqual(saved?.modelMessages, messages.slice(2));
  assert.deepEqual(saved?.checkpoints, [
    { turnId: 'turn-2', index: 0 },
    { turnId: 'turn-3', index: 2 },
  ]);
});