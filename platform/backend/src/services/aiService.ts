import { config } from '../config.js';
import { logError, logInfo } from '../util/logger.js';
import type { ClusterContext } from './aiContextService.js';
import { getLicenseKey } from '../runtime/aiLicenseStore.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatStreamChunk {
  type: 'token' | 'tool_use' | 'stop' | 'error';
  data: any;
}

export class AiService {
  async sendChatToRelay(
    context: ClusterContext,
    messages: ChatMessage[],
    onChunk: (chunk: ChatStreamChunk) => void,
  ): Promise<void> {
    const licenseKey = await getLicenseKey();

    if (!licenseKey) {
      onChunk({ type: 'error', data: { message: 'No license key configured' } });
      return;
    }

    try {
      const relayUrl = `${config.aiRelayBaseUrl}/v1/ai/chat`;

      const requestBody = {
        context,
        messages,
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
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError('ai_service.relay_error', {
          status: response.status,
          statusText: response.statusText,
          message: errorText.slice(0, 200),
        });
        onChunk({
          type: 'error',
          data: {
            message: `Relay error: ${response.status} ${response.statusText}`,
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
}

export const aiService = new AiService();
