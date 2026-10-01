import { useSyncExternalStore } from 'react';

export interface EditorPreferences {
  fontSize: number;
  fontFamily: string;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCursorBlink: boolean;
}

export const DEFAULT_MONO_FONT = 'SFMono-Regular, Consolas, monospace';

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  fontSize: 13,
  fontFamily: DEFAULT_MONO_FONT,
  tabSize: 2,
  wordWrap: false,
  minimap: false,
  lineNumbers: true,
  terminalFontSize: 12,
  terminalFontFamily: DEFAULT_MONO_FONT,
  terminalCursorBlink: true,
};

const STORAGE_KEY = 'k8sExplorer.editorPreferences';
const listeners = new Set<() => void>();

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function sanitize(raw: Partial<EditorPreferences>): EditorPreferences {
  const d = DEFAULT_EDITOR_PREFERENCES;
  const font = (value: unknown, fallback: string) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback);
  return {
    fontSize: clamp(raw.fontSize, 8, 32, d.fontSize),
    fontFamily: font(raw.fontFamily, d.fontFamily),
    tabSize: clamp(raw.tabSize, 1, 8, d.tabSize),
    wordWrap: typeof raw.wordWrap === 'boolean' ? raw.wordWrap : d.wordWrap,
    minimap: typeof raw.minimap === 'boolean' ? raw.minimap : d.minimap,
    lineNumbers: typeof raw.lineNumbers === 'boolean' ? raw.lineNumbers : d.lineNumbers,
    terminalFontSize: clamp(raw.terminalFontSize, 8, 32, d.terminalFontSize),
    terminalFontFamily: font(raw.terminalFontFamily, d.terminalFontFamily),
    terminalCursorBlink: typeof raw.terminalCursorBlink === 'boolean' ? raw.terminalCursorBlink : d.terminalCursorBlink,
  };
}

function read(): EditorPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitize(raw ? (JSON.parse(raw) as Partial<EditorPreferences>) : {});
  } catch {
    return DEFAULT_EDITOR_PREFERENCES;
  }
}

let snapshot = read();

export function getEditorPreferences(): EditorPreferences {
  return snapshot;
}

export function setEditorPreferences(next: Partial<EditorPreferences>): void {
  snapshot = sanitize({ ...snapshot, ...next });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useEditorPreferences(): EditorPreferences {
  return useSyncExternalStore(subscribe, getEditorPreferences);
}

/** Monaco editor options derived from the user's editor preferences. */
export function monacoOptions(prefs: EditorPreferences) {
  return {
    fontSize: prefs.fontSize,
    fontFamily: prefs.fontFamily,
    tabSize: prefs.tabSize,
    wordWrap: prefs.wordWrap ? ('on' as const) : ('off' as const),
    minimap: { enabled: prefs.minimap },
    lineNumbers: prefs.lineNumbers ? ('on' as const) : ('off' as const),
    scrollBeyondLastLine: false,
  };
}

/** xterm options derived from the user's terminal preferences. */
export function terminalOptions(prefs: EditorPreferences) {
  return {
    fontSize: prefs.terminalFontSize,
    fontFamily: prefs.terminalFontFamily,
    cursorBlink: prefs.terminalCursorBlink,
  };
}
