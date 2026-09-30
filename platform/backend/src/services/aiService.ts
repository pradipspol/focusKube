import { config } from '../config.js';
import { logError, logInfo } from '../util/logger.js';
import type { ClusterContext } from './aiContextService.js';
import { getEntitlementState, getLicenseKey } from '../runtime/aiLicenseStore.js';

/** Text content is the common case (plain user/assistant turns); the richer content-block
 * array shows up once a tool round has happened — an assistant's own `tool_use` block(s), or
 * the `tool_result` block a follow-up user turn carries back. Passed through to the relay
 * as-is (see llm/chatProvider.ts's ChatTurnMessage, which is Anthropic.MessageParam). */
export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export type ChatMessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
      | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
      // Mirrors Anthropic's own ImageBlockParam shape exactly (see llm/chatProvider.ts's
      // ChatTurnMessage = Anthropic.MessageParam on the relay) so it passes through the relay's
      // Anthropic path with zero transformation, same as the other block types above — only the
      // Azure OpenAI path (toOpenAiMessages) needs to know how to convert this one.
      | { type: 'image'; source: { type: 'base64'; media_type: ImageMediaType; data: string } }
    >;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ChatMessageContent;
}

export interface ChatTool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export interface ChatStreamChunk {
  type: 'token' | 'tool_use' | 'stop' | 'stopped' | 'error';
  data: any;
}

export class AiService {
  async sendChatToRelay(
    context: ClusterContext,
    messages: ChatMessage[],
    tools: ChatTool[],
    onChunk: (chunk: ChatStreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    // Checked by status, not just licenseKey presence — a stale/inactive license still has a
    // key string, and would otherwise reach the relay and only fail there with a generic 403.
    const entitlement = await getEntitlementState();
    if (!entitlement.licenseKey || entitlement.status !== 'active') {
      onChunk({ type: 'error', data: { code: 'NO_ENTITLEMENT', message: entitlement.error || 'No active AI plan' } });
      return;
    }
    const licenseKey = entitlement.licenseKey;

    try {
      const relayUrl = `${config.aiRelayBaseUrl}/v1/ai/chat`;

      const requestBody = {
        context,
        messages,
        tools,
        model: 'claude-sonnet-5',
        maxTokens: 2048,
      };

      const response = await fetch(relayUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${licenseKey}`,
        },
        body: JSON.stringify(requestBody),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError('ai_service.relay_error', {
          status: response.status,
          statusText: response.statusText,
          message: errorText.slice(0, 200),
        });
        // 403 here means the relay itself re-checked the license and found it inactive (e.g. it
        // expired in the moment between our own check above and this round-trip) — same code as
        // the upfront check, so the frontend reacts identically either way.
        const code = response.status === 403 ? 'NO_ENTITLEMENT' : response.status === 429 ? 'QUOTA_EXHAUSTED' : undefined;
        onChunk({
          type: 'error',
          data: {
            code,
            message:
              code === 'NO_ENTITLEMENT'
                ? 'No active AI plan'
                : code === 'QUOTA_EXHAUSTED'
                  ? 'AI usage quota exhausted'
                  : `Relay error: ${response.status} ${response.statusText}`,
          },
        });
        return;
      }

      // Handle streaming response
      if (!response.body) {
        onChunk({ type: 'error', data: { message: 'Empty response from relay' } });
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawTerminal = false;

      const handleDataLine = (dataStr: string): void => {
        if (dataStr === '[DONE]') {
          sawTerminal = true;
          onChunk({ type: 'stop', data: {} });
          return;
        }
        try {
          const data = JSON.parse(dataStr);
          if (data.type === 'token') {
            onChunk({ type: 'token', data: { token: data.token } });
          } else if (data.type === 'tool_use') {
            onChunk({ type: 'tool_use', data });
          } else if (data.type === 'error') {
            sawTerminal = true;
            onChunk({ type: 'error', data: { message: data.message ?? 'Relay error' } });
          }
        } catch (err) {
          logError('ai_service.parse_error', {
            error: err instanceof Error ? err.message : String(err),
            line: dataStr.slice(0, 100),
          });
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('data: ')) handleDataLine(line.slice(6));
          }
        }

        // Flush remaining buffer
        if (buffer.trim() && buffer.startsWith('data: ')) {
          handleDataLine(buffer.slice(6));
        }

        // The relay is expected to always terminate with a `[DONE]`/`error` marker. If the
        // connection dropped before either arrived, still unblock the caller rather than
        // leaving it waiting on a turn that will never finish.
        if (!sawTerminal) {
          onChunk({ type: 'error', data: { message: 'Relay connection closed unexpectedly' } });
        }
      } finally {
        reader.releaseLock();
      }
    } catch (err) {
      if (signal?.aborted) {
        // A deliberate Stop, not a failure — surfaced as its own chunk type so the caller
        // doesn't log or display it as an error.
        onChunk({ type: 'stopped', data: {} });
        return;
      }
      logError('ai_service.fetch_error', {
        error: err instanceof Error ? err.message : String(err),
      });
      onChunk({
        type: 'error',
        data: {
          message: err instanceof Error ? err.message : 'Unknown error',
        },
      });
    }
  }

  /** Backs the search_k8s_docs AI tool (aiToolExecutor.ts) — a plain JSON round-trip to the
   * relay's k8s-docs knowledge base, not a chat turn (no streaming, no quota reservation on
   * the relay side; see index.ts's /v1/ai/docs/search). */
  async searchDocs(query: string, k = 5): Promise<Array<{ url: string; title: string; heading: string | null; content: string; score: number }>> {
    const licenseKey = await getLicenseKey();
    if (!licenseKey) throw new Error('No license key configured');

    const response = await fetch(`${config.aiRelayBaseUrl}/v1/ai/docs/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${licenseKey}`,
      },
      body: JSON.stringify({ query, k }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Doc search failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText.slice(0, 200)}` : ''}`);
    }

    const body = (await response.json()) as { results?: Array<{ url: string; title: string; heading: string | null; content: string; score: number }> };
    return body.results ?? [];
  }
}

export const aiService = new AiService();
