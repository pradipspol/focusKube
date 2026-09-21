import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from '../api/client';
import type { Scope } from '../api/client';
import {
  openAiChatSocket,
  useAiEntitlement,
  type AiActionDiff,
  type AiChatInboundMessage,
  type AiFocusedResource,
} from '../api/aiAssistantApi';
import { AiEntitlementGate } from './AiEntitlementGate';
import { uiText } from '../text';

interface Props {
  scope: Scope;
  onClose: () => void;
  /** Fires when a tool result is popped out into (or closed from) the artifact side panel —
   * the host app widens the dock to give it real room, since the panel's own resizable width
   * has nowhere near enough space for a chat column plus a full table/JSON view. */
  onArtifactOpenChange?: (open: boolean) => void;
}

interface TextChatMessage {
  id: string;
  kind: 'text';
  role: 'user' | 'assistant';
  content: string;
  /** Only ever set on a user message — identifies its backend "turn" (see ws/streams.ts's
   * `checkpoints` map) so it can later be edited or regenerated without the frontend and
   * backend message arrays needing to otherwise stay in lockstep. */
  turnId?: string;
}

function createTurnId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `turn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A read tool (list/get/describe/logs/events) — auto-executed, no approval involved. */
interface ToolChatMessage {
  id: string;
  kind: 'tool';
  name: string;
  input: unknown;
  status: 'running' | 'done';
  output?: string;
  isError?: boolean;
}

/** A write tool (scale/restart/apply/delete) proposal, rendered as an Approve/Reject card. */
interface ActionChatMessage {
  id: string;
  kind: 'action';
  name: string;
  input: unknown;
  summary: string;
  diff?: AiActionDiff;
  // 'expired' is a terminal, frontend-only state: a card whose socket connection reset before
  // it was decided (see the WS-connect effect, which sweeps any still-'pending' card to this
  // status on every fresh connection) — the backend holds no memory of it across a reconnect,
  // so it can never actually be resolved. Kept out of hasPendingAction's check so it doesn't
  // block the chat forever (see that computation below for the full explanation).
  status: 'pending' | 'approved' | 'rejected' | 'failed' | 'expired';
  output?: string;
  /** Executed straight away because the user had already picked "Allow for this session" for
   * this tool name earlier in the conversation — never true for a card that was ever 'pending'. */
  autoApproved?: boolean;
}

type ChatMessage = TextChatMessage | ToolChatMessage | ActionChatMessage;

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

// Explicit width/height (not just the CSS class) because an inline <svg> as a flex item
// otherwise resolves its flex-basis from its own intrinsic size instead of the CSS width,
// which collapses it to 0 in Chromium — confirmed live, not a theoretical concern.
function SendIcon() {
  return (
    <svg className="ai-toolbar-icon" width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="M5 12l7-7 7 7" />
    </svg>
  );
}

function SkillsIcon() {
  return (
    <svg className="ai-toolbar-icon" width={16} height={16} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg className="ai-toolbar-icon" width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

let nextMessageId = 1;

const CHAT_SESSIONS_STORAGE_KEY = 'k8sExplorer.aiChatSessions';
const LEGACY_CHAT_HISTORY_STORAGE_KEY = 'k8sExplorer.aiChatHistory';

function isValidMessage(m: unknown): m is ChatMessage {
  if (!m || typeof m !== 'object') return false;
  const anyM = m as any;
  if (typeof anyM.id !== 'string') return false;
  // Pre-phase-2 sessions persisted {id, role, content} with no `kind` — treat those as 'text'
  // so history saved before this change still loads.
  const kind = anyM.kind ?? 'text';
  if (kind === 'text') {
    return (anyM.role === 'user' || anyM.role === 'assistant') && typeof anyM.content === 'string';
  }
  if (kind === 'tool') {
    return typeof anyM.name === 'string' && (anyM.status === 'running' || anyM.status === 'done');
  }
  if (kind === 'action') {
    return typeof anyM.name === 'string' && typeof anyM.summary === 'string';
  }
  return false;
}

/** Normalizes a message loaded from storage to always carry an explicit `kind` (see
 * isValidMessage's back-compat note above). */
function normalizeStoredMessage(m: ChatMessage): ChatMessage {
  return (m as any).kind ? m : ({ ...m, kind: 'text' } as ChatMessage);
}

function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m): m is TextChatMessage => m.kind === 'text' && m.role === 'user');
  const raw = firstUser?.content.trim().replace(/\s+/g, ' ') ?? '';
  if (!raw) return 'New chat';
  return raw.length > 42 ? `${raw.slice(0, 42)}…` : raw;
}

function freshSession(): ChatSession {
  return { id: createSessionId(), title: 'New chat', messages: [], updatedAt: Date.now() };
}

function loadStoredSessions(): { sessions: ChatSession[]; activeSessionId: string } {
  try {
    const raw = localStorage.getItem(CHAT_SESSIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.sessions)) {
        const sessions: ChatSession[] = parsed.sessions
          .filter(
            (s: unknown): s is ChatSession =>
              !!s &&
              typeof s === 'object' &&
              typeof (s as ChatSession).id === 'string' &&
              typeof (s as ChatSession).title === 'string' &&
              Array.isArray((s as ChatSession).messages) &&
              (s as ChatSession).messages.every(isValidMessage),
          )
          .map((s: ChatSession) => ({
            ...s,
            messages: s.messages.map(normalizeStoredMessage),
            updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(),
          }));
        if (sessions.length > 0) {
          const activeSessionId =
            typeof parsed.activeSessionId === 'string' && sessions.some((s) => s.id === parsed.activeSessionId)
              ? parsed.activeSessionId
              : sessions[0].id;
          return { sessions, activeSessionId };
        }
      }
    }
    // Migrate the pre-multi-session flat message array, if present.
    const legacyRaw = localStorage.getItem(LEGACY_CHAT_HISTORY_STORAGE_KEY);
    if (legacyRaw) {
      const legacyParsed = JSON.parse(legacyRaw);
      if (Array.isArray(legacyParsed)) {
        const messages = legacyParsed.filter(isValidMessage).map(normalizeStoredMessage);
        if (messages.length > 0) {
          const session: ChatSession = { id: createSessionId(), title: deriveSessionTitle(messages), messages, updatedAt: Date.now() };
          return { sessions: [session], activeSessionId: session.id };
        }
      }
    }
  } catch {
    // fall through to a fresh session
  }
  const session = freshSession();
  return { sessions: [session], activeSessionId: session.id };
}

function persistSessions(sessions: ChatSession[], activeSessionId: string): void {
  try {
    localStorage.setItem(CHAT_SESSIONS_STORAGE_KEY, JSON.stringify({ sessions, activeSessionId }));
  } catch {
    // best effort — e.g. storage quota exceeded. Chat still works for this session.
  }
}

interface Skill {
  id: string;
  label: string;
  icon: string;
  prompt: string;
}

const SKILLS: Skill[] = [
  { id: 'cluster', label: 'Cluster overview', icon: '🧭', prompt: 'Give me an overview of this cluster — node count, namespaces, and overall pod/deployment health.' },
  { id: 'nodes', label: 'Nodes', icon: '🖥️', prompt: 'What is the status and resource usage (CPU/memory) of each node in this cluster?' },
  { id: 'pods', label: 'Pods', icon: '🧱', prompt: 'How many pods are running right now, and are any of them unhealthy, pending, or restarting?' },
  { id: 'deployments', label: 'Deployments', icon: '📦', prompt: 'List the deployments in this cluster and call out any that are not fully rolled out.' },
  { id: 'services', label: 'Services', icon: '🔌', prompt: 'What services are exposed in this cluster, and how (ClusterIP, NodePort, LoadBalancer)?' },
  { id: 'namespaces', label: 'Namespaces', icon: '🗂️', prompt: 'List the namespaces in this cluster and roughly how many resources live in each.' },
  { id: 'events', label: 'Recent events', icon: '📣', prompt: 'Show me the most recent warning events in the cluster and what they indicate.' },
  { id: 'logs', label: 'Logs', icon: '📜', prompt: 'Summarize any errors from recent logs for the focused resource.' },
  { id: 'storage', label: 'Storage', icon: '💾', prompt: 'What persistent volumes and claims exist, and are any of them unbound or nearly full?' },
  { id: 'security', label: 'Security', icon: '🛡️', prompt: 'Are any pods running as root, privileged, or without resource limits?' },
];

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // clipboard unavailable — nothing more we can do
      });
  };

  return (
    <div className="ai-code-block">
      <div className="ai-code-block-header">
        <span className="ai-code-block-lang">{lang || 'code'}</span>
        <button type="button" className="ai-code-block-copy" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ai-code-block-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // clipboard unavailable — nothing more we can do
      });
  };
  return (
    <button type="button" className="ai-message-action-button" onClick={handleCopy}>
      {copied ? uiText.aiAssistant.copied : uiText.aiAssistant.copy}
    </button>
  );
}

/** react-markdown v9+ dropped the `inline` prop, so a fenced block is told apart from inline
 * code structurally: only a fenced block's `code` element ever arrives wrapped in a `pre` — so
 * overriding `pre` (never rendering the AST's own nested `code` node, just reading its props)
 * is what catches every block, language-less fences included; `code` on its own is therefore
 * always the truly-inline case. */
const markdownComponents: Components = {
  pre({ children }) {
    const codeEl = (Array.isArray(children) ? children[0] : children) as
      | { props?: { className?: string; children?: React.ReactNode } }
      | undefined;
    const codeProps = codeEl?.props;
    const raw = codeProps?.children;
    const text = (Array.isArray(raw) ? raw.join('') : String(raw ?? '')).replace(/\n$/, '');
    const match = /language-(\w+)/.exec(codeProps?.className || '');
    return <CodeBlock code={text} lang={match?.[1]} />;
  },
  code({ className, children }) {
    return <code className={`ai-inline-code${className ? ` ${className}` : ''}`}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  },
  table({ children }) {
    return (
      <div className="ai-tool-table-wrap">
        <table className="ai-tool-table">{children}</table>
      </div>
    );
  },
};

function MessageContent({ content }: { content: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** e.g. `namespace=default, podName=web-abc123` — a compact summary of a tool call's arguments. */
function formatToolArgs(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}

const TOOL_OUTPUT_COLLAPSE_LINES = 20;
const TOOL_OUTPUT_COLLAPSE_ROWS = 20;

interface ToolTableData {
  columns: string[];
  rows: Array<Record<string, string>>;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Turns a tool result's parsed JSON into table rows when it has an obvious tabular shape: an
 * array of objects (columns = the union of every item's keys, in first-seen order), an array
 * of primitives (a single "value" column), or one plain object (its fields as key/value rows).
 * A nested value renders as its own JSON snippet inside the cell rather than expanding further
 * — this is a flat table, not a tree. Returns null for shapes with no sensible row/column form
 * (an empty array/object, or a bare string/number/boolean) so the caller falls back to raw JSON.
 */
function buildToolTable(parsed: unknown): ToolTableData | null {
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return null;
    const isObjectArray = parsed.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item));
    if (isObjectArray) {
      const columns: string[] = [];
      const seen = new Set<string>();
      for (const item of parsed as Array<Record<string, unknown>>) {
        for (const key of Object.keys(item)) {
          if (!seen.has(key)) {
            seen.add(key);
            columns.push(key);
          }
        }
      }
      const rows = (parsed as Array<Record<string, unknown>>).map((item) => {
        const row: Record<string, string> = {};
        for (const col of columns) row[col] = cellToString(item[col]);
        return row;
      });
      return { columns, rows };
    }
    return { columns: ['value'], rows: parsed.map((item) => ({ value: cellToString(item) })) };
  }
  if (parsed !== null && typeof parsed === 'object') {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) return null;
    return { columns: ['field', 'value'], rows: entries.map(([field, value]) => ({ field, value: cellToString(value) })) };
  }
  return null;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function tableToCsv(table: ToolTableData): string {
  const lines = [table.columns.map(csvCell).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((col) => csvCell(row[col] ?? '')).join(','));
  }
  return lines.join('\n');
}

function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Renders one tool result's output, either inline ('compact': row/line-capped, with an Expand
 * button to pop it into the artifact side panel) or as that panel's own uncapped content
 * ('full'). Table/JSON toggle and CSV/JSON downloads work the same in both modes.
 */
function ToolOutputViewer({
  name,
  id,
  output,
  isError,
  mode,
  onExpand,
}: {
  name: string;
  id: string;
  output: string;
  isError?: boolean;
  mode: 'compact' | 'full';
  onExpand?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Read tools return either plain text (logs) or a JSON string (list/get/describe/events) —
  // only the latter has a table form. A capped/truncated output (see aiToolExecutor.ts's
  // capOutput) is no longer valid JSON, so this naturally — and correctly — falls back to the
  // raw-text view below rather than showing a broken or partial table.
  const table = useMemo(() => {
    if (!output || isError) return null;
    try {
      return buildToolTable(JSON.parse(output));
    } catch {
      return null;
    }
  }, [output, isError]);
  const [viewMode, setViewMode] = useState<'table' | 'json'>('table');
  const [exportOpen, setExportOpen] = useState(false);
  const showTable = !!table && viewMode === 'table';

  // The artifact panel shows everything, uncapped — only the compact inline view collapses.
  const lines = useMemo(() => output?.split('\n') ?? [], [output]);
  const isLongText = mode === 'compact' && lines.length > TOOL_OUTPUT_COLLAPSE_LINES;
  const isLongTable = mode === 'compact' && !!table && table.rows.length > TOOL_OUTPUT_COLLAPSE_ROWS;
  const shownText = expanded || !isLongText ? output : lines.slice(0, TOOL_OUTPUT_COLLAPSE_LINES).join('\n');
  const shownRows = table && (expanded || !isLongTable) ? table.rows : table?.rows.slice(0, TOOL_OUTPUT_COLLAPSE_ROWS) ?? [];

  const fileBase = `${name}-${id}`;

  return (
    <div className={`ai-code-block ai-tool-output${mode === 'full' ? ' ai-tool-output-full' : ''}`}>
      <div className="ai-tool-output-toolbar">
        {table ? (
          <div className="ai-tool-view-toggle">
            <button
              type="button"
              className={viewMode === 'table' ? 'active' : ''}
              aria-pressed={viewMode === 'table'}
              onClick={() => setViewMode('table')}
            >
              {uiText.aiAssistant.viewAsTable}
            </button>
            <button
              type="button"
              className={viewMode === 'json' ? 'active' : ''}
              aria-pressed={viewMode === 'json'}
              onClick={() => setViewMode('json')}
            >
              {uiText.aiAssistant.viewAsJson}
            </button>
          </div>
        ) : (
          <span />
        )}
        <div className="ai-tool-output-downloads">
          {table && (
            <div className="ai-tool-export">
              <button
                type="button"
                className="ai-tool-export-button"
                title={uiText.aiAssistant.export}
                aria-label={uiText.aiAssistant.export}
                aria-haspopup="true"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen((v) => !v)}
              >
                <ExportIcon />
              </button>
              {exportOpen && (
                <>
                  <div className="ai-tool-export-backdrop" onClick={() => setExportOpen(false)} />
                  <div className="ai-tool-export-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setExportOpen(false);
                        downloadTextFile(`${fileBase}.csv`, tableToCsv(table), 'text/csv');
                      }}
                    >
                      {uiText.aiAssistant.downloadCsv}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setExportOpen(false);
                        downloadTextFile(`${fileBase}.json`, output, 'application/json');
                      }}
                    >
                      {uiText.aiAssistant.downloadJson}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {onExpand && (
            <button type="button" className="ai-tool-output-expand" title={uiText.aiAssistant.expand} aria-label={uiText.aiAssistant.expand} onClick={onExpand}>
              ⤢
            </button>
          )}
        </div>
      </div>
      {showTable ? (
        <div className="ai-tool-table-wrap">
          <table className="ai-tool-table">
            <thead>
              <tr>
                {table.columns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shownRows.map((row, i) => (
                <tr key={i}>
                  {table.columns.map((col) => (
                    <td key={col}>{row[col]}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className="ai-code-block-pre">
          <code>{shownText}</code>
        </pre>
      )}
      {showTable
        ? isLongTable && (
            <button type="button" className="ai-tool-output-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? uiText.aiAssistant.showLess : uiText.aiAssistant.showMoreRows(table.rows.length - TOOL_OUTPUT_COLLAPSE_ROWS)}
            </button>
          )
        : isLongText && (
            <button type="button" className="ai-tool-output-toggle" onClick={() => setExpanded((v) => !v)}>
              {expanded ? uiText.aiAssistant.showLess : uiText.aiAssistant.showMore(lines.length - TOOL_OUTPUT_COLLAPSE_LINES)}
            </button>
          )}
    </div>
  );
}

function ToolMessage({ message, onExpand }: { message: ToolChatMessage; onExpand: () => void }) {
  const args = useMemo(() => formatToolArgs(message.input), [message.input]);

  return (
    <div className={`ai-tool-message${message.status === 'running' ? ' ai-tool-message-running' : ''}${message.isError ? ' ai-tool-message-error' : ''}`}>
      <div className="ai-tool-message-header">
        <span className="ai-tool-message-name">{message.name}</span>
        {args && <span className="ai-tool-message-args">{args}</span>}
        {message.status === 'running' && <span className="ai-tool-spinner" aria-hidden="true" />}
      </div>
      {message.status === 'done' && message.output && (
        <ToolOutputViewer name={message.name} id={message.id} output={message.output} isError={message.isError} mode="compact" onExpand={onExpand} />
      )}
    </div>
  );
}

function ActionCard({
  message,
  onDecide,
  isLive,
}: {
  message: ActionChatMessage;
  onDecide: (id: string, approved: boolean, remember?: boolean) => void;
  isLive: boolean;
}) {
  const pending = message.status === 'pending';
  const canDecide = pending && isLive;

  return (
    <div className={`ai-action-card ai-action-card-${message.status}`}>
      <div className="ai-action-card-summary">{message.summary}</div>
      {message.diff && (
        <div className="ai-action-card-diff">
          {message.diff.before && (
            <div className="ai-action-card-diff-col">
              <div className="ai-action-card-diff-label">{uiText.aiAssistant.diffBefore}</div>
              <pre className="ai-code-block-pre">
                <code>{message.diff.before}</code>
              </pre>
            </div>
          )}
          <div className="ai-action-card-diff-col">
            <div className="ai-action-card-diff-label">
              {message.diff.before ? uiText.aiAssistant.diffAfter : uiText.aiAssistant.diffNew}
            </div>
            <pre className="ai-code-block-pre">
              <code>{message.diff.after}</code>
            </pre>
          </div>
        </div>
      )}
      {pending ? (
        canDecide ? (
          <>
            <div className="ai-action-card-buttons">
              <button type="button" className="ai-action-approve" onClick={() => onDecide(message.id, true)}>
                {uiText.aiAssistant.approve}
              </button>
              <button type="button" className="ai-action-reject" onClick={() => onDecide(message.id, false)}>
                {uiText.aiAssistant.reject}
              </button>
            </div>
            <div className="ai-action-card-buttons-secondary">
              <button type="button" className="ai-action-allow-session" onClick={() => onDecide(message.id, true, true)}>
                {uiText.aiAssistant.allowSession}
              </button>
            </div>
          </>
        ) : (
          <div className="ai-action-card-footer ai-action-card-footer-expired">{uiText.aiAssistant.actionExpired}</div>
        )
      ) : (
        <div className={`ai-action-card-footer${message.status === 'expired' ? ' ai-action-card-footer-expired' : ''}`}>
          {message.status === 'approved' && uiText.aiAssistant.actionApproved}
          {message.status === 'rejected' && uiText.aiAssistant.actionRejected}
          {message.status === 'failed' && uiText.aiAssistant.actionFailed(message.output)}
          {message.status === 'expired' && uiText.aiAssistant.actionExpired}
          {message.autoApproved && message.status !== 'expired' && (
            <span className="ai-action-card-auto-note"> {uiText.aiAssistant.actionAutoApprovedNote}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ChatMessages({
  messages,
  onDecide,
  liveActionIds,
  canEdit,
  editingId,
  editText,
  onEditStart,
  onEditTextChange,
  onEditSave,
  onEditCancel,
  onExpandTool,
}: {
  messages: ChatMessage[];
  onDecide: (id: string, approved: boolean, remember?: boolean) => void;
  liveActionIds: Set<string>;
  /** Editing/regenerating requires rewinding the backend's own `messages` array — disabled
   * while a turn is in flight or a write-tool proposal is pending, same as sending a new
   * message would be. */
  canEdit: boolean;
  editingId: string | null;
  editText: string;
  onEditStart: (id: string, content: string) => void;
  onEditTextChange: (text: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
  onExpandTool: (message: ToolChatMessage) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.scrollTop = host.scrollHeight;
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="ai-panel-empty" ref={hostRef}>
        {uiText.aiAssistant.emptyState}
      </div>
    );
  }

  return (
    <div className="ai-panel-messages" ref={hostRef}>
      {messages.map((message) => {
        if (message.kind === 'tool') {
          return (
            <div key={message.id} className="ai-panel-message ai-panel-message-tool">
              <ToolMessage message={message} onExpand={() => onExpandTool(message)} />
            </div>
          );
        }
        if (message.kind === 'action') {
          return (
            <div key={message.id} className="ai-panel-message ai-panel-message-action">
              <ActionCard message={message} onDecide={onDecide} isLive={liveActionIds.has(message.id)} />
            </div>
          );
        }
        if (message.kind === 'text' && message.role === 'user' && editingId === message.id) {
          return (
            <div key={message.id} className="ai-panel-message ai-panel-message-user">
              <div className="ai-panel-message-bubble ai-panel-message-editing">
                <textarea
                  className="ai-message-edit-input"
                  value={editText}
                  onChange={(e) => onEditTextChange(e.target.value)}
                  rows={Math.min(8, Math.max(2, editText.split('\n').length))}
                  autoFocus
                />
                <div className="ai-message-actions">
                  <button type="button" className="ai-message-action-button ai-message-action-primary" onClick={onEditSave}>
                    {uiText.aiAssistant.save}
                  </button>
                  <button type="button" className="ai-message-action-button" onClick={onEditCancel}>
                    {uiText.aiAssistant.cancel}
                  </button>
                </div>
              </div>
            </div>
          );
        }
        return (
          <div key={message.id} className={`ai-panel-message ai-panel-message-${message.role}`}>
            <div className="ai-panel-message-col">
              <div className="ai-panel-message-bubble">
                <MessageContent content={message.content} />
              </div>
              {message.content && (
                <div className="ai-message-actions">
                  <CopyButton text={message.content} />
                  {message.role === 'user' && canEdit && (
                    <button type="button" className="ai-message-action-button" onClick={() => onEditStart(message.id, message.content)}>
                      {uiText.aiAssistant.edit}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SessionHistoryDropdown({
  sessions,
  activeSessionId,
  onOpen,
  onDelete,
  onClose,
}: {
  sessions: ChatSession[];
  activeSessionId: string;
  onOpen: (id: string) => void;
  onDelete: (id: string, evt: React.MouseEvent) => void;
  onClose: () => void;
}) {
  const sorted = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);

  return (
    <>
      <div className="ai-history-backdrop" onClick={onClose} />
      <div className="ai-history-dropdown">
        <div className="ai-history-header">{uiText.aiAssistant.historyTitle}</div>
        <div className="ai-history-list">
          {sorted.length === 0 && <div className="ai-history-empty">{uiText.aiAssistant.historyEmpty}</div>}
          {sorted.map((session) => (
            <button
              type="button"
              key={session.id}
              className={`ai-history-item ${session.id === activeSessionId ? 'ai-history-item-active' : ''}`}
              onClick={() => onOpen(session.id)}
            >
              <span className="ai-history-item-info">
                <span className="ai-history-item-title">{session.title}</span>
                <span className="ai-history-item-meta">
                  {session.messages.length} {session.messages.length === 1 ? 'message' : 'messages'} · {formatRelativeTime(session.updatedAt)}
                </span>
              </span>
              <span
                className="ai-history-item-delete"
                role="button"
                tabIndex={0}
                title={uiText.aiAssistant.deleteSession}
                aria-label={uiText.aiAssistant.deleteSession}
                onClick={(evt) => onDelete(session.id, evt)}
                onKeyDown={(evt) => {
                  if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    onDelete(session.id, evt as unknown as React.MouseEvent);
                  }
                }}
              >
                🗑
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function SkillsMenu({ onSelect, onClose }: { onSelect: (skill: Skill) => void; onClose: () => void }) {
  return (
    <>
      <div className="ai-skills-backdrop" onClick={onClose} />
      <div className="ai-skills-menu">
        <div className="ai-skills-menu-header">{uiText.aiAssistant.skillsMenuTitle}</div>
        {SKILLS.map((skill) => (
          <button type="button" key={skill.id} className="ai-skills-menu-item" onClick={() => onSelect(skill)}>
            <span className="ai-skills-menu-icon" aria-hidden="true">
              {skill.icon}
            </span>
            <span>{skill.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

export function AiAssistantPanel({ scope, onClose, onArtifactOpenChange }: Props) {
  const initialRef = useRef<{ sessions: ChatSession[]; activeSessionId: string } | null>(null);
  if (initialRef.current === null) {
    const loaded = loadStoredSessions();
    const maxId = loaded.sessions.reduce((max, s) => {
      return s.messages.reduce((m2, msg) => {
        const match = /-(\d+)$/.exec(msg.id);
        const n = match ? Number(match[1]) : 0;
        return Number.isFinite(n) ? Math.max(m2, n) : m2;
      }, max);
    }, 0);
    if (maxId >= nextMessageId) nextMessageId = maxId + 1;
    initialRef.current = loaded;
  }
  const initial = initialRef.current;

  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string>(initial.activeSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    return initial.sessions.find((s) => s.id === initial.activeSessionId)?.messages ?? [];
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [input, setInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusedResource, setFocusedResource] = useState<AiFocusedResource | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerKind, setPickerKind] = useState('');
  const [pickerNamespace, setPickerNamespace] = useState(scope.namespace ?? 'default');
  const [pickerName, setPickerName] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Tool_use ids for action_proposed cards received on the CURRENT live socket connection —
  // reset on every (re)connect, since the backend holds no conversation state across a
  // reconnect and any card from before it simply can no longer be resolved. A card restored
  // from localStorage history (a different session, or the same session before a reconnect)
  // won't be in this set, so it renders as expired instead of clickable.
  const liveActionIdsRef = useRef<Set<string>>(new Set());

  // Shares AiEntitlementGate's own query (same key, already warmed by App.tsx) — used only
  // to gate the WS connect effect below, not to decide what to render (the gate owns that).
  const { data: entitlement } = useAiEntitlement();
  const entitled = entitlement?.enabled ?? false;

  const { data: kindsData } = useQuery({
    queryKey: ['ai', 'resource-kinds'],
    queryFn: () => api.getKinds(),
    staleTime: Infinity,
  });
  const kinds = useMemo(
    () => (kindsData ?? []).filter((k) => k.namespaced).map((k) => k.kind).sort(),
    [kindsData],
  );

  // Keeps the active session's snapshot inside `sessions` in sync with the live `messages`
  // state (including mid-stream token updates) — the persistence effect below reacts to that.
  useEffect(() => {
    setSessions((current) => {
      const idx = current.findIndex((s) => s.id === activeSessionId);
      const updated: ChatSession = { id: activeSessionId, title: deriveSessionTitle(messages), messages, updatedAt: Date.now() };
      if (idx === -1) return [...current, updated];
      const next = current.slice();
      next[idx] = updated;
      return next;
    });
  }, [messages, activeSessionId]);

  useEffect(() => {
    persistSessions(sessions, activeSessionId);
  }, [sessions, activeSessionId]);

  useEffect(() => {
    // Don't attempt a connection at all while unlicensed — AiEntitlementGate is showing the
    // locked/checkout screen instead of this panel anyway. Once entitlement flips to true
    // (e.g. right after a trial/checkout completes), this effect re-runs and connects fresh,
    // rather than leaving a stale "AI feature not enabled" error from an earlier attempt.
    if (!entitled) return;

    // Reconnects automatically if the socket drops for a reason unrelated to this effect
    // tearing down (a backend restart during dev, a network blip) — without this, a dropped
    // connection left the panel silently inert: every send/edit/stop guards on
    // `readyState === OPEN` and just no-ops otherwise, so the user would type, hit send, and
    // see nothing happen with no indication why. `cancelled` distinguishes that case from a
    // real unmount/dep-change teardown, where reconnecting would just leak a socket no one is
    // listening to anymore.
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      // A fresh connection means the backend's own conversation/pending-action state (held only
      // in that WS handler's closure, see ws/streams.ts's handleAiChat) starts empty too — any
      // action_proposed id from before this point can no longer be resolved.
      liveActionIdsRef.current = new Set();
      // A card left 'pending' from before this connection can never actually be decided now —
      // expire it (a terminal status, unlike 'pending') so it stops blocking hasPendingAction
      // forever. Sweep every stored session, not just the one currently displayed, since a
      // stale card may be sitting in a session the user hasn't switched back to yet.
      const expirePending = (msgs: ChatMessage[]): ChatMessage[] =>
        msgs.map((m) => (m.kind === 'action' && m.status === 'pending' ? { ...m, status: 'expired' } : m));
      setMessages((current) => expirePending(current));
      setSessions((current) => current.map((s) => ({ ...s, messages: expirePending(s.messages) })));

      const ws = openAiChatSocket(scope.context);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        setError(null);
      };
      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => setError(uiText.aiAssistant.connectionError);
      ws.onmessage = (event) => {
        let msg: AiChatInboundMessage;
        try {
          msg = JSON.parse(event.data);
        } catch (err) {
          console.error('[ai-chat] failed to parse WS message', event.data, err);
          return;
        }
        if (msg.type === 'token') {
          setBusy(true);
          setMessages((current) => {
            if (streamingIdRef.current) {
              return current.map((m) =>
                m.id === streamingIdRef.current && m.kind === 'text' ? { ...m, content: m.content + msg.token } : m,
              );
            }
            const id = `assistant-${nextMessageId++}`;
            streamingIdRef.current = id;
            return [...current, { id, kind: 'text', role: 'assistant', content: msg.token }];
          });
        } else if (msg.type === 'stop') {
          streamingIdRef.current = null;
          setBusy(false);
        } else if (msg.type === 'stopped') {
          // A deliberate Stop click, not a failure — leave whatever text streamed so far in
          // place and end the "thinking" state without showing an error banner.
          streamingIdRef.current = null;
          setBusy(false);
        } else if (msg.type === 'error') {
          streamingIdRef.current = null;
          setBusy(false);
          setError(msg.message);
        } else if (msg.type === 'tool_call') {
          // A read tool starting also marks the end of whatever text bubble was streaming —
          // tokens after the tool result land in a new bubble rather than this one.
          streamingIdRef.current = null;
          setMessages((current) => [
            ...current,
            { id: msg.id, kind: 'tool', name: msg.name, input: msg.input, status: 'running' },
          ]);
        } else if (msg.type === 'tool_result') {
          setMessages((current) =>
            current.map((m) =>
              m.id === msg.id && m.kind === 'tool' ? { ...m, status: 'done', output: msg.output, isError: msg.isError } : m,
            ),
          );
        } else if (msg.type === 'action_proposed') {
          streamingIdRef.current = null;
          setBusy(false);
          liveActionIdsRef.current.add(msg.id);
          setMessages((current) => [
            ...current,
            { id: msg.id, kind: 'action', name: msg.name, input: msg.input, summary: msg.summary, diff: msg.diff, status: 'pending' },
          ]);
        } else if (msg.type === 'action_result') {
          setMessages((current) =>
            current.map((m) => (m.id === msg.id && m.kind === 'action' ? { ...m, status: msg.status, output: msg.output } : m)),
          );
        } else if (msg.type === 'action_auto') {
          // Already executed — matched an earlier "Allow for this session" choice, so this never
          // passes through a 'pending' state at all.
          streamingIdRef.current = null;
          setBusy(false);
          setMessages((current) => [
            ...current,
            {
              id: msg.id,
              kind: 'action',
              name: msg.name,
              input: msg.input,
              summary: msg.summary,
              diff: msg.diff,
              status: msg.status,
              output: msg.output,
              autoApproved: true,
            },
          ]);
        } else {
          console.warn('[ai-chat] unhandled WS message type', msg);
        }
      };
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [scope.context, entitled]);

  // Grows the input with its content (up to the CSS max-height, after which it scrolls
  // internally) — plain textareas don't do this on their own, and a fixed height clips
  // longer messages instead of showing them.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // A pending write-tool proposal blocks new free-form messages — the backend enforces this
  // too (a plain user_message can't be sandwiched between an assistant's tool_use and its
  // tool_result in the Anthropic API's own message shape), this is just the matching UI state.
  const hasPendingAction = useMemo(() => messages.some((m) => m.kind === 'action' && m.status === 'pending'), [messages]);
  // Editing/regenerating rewinds the backend's own turn history (see ws/streams.ts's
  // `checkpoints` map) — disallowed mid-turn or with an unresolved proposal for the same reason
  // a fresh message is: the backend can't interleave that with an in-flight round.
  const canEditOrRegenerate = !busy && !hasPendingAction;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');

  // A tool result "popped out" of the chat — looked up by id (rather than storing the message
  // itself) so it always reflects the latest state, though in practice a 'tool' message never
  // changes again once it reaches 'done'.
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const activeArtifact = useMemo(
    () => messages.find((m): m is ToolChatMessage => m.kind === 'tool' && m.id === activeArtifactId) ?? null,
    [messages, activeArtifactId],
  );
  const openArtifact = (message: ToolChatMessage) => {
    setActiveArtifactId(message.id);
    onArtifactOpenChange?.(true);
  };
  const closeArtifact = () => {
    setActiveArtifactId(null);
    onArtifactOpenChange?.(false);
  };
  const sendMessage = () => {
    const text = input.trim();
    if (!text || hasPendingAction) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // Distinct from the no-op guards above — this is the one the user actually needs to see:
      // without it, a dropped connection (e.g. mid-reconnect) swallowed the send with nothing
      // to explain why nothing happened.
      setError(uiText.aiAssistant.connectionError);
      return;
    }
    setError(null);
    setBusy(true);
    const turnId = createTurnId();
    setMessages((current) => [...current, { id: `user-${nextMessageId++}`, kind: 'text', role: 'user', content: text, turnId }]);
    wsRef.current.send(
      JSON.stringify({
        type: 'user_message',
        text,
        turnId,
        ...(focusedResource ? { focusedResource } : {}),
      }),
    );
    setInput('');
  };

  const startEdit = (id: string, content: string) => {
    if (!canEditOrRegenerate) return;
    setEditingId(id);
    setEditText(content);
  };
  const cancelEdit = () => setEditingId(null);

  const saveEdit = () => {
    const idx = messages.findIndex((m) => m.id === editingId);
    const target = idx !== -1 ? messages[idx] : undefined;
    const text = editText.trim();
    if (!target || target.kind !== 'text' || target.role !== 'user' || !target.turnId || !text) {
      setEditingId(null);
      return;
    }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setEditingId(null);
    setError(null);
    setBusy(true);
    // Defensive: a stale id from a turn that never cleanly ended would otherwise make the
    // new turn's tokens try to append to a bubble that no longer exists (see the `token`
    // handler above, which only ever appends to an existing id) instead of starting a fresh one.
    streamingIdRef.current = null;
    setMessages((current) => [...current.slice(0, idx), { ...target, content: text }]);
    wsRef.current.send(
      JSON.stringify({
        type: 'edit_message',
        turnId: target.turnId,
        text,
        ...(focusedResource ? { focusedResource } : {}),
      }),
    );
  };

  const stopGenerating = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: 'stop' }));
  };

  const sendActionDecision = (id: string, approved: boolean, remember?: boolean) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setBusy(true);
    wsRef.current.send(JSON.stringify({ type: 'action_decision', id, approved, ...(remember ? { remember: true } : {}) }));
  };

  const applyPicker = () => {
    if (!pickerKind.trim() || !pickerName.trim()) return;
    setFocusedResource({
      kind: pickerKind.trim(),
      namespace: pickerNamespace.trim() || 'default',
      name: pickerName.trim(),
    });
    setPickerOpen(false);
  };

  const applySkill = (skill: Skill) => {
    setInput(skill.prompt);
    setSkillsOpen(false);
    // Wait for the value above to actually reach the DOM before focusing/selecting, since
    // this runs synchronously before React re-renders the (still stale) textarea.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(skill.prompt.length, skill.prompt.length);
    });
  };

  const resetTransientState = () => {
    setFocusedResource(null);
    setError(null);
    setInput('');
    streamingIdRef.current = null;
    if (activeArtifactId) closeArtifact();
  };

  const startNewChat = () => {
    // Drop any other empty drafts before creating a new one, so repeated "+" clicks with
    // nothing typed don't pile up as duplicate "New chat" entries in the history list.
    setSessions((current) => current.filter((s) => s.messages.length > 0));
    setActiveSessionId(createSessionId());
    setMessages([]);
    resetTransientState();
    setHistoryOpen(false);
  };

  const openSession = (id: string) => {
    setHistoryOpen(false);
    if (id === activeSessionId) return;
    const target = sessions.find((s) => s.id === id);
    if (!target) return;
    setActiveSessionId(id);
    setMessages(target.messages);
    resetTransientState();
  };

  const deleteSession = (id: string, evt: React.MouseEvent) => {
    evt.stopPropagation();
    const remaining = sessions.filter((s) => s.id !== id);
    if (id !== activeSessionId) {
      setSessions(remaining);
      return;
    }
    if (remaining.length > 0) {
      setSessions(remaining);
      setActiveSessionId(remaining[0].id);
      setMessages(remaining[0].messages);
    } else {
      const fresh = freshSession();
      setSessions([fresh]);
      setActiveSessionId(fresh.id);
      setMessages([]);
    }
    resetTransientState();
  };

  return (
    <div className="ai-dock-shell">
      <div className="ai-dock-topbar">
        <span className="ai-dock-title">{uiText.aiAssistant.title}</span>
        <div className="ai-dock-topbar-actions">
          <button type="button" className="ai-dock-icon-button" title={uiText.aiAssistant.newChat} aria-label={uiText.aiAssistant.newChat} onClick={startNewChat}>
            +
          </button>
          <button
            type="button"
            className="ai-dock-icon-button"
            title={uiText.aiAssistant.historyTitle}
            aria-label={uiText.aiAssistant.historyTitle}
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
          >
            🕘
          </button>
          <button type="button" className="ai-dock-icon-button" title={uiText.aiAssistant.close} aria-label={uiText.aiAssistant.close} onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {historyOpen && (
        <SessionHistoryDropdown
          sessions={sessions}
          activeSessionId={activeSessionId}
          onOpen={openSession}
          onDelete={deleteSession}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <AiEntitlementGate>
        <div className={`ai-panel${activeArtifact ? ' ai-panel-with-artifact' : ''}`}>
        <div className="ai-panel-chat-col">
          {/* <div className="ai-panel-header">
            <span className={`badge ${connected ? 'ok' : 'warn'}`}>
              {connected ? uiText.aiAssistant.connected : uiText.aiAssistant.disconnected}
            </span>
            {focusedResource ? (
              <button type="button" className="ai-panel-focus-chip" onClick={() => setFocusedResource(null)}>
                {uiText.aiAssistant.focusedResourceLabel(focusedResource.kind, focusedResource.name)} ✕
              </button>
            ) : (
              <button type="button" className="ai-panel-focus-chip ai-panel-focus-chip-empty" onClick={() => setPickerOpen((v) => !v)}>
                + Focus a resource
              </button>
            )}
          </div> */}

          {pickerOpen && (
            <div className="ai-panel-picker">
              <select value={pickerKind} onChange={(e) => setPickerKind(e.target.value)}>
                <option value="">Kind…</option>
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={pickerNamespace}
                onChange={(e) => setPickerNamespace(e.target.value)}
                placeholder="namespace"
              />
              <input
                type="text"
                value={pickerName}
                onChange={(e) => setPickerName(e.target.value)}
                placeholder="name"
              />
              <button type="button" className="primary" onClick={applyPicker}>
                Focus
              </button>
            </div>
          )}

          {error && <div className="ai-panel-error">{error}</div>}

          <ChatMessages
            messages={messages}
            onDecide={sendActionDecision}
            liveActionIds={liveActionIdsRef.current}
            canEdit={canEditOrRegenerate}
            editingId={editingId}
            editText={editText}
            onEditStart={startEdit}
            onEditTextChange={setEditText}
            onEditSave={saveEdit}
            onEditCancel={cancelEdit}
            onExpandTool={openArtifact}
          />

          {busy && <div className="ai-panel-thinking">{uiText.aiAssistant.thinking}</div>}
          {!connected && !busy && <div className="ai-panel-pending-hint">{uiText.aiAssistant.reconnecting}</div>}
          {hasPendingAction && <div className="ai-panel-pending-hint">{uiText.aiAssistant.pendingActionHint}</div>}

          <div className="ai-panel-input-row">
            <div className="ai-input-shell">
              <textarea
                ref={textareaRef}
                className="ai-panel-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder={uiText.aiAssistant.inputPlaceholder}
                rows={1}
              />
              <div className="ai-input-toolbar-row">
                <button
                  type="button"
                  className={`ai-skills-button ${skillsOpen ? 'active' : ''}`}
                  title={uiText.aiAssistant.skillsButton}
                  aria-label={uiText.aiAssistant.skillsButton}
                  aria-pressed={skillsOpen}
                  onClick={() => setSkillsOpen((v) => !v)}
                >
                  <SkillsIcon />
                </button>
                <button
                  type="button"
                  className={`ai-send-button${busy ? ' ai-send-button-stop' : ''}`}
                  onClick={busy ? stopGenerating : sendMessage}
                  disabled={busy ? false : !connected || !input.trim() || hasPendingAction}
                  title={busy ? uiText.aiAssistant.stopGenerating : uiText.aiAssistant.send}
                  aria-label={busy ? uiText.aiAssistant.stopGenerating : uiText.aiAssistant.send}
                >
                  {busy ? <StopIcon /> : <SendIcon />}
                </button>
              </div>
              {skillsOpen && <SkillsMenu onSelect={applySkill} onClose={() => setSkillsOpen(false)} />}
            </div>
          </div>
        </div>
        {activeArtifact && (
          <div className="ai-panel-artifact-col">
            <div className="ai-artifact-header">
              <span className="ai-artifact-title">{activeArtifact.name}</span>
              <button type="button" className="ai-artifact-close" onClick={closeArtifact}>
                {uiText.aiAssistant.closeArtifact}
              </button>
            </div>
            <div className="ai-artifact-body">
              <ToolOutputViewer
                name={activeArtifact.name}
                id={activeArtifact.id}
                output={activeArtifact.output ?? ''}
                isError={activeArtifact.isError}
                mode="full"
              />
            </div>
          </div>
        )}
        </div>
      </AiEntitlementGate>
    </div>
  );
}
