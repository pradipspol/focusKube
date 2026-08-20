import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl, type Scope } from '../api/client';

interface Props {
  scope: Scope;
  heightPx: number;
  onHeightChange: (heightPx: number) => void;
}

type TerminalSocketMessage =
  | { type: 'OUTPUT'; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'DONE'; code: number }
  | { type: 'ERROR'; message: string }
  | { type: 'STOPPED'; code: number };

const PROMPT = 'k8-explorer> ';

export function CommandTerminal({ scope, heightPx, onHeightChange }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const bufferRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);
  const runningRef = useRef(false);
  const [connected, setConnected] = useState(false);
  const [statusText, setStatusText] = useState('Ready');

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#000000' },
      scrollback: 4000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    termRef.current = term;
    fitRef.current = fit;

    const writePrompt = () => {
      term.write(PROMPT);
      bufferRef.current = '';
      historyIndexRef.current = historyRef.current.length;
    };

    const rewriteLine = (nextValue: string) => {
      bufferRef.current = nextValue;
      term.write(`\r${PROMPT}${nextValue}\x1b[K`);
    };

    const printBanner = () => {
      term.writeln('K8 Explorer terminal');
      term.writeln('Direct commands only: kubectl and helm.');
      term.writeln(scope.context ? `Context: ${scope.context}` : 'Context: current session');
      term.writeln(scope.namespace ? `Namespace: ${scope.namespace}` : 'Namespace: all');
      term.writeln('Type help for usage tips.');
      writePrompt();
    };

    const fitTerminal = () => {
      window.requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* ignore transient sizing errors */
        }
      });
    };

    const socket = new WebSocket(wsUrl('/ws/terminal', { context: scope.context, namespace: scope.namespace }));
    wsRef.current = socket;
    disposedRef.current = false;

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
      let message: TerminalSocketMessage | undefined;
      try {
        message = JSON.parse(event.data) as TerminalSocketMessage;
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

    const observer = new ResizeObserver(() => fitTerminal());
    observer.observe(hostRef.current);
    window.addEventListener('resize', fitTerminal);
    fitTerminal();

    return () => {
      disposedRef.current = true;
      observer.disconnect();
      window.removeEventListener('resize', fitTerminal);
      socket.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [scope.context, scope.namespace]);

  const startResize = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = heightPx;

    const onMove = (moveEvent: MouseEvent) => {
      const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.7));
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

  return (
    <section className="terminal-panel" style={{ height: `${heightPx}px` }}>
      <div
        className="terminal-resizer"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal panel"
        title="Drag to resize terminal"
      />
      <div className="terminal-panel-header">
        <div className="terminal-panel-title-group">
          <span className="terminal-panel-title">Terminal</span>
          <span className="terminal-panel-meta">{scope.context ? scope.context : 'current context'}{scope.namespace ? ` / ${scope.namespace}` : ''}</span>
        </div>
        <div className="terminal-panel-status-group">
          <span className={`badge ${connected ? 'ok' : 'warn'}`}>{connected ? 'connected' : 'disconnected'}</span>
          <span className="terminal-panel-status">{statusText}</span>
        </div>
      </div>
      <div className="terminal-panel-body">
        <div className="terminal-host terminal-shell" ref={hostRef} />
      </div>
    </section>
  );
}