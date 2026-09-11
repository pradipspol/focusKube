import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Scope } from '../api/client';
import { openAiChatSocket, type AiChatInboundMessage, type AiFocusedResource } from '../api/aiAssistantApi';
import { AiEntitlementGate } from './AiEntitlementGate';
import { uiText } from '../text';

interface Props {
  scope: Scope;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

let nextMessageId = 1;

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
          <div className="ai-panel-message-bubble">{message.content}</div>
        </div>
      ))}
    </div>
  );
}

export function AiAssistantPanel({ scope }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  const { data: kindsData } = useQuery({
    queryKey: ['ai', 'resource-kinds'],
    queryFn: () => api.getKinds(),
    staleTime: Infinity,
  });
  const kinds = useMemo(
    () => (kindsData ?? []).filter((k) => k.namespaced).map((k) => k.kind).sort(),
    [kindsData],
  );

  useEffect(() => {
    const ws = openAiChatSocket(scope.context);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setError(uiText.aiAssistant.connectionError);
    ws.onmessage = (event) => {
      let msg: AiChatInboundMessage;
      try {
        msg = JSON.parse(event.data);
      } catch {
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
      }
    };
    return () => ws.close();
  }, [scope.context]);

  const sendMessage = () => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    setError(null);
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

  return (
    <AiEntitlementGate>
      <div className="ai-panel">
        <div className="ai-panel-header">
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
        </div>

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
          <textarea
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
            rows={2}
          />
          <button type="button" className="primary" onClick={sendMessage} disabled={!connected || !input.trim()}>
            {uiText.aiAssistant.send}
          </button>
        </div>
      </div>
    </AiEntitlementGate>
  );
}
