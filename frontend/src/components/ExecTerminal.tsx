import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { wsUrl } from '../api/client';
import type { K8sObject } from '../api/types';
import { podContainers } from '../utils/format';
import type { OpenPodTerminalRequest } from './TerminalDock';
import { uiText } from '../text';

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

interface Props {
  pod: K8sObject;
  context?: string;
  onOpenInTerminal?: (request: OpenPodTerminalRequest) => void;
}

export function ExecTerminal({ pod, context, onOpenInTerminal }: Props) {
  const containers = podContainers(pod);
  const [container, setContainer] = useState(containers[0] ?? '');
  const [shell, setShell] = useState('/bin/sh');
  const [connected, setConnected] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const themeColor = (variable: string) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim();

  useEffect(() => {
    if (!container || !hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Consolas, monospace',
      fontSize: 13,
      theme: { background: themeColor('--black'), foreground: '#fff' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();

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

    const url = wsUrl('/ws/exec', {
      context,
      namespace: pod.metadata?.namespace,
      pod: pod.metadata?.name,
      container,
      command: shell,
    });
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      sendResize();
    };
    ws.onclose = () => {
      setConnected(false);
      term.writeln('\r\n\x1b[33m[connection closed]\x1b[0m');
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') term.write(e.data);
    };

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const onResize = () => {
      if (!termRef.current) return;
      fit.fit();
      sendResize();
    };
    window.addEventListener('resize', onResize);

    return () => {
      themeObserver.disconnect();
      window.removeEventListener('resize', onResize);
      fit.dispose();
      closeSocket(ws);
      term.dispose();
    };
  }, [container, shell, context, pod]);

  return (
    <div className="drawer-body">
      <div className="actions-bar">
        <div className="field">
          <label>{uiText.exec.container}</label>
          <select value={container} onChange={(e) => setContainer(e.target.value)}>
            {containers.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>{uiText.exec.shell}</label>
          <select value={shell} onChange={(e) => setShell(e.target.value)}>
            <option value="/bin/sh">/bin/sh</option>
            <option value="/bin/bash">/bin/bash</option>
            <option value="/bin/ash">/bin/ash</option>
          </select>
        </div>
        {onOpenInTerminal && (
          <div className="field">
            <label>{uiText.exec.terminal}</label>
            <button
              type="button"
              className="primary"
              onClick={() =>
                onOpenInTerminal({
                  context,
                  namespace: pod.metadata?.namespace,
                  podName: pod.metadata?.name ?? 'pod',
                  container,
                  shell,
                })
              }
              disabled={!container}
            >
              {uiText.exec.openInTerminal}
            </button>
          </div>
        )}
        <span className={`badge ${connected ? 'ok' : 'warn'} right`}>
          {connected ? uiText.exec.connected : uiText.exec.disconnected}
        </span>
      </div>
      <div className="terminal-host" ref={hostRef} />
    </div>
  );
}
