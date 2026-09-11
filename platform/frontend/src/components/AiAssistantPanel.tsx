import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Scope } from '../api/client';
import { openAiChatSocket, useAiEntitlement, type AiChatInboundMessage, type AiFocusedResource } from '../api/aiAssistantApi';
import { AiEntitlementGate } from './AiEntitlementGate';
import { uiText } from '../text';

interface Props {
  scope: Scope;
  onClose: () => void;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

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

let nextMessageId = 1;

const CHAT_SESSIONS_STORAGE_KEY = 'k8sExplorer.aiChatSessions';
const LEGACY_CHAT_HISTORY_STORAGE_KEY = 'k8sExplorer.aiChatHistory';

function isValidMessage(m: unknown): m is ChatMessage {
  return (
    !!m &&
    typeof m === 'object' &&
    typeof (m as ChatMessage).id === 'string' &&
    ((m as ChatMessage).role === 'user' || (m as ChatMessage).role === 'assistant') &&
    typeof (m as ChatMessage).content === 'string'
  );
}

function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function deriveSessionTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
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
          .map((s: ChatSession) => ({ ...s, updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now() }));
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
        const messages = legacyParsed.filter(isValidMessage);
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

interface ContentSegment {
  type: 'text' | 'code';
  content: string;
  lang?: string;
}

/**
 * Splits on ``` fences. An odd trailing fence (still streaming, not yet closed) is treated as
 * code too — the split naturally produces that as the last element without extra bookkeeping.
 */
function parseMessageSegments(text: string): ContentSegment[] {
  const parts = text.split('```');
  return parts
    .map((part, i): ContentSegment | null => {
      if (i % 2 === 0) {
        return part ? { type: 'text', content: part } : null;
      }
      const newlineIdx = part.indexOf('\n');
      let lang = '';
      let code = part;
      if (newlineIdx !== -1) {
        const firstLine = part.slice(0, newlineIdx);
        if (/^\S*$/.test(firstLine)) {
          lang = firstLine.trim();
          code = part.slice(newlineIdx + 1);
        }
      }
      return { type: 'code', content: code.replace(/\n$/, ''), lang };
    })
    .filter((seg): seg is ContentSegment => seg !== null);
}

function renderTextWithInlineCode(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split('`');
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={`${keyPrefix}-${i}`} className="ai-inline-code">
        {part}
      </code>
    ) : (
      part
    ),
  );
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

function MessageContent({ content }: { content: string }) {
  const segments = useMemo(() => parseMessageSegments(content), [content]);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'code' ? (
          <CodeBlock key={i} code={seg.content} lang={seg.lang} />
        ) : (
          <span key={i} className="ai-message-text">
            {renderTextWithInlineCode(seg.content, `t${i}`)}
          </span>
        ),
      )}
    </>
  );
}

function ChatMessages({ messages }: { messages: ChatMessage[] }) {
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
      {messages.map((message) => (
        <div key={message.id} className={`ai-panel-message ai-panel-message-${message.role}`}>
          <div className="ai-panel-message-bubble">
            <MessageContent content={message.content} />
          </div>
        </div>
      ))}
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

export function AiAssistantPanel({ scope, onClose }: Props) {
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
    const ws = openAiChatSocket(scope.context);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      setError(null);
    };
    ws.onclose = () => setConnected(false);
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
              m.id === streamingIdRef.current ? { ...m, content: m.content + msg.token } : m,
            );
          }
          const id = `assistant-${nextMessageId++}`;
          streamingIdRef.current = id;
          return [...current, { id, role: 'assistant', content: msg.token }];
        });
      } else if (msg.type === 'stop') {
        streamingIdRef.current = null;
        setBusy(false);
      } else if (msg.type === 'error') {
        streamingIdRef.current = null;
        setBusy(false);
        setError(msg.message);
      } else {
        console.warn('[ai-chat] unhandled WS message type', msg);
      }
    };
    return () => ws.close();
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

  const sendMessage = () => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setError(null);
    setBusy(true);
    setMessages((current) => [...current, { id: `user-${nextMessageId++}`, role: 'user', content: text }]);
    wsRef.current.send(
      JSON.stringify({
        type: 'user_message',
        text,
        ...(focusedResource ? { focusedResource } : {}),
      }),
    );
    setInput('');
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
        <div className="ai-panel">
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

          <ChatMessages messages={messages} />

          {busy && <div className="ai-panel-thinking">{uiText.aiAssistant.thinking}</div>}

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
                  className="ai-send-button"
                  onClick={sendMessage}
                  disabled={!connected || !input.trim()}
                  title={uiText.aiAssistant.send}
                  aria-label={uiText.aiAssistant.send}
                >
                  <SendIcon />
                </button>
              </div>
              {skillsOpen && <SkillsMenu onSelect={applySkill} onClose={() => setSkillsOpen(false)} />}
            </div>
          </div>
        </div>
      </AiEntitlementGate>
    </div>
  );
}
