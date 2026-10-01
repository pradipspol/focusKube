import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { config } from '../config.js';
import { logDebug, logError, logInfo } from '../logger.js';

export type ChatTurnMessage = Anthropic.MessageParam;

export type ChatStreamEvent =
  | { type: 'token'; token: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

export type ChatTool = Anthropic.Tool;

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
export function azureOpenAiV1BaseUrl(endpoint: string): string {
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

/** Anthropic's {name, description, input_schema} tool shape, repackaged as an OpenAI
 * function-calling tool. Both describe parameters with plain JSON Schema, so this is a
 * reshape, not a translation. */
function toOpenAiTools(tools: ChatTool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

/** Converts Anthropic-shaped turns (plain text, or content-block arrays carrying text /
 * tool_use / tool_result) to OpenAI's chat message shape. The two providers disagree on where
 * a tool round's results live: Anthropic batches every tool_result for a turn into one user
 * message, while OpenAI wants each as its own standalone `role: 'tool'` message, and an
 * assistant's tool_use blocks become that message's `tool_calls` instead of inline content. */
function toOpenAiMessages(
  systemPrompt: string,
  messages: ChatTurnMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];

  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    if (m.role === 'user') {
      // Usually just tool_result blocks (backend's ws/streams.ts), each becoming its own
      // tool-role message — OpenAI has no batched equivalent of Anthropic's one-user-turn-per-
      // round. A turn can also carry a trailing `text` block alongside those (e.g. streams.ts's
      // nudge asking the model to explain a tool result it silently skipped over) — OpenAI has
      // no "text" part of a tool-role message, so that becomes its own follow-up user message
      // after all of this round's tool messages, same net effect as Anthropic's single combined
      // turn. Dropping it here (as this used to) means an appended instruction never reaches
      // the model at all, silently.
      let trailingText = '';
      const imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[] = [];
      for (const block of m.content) {
        if (block.type === 'tool_result') {
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
          });
        } else if (block.type === 'text') {
          trailingText += block.text;
        } else if (block.type === 'image' && block.source.type === 'base64') {
          // Anthropic keeps media_type/data as separate fields; OpenAI wants one data URL.
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
          });
        }
      }
      if (imageParts.length > 0) {
        // At least one image in this turn — OpenAI takes mixed text+image content as one
        // message's content-part array, unlike Anthropic's separate blocks, so text and images
        // combine into a single user message here instead of trailingText's usual standalone one.
        out.push({
          role: 'user',
          content: [...(trailingText ? [{ type: 'text' as const, text: trailingText }] : []), ...imageParts],
        });
      } else if (trailingText) {
        out.push({ role: 'user', content: trailingText });
      }
      continue;
    }

    let text = '';
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    for (const block of m.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        });
      }
    }
    out.push({
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });
  }

  return out;
}

/**
 * Streams one chat turn from whichever provider AI_PROVIDER selects, emitting the same
 * reduced {type:'token'|'tool_use'} shape either way — index.ts's /v1/ai/chat handler (and
 * everything downstream: platform/backend's aiService.ts, the frontend chat UI) never needs to
 * know which LLM actually answered, or which one is running tools.
 */
export async function streamChatTurn(
  systemPrompt: string,
  messages: ChatTurnMessage[],
  model: string,
  maxTokens: number,
  tools: ChatTool[],
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  const requestDetails = { provider: config.aiProvider, model, messageCount: messages.length, toolCount: tools.length };
  logDebug('Starting LLM streaming request', requestDetails);

  if (config.aiProvider === 'azure-openai') {
    if (!azureOpenai) throw new Error('Azure OpenAI is not configured (AI_PROVIDER=azure-openai)');
    const openAiTools = tools.length > 0 ? toOpenAiTools(tools) : undefined;
    try {
      const stream = await azureOpenai.chat.completions.create(
        {
          // Azure addresses models by deployment name — the request's own `model` (a Claude
          // model id from the old default) doesn't apply here.
          model: config.azureOpenai.deployment,
          messages: toOpenAiMessages(systemPrompt, messages),
          // Current-generation models (gpt-5/o-series and newer) reject the legacy `max_tokens`
          // outright ("Unsupported parameter") and require `max_completion_tokens` instead.
          max_completion_tokens: maxTokens,
          // On a reasoning model, unconstrained effort can consume the entire token budget on
          // hidden reasoning before writing any visible answer — this is a chat assistant that
          // needs a timely textual reply, not deep multi-step research, so bias toward actually
          // producing output. Ignored (harmlessly) by non-reasoning deployments.
          reasoning_effort: 'low',
          stream: true,
          ...(openAiTools ? { tools: openAiTools, tool_choice: 'auto' as const } : {}),
        },
        { signal },
      );

      // A streamed tool call's arguments arrive as JSON text fragments across many chunks,
      // keyed only by their position (`delta.tool_calls[].index`) — id/name show up once, on
      // the first fragment for that index, so they're captured defensively on every fragment
      // in case a provider ever splits them too. Only assembled into a real tool_use event once
      // the stream ends, mirroring the Anthropic branch's own wait for `finalMessage()` below.
      const toolCalls = new Map<number, { id: string; name: string; argsText: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) onEvent({ type: 'token', token: delta.content });
        for (const call of delta.tool_calls ?? []) {
          const existing = toolCalls.get(call.index);
          if (existing) {
            if (call.id) existing.id ||= call.id;
            if (call.function?.name) existing.name ||= call.function.name;
            if (call.function?.arguments) existing.argsText += call.function.arguments;
          } else {
            toolCalls.set(call.index, {
              id: call.id ?? `call-${call.index}`,
              name: call.function?.name ?? '',
              argsText: call.function?.arguments ?? '',
            });
          }
        }
      }

      for (const { id, name, argsText } of toolCalls.values()) {
        if (!name) continue;
        let input: unknown = {};
        try {
          input = argsText ? JSON.parse(argsText) : {};
        } catch {
          // Malformed JSON from the model — surface an empty input rather than crashing the
          // turn; the tool executor's own required-field checks reject it with a clear error
          // the model can see and correct on its next call.
        }
        onEvent({ type: 'tool_use', id, name, input });
      }
      logInfo('LLM streaming request completed', {
        ...requestDetails,
        durationMs: Date.now() - startedAt,
        toolCallCount: toolCalls.size,
      });
      return;
    } catch (error) {
      logError('Azure OpenAI streaming request failed', error, {
        ...requestDetails,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  if (!anthropic) throw new Error('Anthropic is not configured (AI_PROVIDER=anthropic)');
  try {
    const stream = anthropic.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages,
        tools: tools.length > 0 ? tools : undefined,
      },
      { signal },
    );
    stream.on('text', (token) => onEvent({ type: 'token', token }));
    const finalMessage = await stream.finalMessage();
    let toolCallCount = 0;
    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        toolCallCount += 1;
        onEvent({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    logInfo('LLM streaming request completed', {
      ...requestDetails,
      durationMs: Date.now() - startedAt,
      toolCallCount,
    });
  } catch (error) {
    logError('Anthropic streaming request failed', error, {
      ...requestDetails,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
