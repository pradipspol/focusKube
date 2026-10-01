import OpenAI from 'openai';
import { config } from '../config.js';
import { azureOpenAiV1BaseUrl } from './chatProvider.js';
import { logDebug, logError, logInfo } from '../logger.js';

// Deliberately independent of `config.aiProvider` (which only picks the *chat* backend) —
// the k8s-docs knowledge base always embeds via Azure OpenAI regardless of which model
// answers chat, since Anthropic has no embeddings endpoint. Constructed lazily so a relay
// that hasn't configured this feature at all doesn't fail at import time.
const client =
  config.azureOpenai.apiKey && config.azureOpenai.endpoint
    ? new OpenAI({
        apiKey: config.azureOpenai.apiKey,
        baseURL: azureOpenAiV1BaseUrl(config.azureOpenai.endpoint),
      })
    : null;

// Comfortably under Azure OpenAI's per-request item cap — kept modest so one failed batch
// (rate limit, transient error) only costs re-embedding a small slice, not the whole corpus.
const EMBEDDING_BATCH_SIZE = 64;

export function embeddingsConfigured(): boolean {
  return !!client && !!config.azureOpenai.embeddingsDeployment;
}

/** Embeds a batch of texts in one or more Azure OpenAI calls, preserving input order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!client) {
    throw new Error('Azure OpenAI is not configured (AZURE_OPENAI_API_KEY/AZURE_OPENAI_ENDPOINT) — embeddings unavailable.');
  }
  if (!config.azureOpenai.embeddingsDeployment) {
    throw new Error('AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT is not set — provision an embeddings deployment in your Azure OpenAI resource and set that env var.');
  }
  if (texts.length === 0) return [];

  const startedAt = Date.now();
  const batchCount = Math.ceil(texts.length / EMBEDDING_BATCH_SIZE);
  logDebug('Starting text embedding request', { inputCount: texts.length, batchCount });
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
    const batchIndex = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;
    try {
      const res = await client.embeddings.create({
        model: config.azureOpenai.embeddingsDeployment,
        input: batch,
      });
      // Azure/OpenAI's response preserves request order via `index`, but sort explicitly rather
      // than trust array position alone.
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => d.embedding));
    } catch (error) {
      logError('Text embedding batch failed', error, { batchIndex, batchCount, inputCount: batch.length });
      throw error;
    }
  }
  logInfo('Text embedding request completed', {
    inputCount: texts.length,
    outputCount: out.length,
    batchCount,
    durationMs: Date.now() - startedAt,
  });
  return out;
}

export async function embedText(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text]);
  return vector;
}
