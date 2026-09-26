import { Collection } from '../db/localStore.js';
import type { ChatMessage } from './aiService.js';

export interface AiChatTranscriptMessage {
  id: string;
  kind: 'text' | 'tool' | 'action';
  [key: string]: unknown;
}

export interface AiChatSessionDoc {
  id: string;
  userId: string;
  context: string;
  title: string;
  messages: AiChatTranscriptMessage[];
  modelMessages: ChatMessage[];
  checkpoints: Array<{ turnId: string; index: number }>;
  updatedAt: number;
}

interface SessionCollection {
  find(predicate?: (doc: AiChatSessionDoc) => boolean): AiChatSessionDoc[];
  findOne(predicate: (doc: AiChatSessionDoc) => boolean): AiChatSessionDoc | undefined;
  insertOne(doc: AiChatSessionDoc): AiChatSessionDoc;
  updateOne(predicate: (doc: AiChatSessionDoc) => boolean, patch: Partial<AiChatSessionDoc>): AiChatSessionDoc | undefined;
  deleteOne(predicate: (doc: AiChatSessionDoc) => boolean): boolean;
  deleteMany(predicate: (doc: AiChatSessionDoc) => boolean): number;
}

const MAX_SESSIONS_PER_USER = 50;
const MAX_TRANSCRIPT_CHARS = 4_000_000;
const MAX_MODEL_HISTORY_CHARS = 500_000;

function isToolResultMessage(message: ChatMessage): boolean {
  return message.role === 'user' && Array.isArray(message.content) && message.content.some((block) => block.type === 'tool_result');
}

function boundedHistory(messages: ChatMessage[]): { messages: ChatMessage[]; removed: number } {
  const turns: ChatMessage[][] = [];
  for (const message of messages) {
    if (message.role === 'user' && !isToolResultMessage(message) && turns.length > 0) turns.push([]);
    if (turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }

  let removed = 0;
  let bounded = turns.flat();
  let serializedLength = JSON.stringify(bounded).length;
  while (turns.length > 0 && serializedLength > MAX_MODEL_HISTORY_CHARS) {
    removed += turns.shift()!.length;
    bounded = turns.flat();
    serializedLength = JSON.stringify(bounded).length;
  }
  return { messages: bounded, removed };
}

export class AiChatSessionStore {
  constructor(private readonly collection: SessionCollection) {}

  list(userId: string, context: string): AiChatSessionDoc[] {
    return this.collection
      .find((doc) => doc.userId === userId && doc.context === context)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_SESSIONS_PER_USER);
  }

  get(userId: string, id: string, context: string): AiChatSessionDoc | undefined {
    return this.collection.findOne((doc) => doc.userId === userId && doc.id === id && doc.context === context);
  }

  saveTranscript(userId: string, context: string, id: string, title: string, messages: AiChatTranscriptMessage[]): AiChatSessionDoc {
    if (JSON.stringify(messages).length > MAX_TRANSCRIPT_CHARS) {
      throw new Error('Chat transcript is too large.');
    }
    const existing = this.get(userId, id, context);
    const updated: AiChatSessionDoc = {
      id,
      userId,
      context,
      title: title.slice(0, 120),
      messages,
      modelMessages: existing?.modelMessages ?? [],
      checkpoints: existing?.checkpoints ?? [],
      updatedAt: Date.now(),
    };
    if (existing) {
      this.collection.updateOne((doc) => doc.userId === userId && doc.id === id && doc.context === context, updated);
    } else {
      this.collection.insertOne(updated);
    }
    this.prune(userId, context);
    return updated;
  }

  importSession(
    userId: string,
    context: string,
    id: string,
    title: string,
    messages: AiChatTranscriptMessage[],
    modelMessages: ChatMessage[],
  ): AiChatSessionDoc {
    const existing = this.get(userId, id, context);
    if (existing) return existing;
    const created = this.saveTranscript(userId, context, id, title, messages);
    return this.saveModelHistory(userId, context, id, modelMessages, []) ?? created;
  }

  saveModelHistory(
    userId: string,
    context: string,
    id: string,
    modelMessages: ChatMessage[],
    checkpoints: Array<{ turnId: string; index: number }>,
  ): AiChatSessionDoc | undefined {
    const existing = this.get(userId, id, context);
    if (!existing) return undefined;
    const bounded = boundedHistory(modelMessages);
    const adjustedCheckpoints = checkpoints
      .filter((checkpoint) => checkpoint.index >= bounded.removed && checkpoint.index - bounded.removed < bounded.messages.length)
      .map((checkpoint) => ({ ...checkpoint, index: checkpoint.index - bounded.removed }));
    return this.collection.updateOne((doc) => doc.userId === userId && doc.id === id && doc.context === context, {
      modelMessages: bounded.messages,
      checkpoints: adjustedCheckpoints,
      updatedAt: Date.now(),
    });
  }

  delete(userId: string, context: string, id: string): boolean {
    return this.collection.deleteOne((doc) => doc.userId === userId && doc.id === id && doc.context === context);
  }

  private prune(userId: string, context: string): void {
    const sessions = this.collection
      .find((doc) => doc.userId === userId && doc.context === context)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const keep = new Set(sessions.slice(0, MAX_SESSIONS_PER_USER).map((session) => session.id));
    this.collection.deleteMany((doc) => doc.userId === userId && doc.context === context && !keep.has(doc.id));
  }
}

export const aiChatSessionStore = new AiChatSessionStore(
  new Collection<AiChatSessionDoc>('ai-chat-sessions.json'),
);