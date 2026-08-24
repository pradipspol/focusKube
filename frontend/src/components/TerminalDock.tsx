import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { wsUrl, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { podContainers } from '../utils/format';
import { uiText } from '../text';

export type TerminalSession =
  | {
      id: string;
      kind: 'general';
      title: string;
    }
  | {
      id: string;
      kind: 'pod';
      title: string;
      context?: string;
      namespace?: string;
      podName: string;
      container: string;
      shell: string;
    };

export interface OpenPodTerminalRequest {
  context?: string;
  namespace?: string;
  podName: string;
  container: string;
  shell: string;
}

export interface OpenPodLogsTerminalRequest {
  pod: K8sObject;
  context?: string;
  follow?: boolean;
}

export type LogsTerminalSession = {
  id: string;
  kind: 'logs';
  title: string;
  source: 'pod';
  pod: K8sObject;
  context?: string;
  follow?: boolean;
};

export type DockSession = TerminalSession | LogsTerminalSession;

interface Props {
  scope: Scope;
  heightPx: number;
  onHeightChange: (heightPx: number) => void;
  minimized: boolean;
  onMinimizedChange: (minimized: boolean) => void;
  sessions: DockSession[];
  activeSessionId: string;
  onActivateSession: (id: string) => void;
  onNewSession: () => void;
  onCloseSession: (id: string) => void;
}

function themeColor(variable: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
}

function closeSocket(socket: WebSocket | null): void {
  if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.onopen = () => socket.close();
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    return;
  }
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  socket.close();
}

type GeneralMessage =
  | { type: 'OUTPUT'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'DONE'; code: number }
  | { type: 'ERROR'; message: string }
  | { type: 'STOPPED'; code: number };

export function TerminalDock({
  scope,
  heightPx,
  onHeightChange,
  minimized,
  onMinimizedChange,
  sessions,
  activeSessionId,
  onActivateSession,
  onNewSession,
  onCloseSession,
}: Props) {
  const panelRef = useRef<HTMLElement>(null);
  const collapsed = sessions.length === 0;
  const isMinimized = !collapsed && minimized;

  const computeMaxHeight = () => {
    const workspace = panelRef.current?.closest('.main-workspace') as HTMLElement | null;
    const availableHeight = workspace?.getBoundingClientRect().height ?? window.innerHeight;
    // Keep enough room above the terminal for the active tab strip and table/header area.
    return Math.max(220, Math.floor(availableHeight - 120));
  };

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = heightPx;

    const onMove = (moveEvent: MouseEvent) => {
      const maxHeight = computeMaxHeight();
      const nextHeight = Math.min(maxHeight, Math.max(180, startHeight - (moveEvent.clientY - startY)));
      onHeightChange(nextHeight);
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  useEffect(() => {
    const maxHeight = computeMaxHeight();
    if (heightPx > maxHeight) {
      onHeightChange(maxHeight);
    }
  }, [heightPx, onHeightChange]);

  return (
    <section ref={panelRef} className={`terminal-panel ${collapsed ? 'terminal-panel-collapsed' : ''}`} style={{ height: `${collapsed || isMinimized ? 28 : heightPx}px` }}>
      {!collapsed && (
        <div
          className="terminal-resizer"
          onMouseDown={startResize}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal panel"
          title="Drag to resize terminal"
        />
      )}
      <div className="terminal-tabs-bar">
        <div className="terminal-tabs-list">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`terminal-tab ${session.id === activeSessionId ? 'active' : ''}`}
              onClick={() => {
                onMinimizedChange(false);
                onActivateSession(session.id);
              }}
              title={session.kind === 'pod' ? `${session.title} • ${session.podName}` : session.title}
            >
              <span className="terminal-tab-label">{session.title}</span>
              <button
                className="terminal-tab-close"
                title={`Close ${session.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onCloseSession(session.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <div className="terminal-tabs-actions">
          <button
            className="terminal-new-tab-button"
            type="button"
            onClick={onNewSession}
            title="Open new terminal"
          >
            +
          </button>
          <button
            className="terminal-new-tab-button terminal-minimize-button"
            type="button"
            onClick={() => onMinimizedChange(!isMinimized)}
            title={isMinimized ? 'Restore terminals' : 'Minimize all terminals'}
            aria-pressed={isMinimized}
          >
            {isMinimized ? '▢' : '▁'}
          </button>
        </div>
      </div>
      {!collapsed && !isMinimized && (
        <div className="terminal-sessions">
          {sessions.map((session) => (
            <TerminalSessionPane
              key={session.id}
              session={session}
              scope={scope}
              active={session.id === activeSessionId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TerminalSessionPane({ session, scope, active }: { session: DockSession; scope: Scope; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const bufferRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const runningRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [statusText, setStatusText] = useState<string>(session.kind === 'pod' ? uiText.terminalDock.shell : session.kind === 'logs' ? uiText.terminalDock.logs : uiText.terminalDock.ready);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState(0);
  const [searchIndex, setSearchIndex] = useState(0);

  const searchDecorationOptions = useMemo(
    () => ({
      matchBackground: themeColor('--highlight'),
      matchBorder: themeColor('--star'),
      matchOverviewRuler: themeColor('--star'),
      activeMatchBackground: themeColor('--accent-soft-strong'),
      activeMatchBorder: themeColor('--accent'),
      activeMatchColorOverviewRuler: themeColor('--accent'),
    }),
    [],
  );

  const runTerminalSearch = (direction: 'next' | 'previous') => {
    const query = searchQuery.trim();
    const addon = searchAddonRef.current;
    if (!addon || !query) return;
    if (direction === 'next') {
      addon.findNext(query, { decorations: searchDecorationOptions });
    } else {
      addon.findPrevious(query, { decorations: searchDecorationOptions });
    }
  };

  if (session.kind === 'logs') {
    return <DockedPodLogsSessionPane session={session} active={active} />;
  }

  useEffect(() => {
    if (session.kind !== 'general') return;
    const term = termRef.current as (Terminal & { buffer?: { active?: { length: number; viewportY: number; getLine: (index: number) => { translateToString: (trimRight?: boolean) => string } | undefined } } }) | null;
    const query = searchQuery.trim().toLowerCase();
    if (!term || !query) {
      setSearchHits(0);
      setSearchIndex(0);
      searchAddonRef.current?.clearDecorations();
      return;
    }

    setSearchIndex(0);

    const buffer = term.buffer?.active;
    if (!buffer) return;

    if (!searchAddonRef.current) {
      searchAddonRef.current = new SearchAddon({ highlightLimit: 2000 });
      term.loadAddon(searchAddonRef.current);
    }

    const matches: number[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      const line = buffer.getLine(index)?.translateToString(true) ?? '';
      if (line.toLowerCase().includes(query)) {
        matches.push(index);
      }
    }

    setSearchHits(matches.length);
    setSearchIndex((current) => (matches.length === 0 ? 0 : current % matches.length));
    if (matches.length > 0) {
      const target = matches[0];
      const delta = target - buffer.viewportY;
      if (delta !== 0) {
        term.scrollLines(delta);
      }
    }
    searchAddonRef.current.findNext(searchQuery.trim(), { decorations: searchDecorationOptions });
  }, [searchDecorationOptions, searchQuery, session.kind]);

  useLayoutEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      theme: { background: themeColor('--black'), foreground: '#fff' },
      scrollback: 4000,
    });
    const fit = new FitAddon();
    const searchAddon = new SearchAddon({ highlightLimit: 2000 });
    term.loadAddon(fit);
    term.loadAddon(searchAddon);
    term.open(hostRef.current);

    const updateTerminalTheme = () => {
      term.options.theme = {
        ...term.options.theme,
        background: themeColor('--black'),
        foreground: '#fff',
      };
    };
    const themeObserver = new MutationObserver(updateTerminalTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    termRef.current = term;
    fitRef.current = fit;
    searchAddonRef.current = searchAddon;
    disposedRef.current = false;
    let fitFrame: number | null = null;

    const fitTerminal = () => {
      if (disposedRef.current) return;
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        if (disposedRef.current) return;
        try {
          fit.fit();
        } catch {
          /* ignore transient sizing errors */
        }
      });
    };

    if (session.kind === 'general') {
      const prompt = 'focusKube> ';
      const writePrompt = () => {
        term.write(prompt);
        bufferRef.current = '';
        historyIndexRef.current = historyRef.current.length;
      };
      const rewriteLine = (nextValue: string) => {
        bufferRef.current = nextValue;
        term.write(`\r${prompt}${nextValue}\x1b[K`);
      };

      const printBanner = () => {
        term.writeln('FocusKube terminal');
        term.writeln('Direct commands only: kubectl and helm.');
        term.writeln(scope.context ? `Context: ${scope.context}` : 'Context: current session');
        term.writeln(scope.namespace ? `Namespace: ${scope.namespace}` : 'Namespace: all');
        term.writeln('Type help for usage tips.');
        writePrompt();
      };

      const socket = new WebSocket(wsUrl('/ws/terminal', { context: scope.context, namespace: scope.namespace }));
      wsRef.current = socket;

      socket.onopen = () => {
        if (disposedRef.current) return;
        setConnected(true);
        setStatusText('Connected');
        fitTerminal();
        printBanner();
      };

      socket.onmessage = (event) => {
        if (disposedRef.current) return;
        if (typeof event.data !== 'string') return;
        let message: GeneralMessage | undefined;
        try {
          message = JSON.parse(event.data) as GeneralMessage;
        } catch {
          term.write(event.data);
          return;
        }

        if (message.type === 'OUTPUT') {
          term.write(message.text);
          return;
        }

        if (message.type === 'ERROR') {
          runningRef.current = false;
          setStatusText(message.message);
          term.writeln(`\r\n[error] ${message.message}`);
          writePrompt();
          return;
        }

        if (message.type === 'DONE' || message.type === 'STOPPED') {
          runningRef.current = false;
          setStatusText(message.code === 0 ? 'Ready' : `Exit code ${message.code}`);
          if (message.code !== 0) {
            term.writeln(`\r\n[exit code ${message.code}]`);
          } else {
            term.write('\r\n');
          }
          writePrompt();
        }
      };

      socket.onclose = () => {
        if (disposedRef.current) return;
        runningRef.current = false;
        setConnected(false);
        setStatusText('Disconnected');
        term.writeln('\r\n[connection closed]');
      };

      term.onData((data) => {
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

        if (data === '\u0003') {
          if (runningRef.current) {
            wsRef.current.send(JSON.stringify({ type: 'stop' }));
            term.write('^C');
          } else {
            term.write('^C\r\n');
            writePrompt();
          }
          bufferRef.current = '';
          return;
        }

        if (runningRef.current) return;

        if (data === '\r') {
          const command = bufferRef.current.trim();
          term.write('\r\n');
          if (!command) {
            writePrompt();
            return;
          }

          if (command === 'clear' || command === 'cls') {
            term.clear();
            writePrompt();
            return;
          }

          if (command === 'help') {
            term.writeln('Allowed: kubectl and helm only.');
            term.writeln('No pipes, redirects, or shell operators.');
            writePrompt();
            return;
          }

          historyRef.current = [...historyRef.current.filter((entry) => entry !== command), command].slice(-100);
          historyIndexRef.current = historyRef.current.length;
          runningRef.current = true;
          setStatusText('Running');
          wsRef.current.send(JSON.stringify({ type: 'run', command }));
          return;
        }

        if (data === '\u007F') {
          if (!bufferRef.current) return;
          rewriteLine(bufferRef.current.slice(0, -1));
          return;
        }

        if (data === '\u001b[A') {
          if (historyRef.current.length === 0) return;
          historyIndexRef.current = Math.max(0, historyIndexRef.current - 1);
          rewriteLine(historyRef.current[historyIndexRef.current] ?? '');
          return;
        }

        if (data === '\u001b[B') {
          if (historyRef.current.length === 0) return;
          historyIndexRef.current = Math.min(historyRef.current.length, historyIndexRef.current + 1);
          rewriteLine(historyRef.current[historyIndexRef.current] ?? '');
          return;
        }

        if (data === '\u0015') {
          rewriteLine('');
          return;
        }

        if (data === '\u000c') {
          term.clear();
          writePrompt();
          return;
        }

        if (data.length >= 1) {
          rewriteLine(`${bufferRef.current}${data}`);
        }
      });
    } else {
      const socket = new WebSocket(
        wsUrl('/ws/exec', {
          context: session.context,
          namespace: session.namespace,
          pod: session.podName,
          container: session.container,
          command: session.shell,
        }),
      );
      wsRef.current = socket;

      const sendResize = () => {
        if (wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
          wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
        }
      };

      socket.onopen = () => {
        if (disposedRef.current) return;
        setConnected(true);
        setStatusText('Connected');
        fitTerminal();
        sendResize();
      };

      socket.onclose = () => {
        if (disposedRef.current) return;
        setConnected(false);
        setStatusText('Disconnected');
        term.writeln('\r\n\x1b[33m[connection closed]\x1b[0m');
      };

      socket.onmessage = (event) => {
        if (disposedRef.current) return;
        if (typeof event.data === 'string') term.write(event.data);
      };

      term.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(data);
      });
    }

    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
      if (session.kind === 'pod' && wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
      }
    });
    resizeObserver.observe(hostRef.current);
    window.addEventListener('resize', fitTerminal);
    fitTerminal();

    return () => {
      disposedRef.current = true;
      themeObserver.disconnect();
      resizeObserver.disconnect();
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      window.removeEventListener('resize', fitTerminal);
      closeSocket(wsRef.current);
      wsRef.current = null;
      fit.dispose();
      searchAddon.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchAddonRef.current = null;
    };
  }, [scope.context, scope.namespace, session]);

  useEffect(() => {
    if (!active) return;
    let focusFrame: number | null = window.requestAnimationFrame(() => {
      focusFrame = null;
      if (disposedRef.current) return;
      try {
        fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      termRef.current?.focus();
      if (session.kind === 'pod' && wsRef.current?.readyState === WebSocket.OPEN && termRef.current) {
        wsRef.current.send(JSON.stringify({ type: 'resize', cols: termRef.current.cols, rows: termRef.current.rows }));
      }
    });
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [active, session.kind]);

  return (
    <div className={`terminal-session-pane ${active ? 'active' : ''}`} aria-hidden={!active}>
      <div className="terminal-session-header terminal-session-header-searchable">
        <div className="terminal-session-title-group">
          <span className="terminal-session-title">{session.title}</span>
          <span className="terminal-session-meta">
            {session.kind === 'pod'
              ? `${session.namespace ? `${session.namespace} / ` : ''}${session.podName} · ${session.container} · ${session.shell}`
              : scope.context
                ? `Context: ${scope.context}${scope.namespace ? ` / ${scope.namespace}` : ''}`
                : scope.namespace
                  ? `Namespace: ${scope.namespace}`
                  : 'Context: current session'}
          </span>
        </div>
        <div className="terminal-session-status-group terminal-session-status-group-search">
          <input
            className="terminal-session-search-input"
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchIndex(0);
            }}
            placeholder={uiText.terminalDock.searchTerminal}
            aria-label={uiText.terminalDock.searchTerminalContents}
          />
          <button className="terminal-search-nav-button" type="button" onClick={() => { setSearchIndex((current) => (searchHits ? (current - 1 + searchHits) % searchHits : 0)); runTerminalSearch('previous'); }} disabled={!searchQuery.trim()}>
            Prev
          </button>
          <button className="terminal-search-nav-button" type="button" onClick={() => { setSearchIndex((current) => current + 1); runTerminalSearch('next'); }} disabled={!searchQuery.trim()}>
            Next
          </button>
          <span className="terminal-session-search-count">
            {searchQuery.trim() ? `${searchHits ? `${Math.min(searchIndex + 1, searchHits)}/${searchHits}` : '0/0'} matches` : 'scrollback'}
          </span>
          <span className={`badge ${connected ? 'ok' : 'warn'}`}>{connected ? 'connected' : 'disconnected'}</span>
                    <span className={`badge ${connected ? 'ok' : 'warn'}`}>{connected ? uiText.terminalDock.connected : uiText.terminalDock.disconnected}</span>
          {/* <span className="terminal-session-status">{statusText}</span> */}
        </div>
      </div>
      <div className="terminal-session-body">
        <div className="terminal-host terminal-shell" ref={hostRef} />
      </div>
    </div>
  );
}

function DockedPodLogsSessionPane({ session, active }: { session: Extract<LogsTerminalSession, { source: 'pod' }>; active: boolean }) {
  const containers = podContainers(session.pod);
  const [container, setContainer] = useState(containers[0] ?? '');
  const [follow, setFollow] = useState(session.follow ?? true);
  const [connected, setConnected] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [logText, setLogText] = useState('');
  const hostRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const shouldScrollRef = useRef(false);

  useEffect(() => {
    if (!container) return;
    setLogText('');
    setSearchIndex(0);

    const url = wsUrl('/ws/logs', {
      context: session.context,
      namespace: session.pod.metadata?.namespace,
      pod: session.pod.metadata?.name,
      container,
      follow: String(follow),
      tailLines: '500',
    });
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (event) => {
      const chunk = typeof event.data === 'string' ? event.data : '';
      const hostNow = hostRef.current;
      const atBottom = hostNow ? hostNow.scrollHeight - hostNow.scrollTop - hostNow.clientHeight < 40 : false;
      shouldScrollRef.current = follow && atBottom;
      setLogText((current) => `${current}${chunk}`);
    };
    return () => closeSocket(ws);
  }, [container, follow, session]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !shouldScrollRef.current) return;
    host.scrollTop = host.scrollHeight;
    shouldScrollRef.current = false;
  }, [logText, searchQuery]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const lines = useMemo(() => logText.split(/\r?\n/), [logText]);
  const matchingLineIndexes = useMemo(() => {
    if (!normalizedQuery) return [] as number[];
    const matches: number[] = [];
    lines.forEach((line, index) => {
      if (line.toLowerCase().includes(normalizedQuery)) matches.push(index);
    });
    return matches;
  }, [lines, normalizedQuery]);
  const activeLineIndex = matchingLineIndexes.length > 0 ? matchingLineIndexes[searchIndex % matchingLineIndexes.length] : -1;
  const activeLineRef = useRef<HTMLDivElement | null>(null);

  const matchCount = matchingLineIndexes.length;

  useEffect(() => {
    setSearchIndex((current) => (matchCount > 0 ? current % matchCount : 0));
  }, [matchCount]);

  useEffect(() => {
    if (!activeLineRef.current) return;
    activeLineRef.current.scrollIntoView({ block: 'center' });
  }, [activeLineIndex]);

  const renderLine = (line: string, index: number) => {
    if (!normalizedQuery) return line;
    const lower = line.toLowerCase();
    const start = lower.indexOf(normalizedQuery);
    if (start < 0) return line;
    const before = line.slice(0, start);
    const match = line.slice(start, start + normalizedQuery.length);
    const after = line.slice(start + normalizedQuery.length);
    return (
      <>
        {before}
        <mark className="terminal-session-search-highlight">{match}</mark>
        {after}
      </>
    );
  };

  return (
    <div className={`terminal-session-pane ${active ? 'active' : ''}`} aria-hidden={!active}>
      <div className="terminal-session-header terminal-session-header-logs">
        <div className="terminal-session-title-group terminal-session-title-group-search">
          <span className="terminal-session-title">{session.title}</span>
          <span className="terminal-session-meta">Pod logs</span>
          <input
            className="terminal-session-search-input"
            type="search"
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchIndex(0);
            }}
            placeholder="Search pod logs"
            aria-label="Search pod logs"
          />
          <span className="terminal-session-search-count">{normalizedQuery ? `${matchCount} matches` : 'all lines'}</span>
          <button className="terminal-search-nav-button" type="button" onClick={() => setSearchIndex((current) => (matchCount ? (current - 1 + matchCount) % matchCount : 0))} disabled={!normalizedQuery}>
            Prev
          </button>
          <button className="terminal-search-nav-button" type="button" onClick={() => setSearchIndex((current) => (matchCount ? (current + 1) % matchCount : 0))} disabled={!normalizedQuery}>
            Next
          </button>
        </div>
        <div className="terminal-session-status-group terminal-session-status-group-logs">
          <div className="field terminal-session-log-field">
            <label>Container</label>
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              {containers.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </div>
          <label className="field terminal-session-log-follow">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            Follow
          </label>
          <span className={`badge ${connected ? 'ok' : 'warn'}`}>{connected ? 'streaming' : 'disconnected'}</span>
        </div>
      </div>
      <div className="terminal-session-body terminal-session-body-logs">
        <div className="logs-host terminal-session-logs-host" ref={hostRef}>
          {lines.map((line, index) => (
            <div
              key={`${index}-${line.slice(0, 12)}`}
              ref={index === activeLineIndex ? activeLineRef : undefined}
              className={`terminal-session-log-line ${index === activeLineIndex ? 'terminal-session-log-line-active' : ''}`}
            >
              {renderLine(line, index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

