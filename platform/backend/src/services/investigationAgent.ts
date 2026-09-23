import { logError } from '../util/logger.js';
import { aiService, type ChatMessage, type ChatMessageContent, type ChatTool } from './aiService.js';
import { READ_TOOLS, executeReadTool, type ToolExecCtx } from './aiToolExecutor.js';
import type { ClusterContext } from './aiContextService.js';

export interface InvestigationTarget {
  kind: string;
  name: string;
  namespace?: string;
}

export interface InvestigationResult {
  target: InvestigationTarget;
  verdict: string;
  findings?: string;
  error?: string;
}

// Keeps a single investigate_resources call's total relay cost bounded — and deliberately below
// what one ordinary turn can already cost on its own (MAX_TOOL_ROUNDS = 10 in ws/streams.ts), so
// reaching for fan-out is never a bigger bill than just asking a normal question: at most
// MAX_INVESTIGATION_TARGETS sub-agents run concurrently, each capped at MAX_SUBAGENT_ROUNDS of
// its own (billed) relay round-trips (worst case 4 * 2 = 8 credits). A sub-agent investigates
// one already-named resource, not a whole conversation, so 2 rounds is normally plenty: one
// round to request whatever reads it needs (Claude can — and does — request several tools in
// one round-trip, not one round each), one forced tool-less round to answer from what it found.
const MAX_INVESTIGATION_TARGETS = 4;
const MAX_SUBAGENT_ROUNDS = 2;

// Sub-agents are read-only by construction — never offered investigate_resources itself (which
// would allow unbounded recursive fan-out) or any write tool, so none of the approval-card
// machinery in ws/streams.ts needs to run for them.
const SUBAGENT_TOOLS: ChatTool[] = READ_TOOLS.filter((t) => t.name !== 'investigate_resources');

function describeTarget(target: InvestigationTarget): string {
  return `${target.kind} "${target.name}"${target.namespace ? ` in namespace "${target.namespace}"` : ''}`;
}

function extractVerdict(text: string): string {
  const match = text.match(/Verdict:\s*(.+)/i);
  return (match ? match[1] : text).trim().slice(0, 200) || 'No verdict produced.';
}

async function investigateOne(
  target: InvestigationTarget,
  question: string | undefined,
  turnContext: ClusterContext,
  toolCtx: ToolExecCtx,
  signal: AbortSignal | undefined,
): Promise<InvestigationResult> {
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content:
        `Investigate this resource for issues: ${describeTarget(target)}.` +
        (question ? ` Focus: ${question}.` : '') +
        ' Use only the tools available to you (logs, events, describe, metrics) to gather evidence — do not ask about any' +
        ' other resource. End your answer with one line starting with "Verdict:" summarizing whether it is healthy and why.',
    },
  ];

  try {
    for (let round = 0; round < MAX_SUBAGENT_ROUNDS; round++) {
      let assistantText = '';
      const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
      let sawError = false;
      let stopped = false;

      // No tools on the last round — the sub-agent must answer text-only, guaranteeing it
      // terminates within the round budget instead of asking for one more lookup forever.
      const isLastRound = round === MAX_SUBAGENT_ROUNDS - 1;

      await aiService.sendChatToRelay(
        turnContext,
        messages,
        isLastRound ? [] : SUBAGENT_TOOLS,
        (chunk) => {
          if (chunk.type === 'token') assistantText += chunk.data.token || '';
          else if (chunk.type === 'tool_use') toolUses.push({ id: chunk.data.id, name: chunk.data.name, input: chunk.data.input });
          else if (chunk.type === 'stopped') stopped = true;
          else if (chunk.type === 'error') sawError = true;
        },
        signal,
      );

      if (sawError) return { target, verdict: 'unknown', error: 'Investigation failed — the model call errored.' };
      if (stopped) return { target, verdict: 'unknown', error: 'Investigation was stopped.' };

      if (toolUses.length === 0) {
        return { target, verdict: extractVerdict(assistantText), findings: assistantText.trim() || undefined };
      }

      const assistantContent: ChatMessageContent = [
        ...(assistantText ? [{ type: 'text' as const, text: assistantText }] : []),
        ...toolUses.map((t) => ({ type: 'tool_use' as const, id: t.id, name: t.name, input: t.input })),
      ];
      messages.push({ role: 'assistant', content: assistantContent });

      const resultContent: ChatMessageContent = [];
      for (const t of toolUses) {
        const result = await executeReadTool(t.name, t.input, toolCtx);
        resultContent.push({ type: 'tool_result' as const, tool_use_id: t.id, content: result.output, is_error: result.isError });
      }
      messages.push({ role: 'user', content: resultContent });
    }

    return { target, verdict: 'inconclusive', error: 'Investigation used its round budget without reaching a verdict.' };
  } catch (err) {
    logError('investigation_agent.subagent_error', {
      target: describeTarget(target),
      error: err instanceof Error ? err.message : String(err),
    });
    return { target, verdict: 'unknown', error: err instanceof Error ? err.message : 'Investigation failed.' };
  }
}

/** Backs the investigate_resources AI tool (aiToolExecutor.ts) — fans out one concurrent
 * read-only sub-agent per target (ws/streams.ts routes here instead of executeReadTool because
 * this needs relay/streaming access that a plain read tool doesn't). One sub-agent's failure is
 * captured on its own result rather than rejecting the whole call. */
export async function runInvestigation(params: {
  targets: InvestigationTarget[];
  question?: string;
  turnContext: ClusterContext;
  toolCtx: ToolExecCtx;
  signal?: AbortSignal;
}): Promise<InvestigationResult[]> {
  const { targets, question, turnContext, toolCtx, signal } = params;
  const bounded = targets.slice(0, MAX_INVESTIGATION_TARGETS);
  const overflow = targets.length - bounded.length;

  const results = await Promise.all(bounded.map((target) => investigateOne(target, question, turnContext, toolCtx, signal)));

  if (overflow > 0) {
    results.push({
      target: { kind: 'note', name: `${overflow} more target(s)` },
      verdict: 'skipped',
      error: `Investigate at most ${MAX_INVESTIGATION_TARGETS} resources per call — narrow the request and call again for the rest.`,
    });
  }

  return results;
}
