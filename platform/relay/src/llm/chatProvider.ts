import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config.js';

export interface ChatTurnMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatStreamEvent = { type: 'token'; token: string };

/**
 * Azure's newer /openai/v1/ API surface (GA since Aug 2025) drops the dated api-version
 * query param entirely and is reached with the plain OpenAI client — NOT the openai
 * package's AzureOpenAI subclass, which hard-requires apiVersion and targets the older
 * /openai/deployments/{deployment}?api-version=... shape instead (see its constructor).
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
 *
 * Accepts AZURE_OPENAI_ENDPOINT either as the bare resource root
 * (https://<resource>.openai.azure.com) or already carrying /openai/v1 (as Microsoft's own
 * docs show it inline as `base_url`) — idempotent either way, so a pasted-in full v1 URL
 * doesn't get /openai/v1/ appended a second time.
 */
function azureOpenAiV1BaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (/\/openai\/v1$/i.test(trimmed)) {
    return `${trimmed}/`;
  }
  return `${trimmed}/openai/v1/`;
}

// Constructed lazily, once, for whichever provider is actually configured — so a relay
// running in 'azure-openai' mode never needs ANTHROPIC_API_KEY set (and vice versa).
const anthropic = config.aiProvider === 'anthropic' ? new Anthropic() : null;
const azureOpenai =
  config.aiProvider === 'azure-openai'
    ? new OpenAI({
        apiKey: config.azureOpenai.apiKey,
        baseURL: azureOpenAiV1BaseUrl(config.azureOpenai.endpoint),
      })
    : null;

/**
 * Streams one chat turn from whichever provider AI_PROVIDER selects, emitting the same
 * reduced {type:'token'} shape either way — index.ts's /v1/ai/chat handler (and everything
 * downstream: platform/backend's aiService.ts, the frontend chat UI) never needs to know
 * which LLM actually answered.
 */
export async function streamChatTurn(
  systemPrompt: string,
  messages: ChatTurnMessage[],
  model: string,
  maxTokens: number,
  onToken: (event: ChatStreamEvent) => void,
): Promise<void> {
  if (config.aiProvider === 'azure-openai') {
    if (!azureOpenai) throw new Error('Azure OpenAI is not configured (AI_PROVIDER=azure-openai)');
    const stream = await azureOpenai.chat.completions.create({
      // Azure addresses models by deployment name — the request's own `model` (a Claude
      // model id from the old default) doesn't apply here.
      model: config.azureOpenai.deployment,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      // Current-generation models (gpt-5/o-series and newer) reject the legacy `max_tokens`
      // outright ("Unsupported parameter") and require `max_completion_tokens` instead.
      max_completion_tokens: maxTokens,
      // On a reasoning model, unconstrained effort can consume the entire token budget on
      // hidden reasoning before writing any visible answer — this is a chat assistant that
      // needs a timely textual reply, not deep multi-step research, so bias toward actually
      // producing output. Ignored (harmlessly) by non-reasoning deployments.
      reasoning_effort: 'low',
      stream: true,
    });
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (token) onToken({ type: 'token', token });
    }
    return;
  }

  if (!anthropic) throw new Error('Anthropic is not configured (AI_PROVIDER=anthropic)');
  const stream = anthropic.messages.stream({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages,
  });
  stream.on('text', (token) => onToken({ type: 'token', token }));
  await stream.finalMessage();
}
