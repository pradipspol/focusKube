import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppWindow, BarChart3, Code2, Network, Plug } from 'lucide-react';
import { useAiEntitlement } from '../api/aiAssistantApi';
import { api } from '../api/client';
import type {
  AppSettingsResponse,
  LogLevel,
  McpSettings,
  NetworkSettings,
  ProxyMode,
  TelemetrySettings,
} from '../api/types';
import type { Theme } from '../App';
import {
  DEFAULT_EDITOR_PREFERENCES,
  getEditorPreferences,
  setEditorPreferences,
  type EditorPreferences,
} from '../lib/editorPreferences';
import { uiText } from '../text';
import { useConfirm } from './ConfirmDialog';
import { Modal } from './Modal';
import { Notice } from './Notice';

type SectionId = 'app' | 'editor' | 'integrations' | 'network' | 'telemetry';

const SECTIONS: Array<{ id: SectionId; label: string; icon: ReactNode }> = [
  { id: 'app', label: uiText.settings.sections.app, icon: <AppWindow size={15} aria-hidden="true" /> },
  { id: 'editor', label: uiText.settings.sections.editor, icon: <Code2 size={15} aria-hidden="true" /> },
  { id: 'integrations', label: uiText.settings.sections.integrations, icon: <Plug size={15} aria-hidden="true" /> },
  { id: 'network', label: uiText.settings.sections.network, icon: <Network size={15} aria-hidden="true" /> },
  { id: 'telemetry', label: uiText.settings.sections.telemetry, icon: <BarChart3 size={15} aria-hidden="true" /> },
];

const LEVEL_OPTIONS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const THEME_OPTIONS: Array<{ value: Theme; label: string }> = [
  { value: 'dark', label: uiText.theme.dark },
  { value: 'light', label: uiText.theme.light },
  { value: 'contrast', label: uiText.theme.contrast },
];
const FONT_FAMILY_OPTIONS = [
  'SFMono-Regular, Consolas, monospace',
  'Consolas, monospace',
  "'Cascadia Code', Consolas, monospace",
  "'Fira Code', monospace",
  "'JetBrains Mono', monospace",
  "Menlo, Monaco, 'Courier New', monospace",
  "'Courier New', monospace",
];

const errorMessage = (err: unknown, fallback: string) => (err instanceof Error ? err.message : fallback);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Props {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onClose: () => void;
}

export function SettingsModal({ theme, onThemeChange, onClose }: Props) {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<SectionId>('app');
  const [selectedTheme, setSelectedTheme] = useState<Theme>(theme);
  const [selectedLevel, setSelectedLevel] = useState<LogLevel>('info');
  const [editorDraft, setEditorDraft] = useState<EditorPreferences>(() => getEditorPreferences());
  const [networkDraft, setNetworkDraft] = useState<NetworkSettings | null>(null);
  const [telemetryDraft, setTelemetryDraft] = useState<TelemetrySettings | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpSettings | null>(null);
  const [saveError, setSaveError] = useState('');

  const logLevelQuery = useQuery({ queryKey: ['settings', 'log-level'], queryFn: () => api.getLogLevel() });
  const appSettingsQuery = useQuery({ queryKey: ['settings', 'app'], queryFn: () => api.getAppSettings() });

  useEffect(() => {
    if (logLevelQuery.data?.level) setSelectedLevel(logLevelQuery.data.level);
  }, [logLevelQuery.data?.level]);

  useEffect(() => {
    const data = appSettingsQuery.data;
    if (!data) return;
    setNetworkDraft((current) => current ?? data.network);
    setTelemetryDraft((current) => current ?? data.telemetry);
    setMcpDraft((current) => current ?? { enabled: data.mcp.enabled, port: data.mcp.port, allowWrite: data.mcp.allowWrite });
  }, [appSettingsQuery.data]);

  const save = useMutation({
    mutationFn: async () => {
      if (logLevelQuery.data?.editable && selectedLevel !== logLevelQuery.data.level) {
        await api.setLogLevel(selectedLevel);
      }
      const saved = appSettingsQuery.data;
      const patch: Parameters<typeof api.updateAppSettings>[0] = {};
      if (saved && networkDraft && !sameJson(networkDraft, saved.network)) patch.network = networkDraft;
      if (saved && telemetryDraft && !sameJson(telemetryDraft, saved.telemetry)) patch.telemetry = telemetryDraft;
      if (saved && mcpDraft && !sameJson(mcpDraft, { enabled: saved.mcp.enabled, port: saved.mcp.port, allowWrite: saved.mcp.allowWrite })) {
        patch.mcp = mcpDraft;
      }
      if (Object.keys(patch).length > 0) {
        const result = await api.updateAppSettings(patch);
        queryClient.setQueryData(['settings', 'app'], result);
        if (patch.network) await window.desktopMenu?.setNetworkProxy?.(result.network);
      }
      setEditorPreferences(editorDraft);
      onThemeChange(selectedTheme);
    },
    onMutate: () => setSaveError(''),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      onClose();
    },
    onError: (err) => setSaveError(errorMessage(err, uiText.settings.saveFailed)),
  });

  const loading = logLevelQuery.isLoading || appSettingsQuery.isLoading;

  return (
    <Modal
      title={uiText.settings.title}
      onClose={onClose}
      cardClassName="settings-modal"
      bodyClassName="settings-modal-body"
      closeLabel={uiText.topbar.closeSettings}
      footer={(
        <>
          {saveError && <Notice variant="error" className="settings-footer-error">{saveError}</Notice>}
          <button type="button" onClick={onClose} disabled={save.isPending}>{uiText.common.cancel}</button>
          <button type="button" className="primary" onClick={() => save.mutate()} disabled={save.isPending || loading}>
            {save.isPending ? uiText.topbar.saving : uiText.common.save}
          </button>
        </>
      )}
    >
      <nav className="settings-nav" role="tablist" aria-orientation="vertical">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className={`settings-nav-item ${section === item.id ? 'active' : ''}`}
            onClick={() => setSection(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-panel" role="tabpanel" aria-label={SECTIONS.find((s) => s.id === section)?.label}>
        {loading ? (
          <div className="dim">{uiText.modal.loadingSettings}</div>
        ) : (
          <>
            {appSettingsQuery.error && (
              <Notice variant="error">{errorMessage(appSettingsQuery.error, uiText.settings.loadFailed)}</Notice>
            )}
            {section === 'app' && (
              <AppSection
                theme={selectedTheme}
                onThemeChange={setSelectedTheme}
                level={selectedLevel}
                onLevelChange={setSelectedLevel}
                logLevel={logLevelQuery.data}
              />
            )}
            {section === 'editor' && <EditorSection draft={editorDraft} onChange={setEditorDraft} />}
            {section === 'integrations' && (
              <IntegrationsSection settings={appSettingsQuery.data} mcpDraft={mcpDraft} onMcpChange={setMcpDraft} />
            )}
            {section === 'network' && networkDraft && <NetworkSection draft={networkDraft} onChange={setNetworkDraft} />}
            {section === 'telemetry' && telemetryDraft && (
              <TelemetrySection draft={telemetryDraft} onChange={setTelemetryDraft} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function SettingsGroup({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h4 className="settings-group-title">{title}</h4>
      {description && <p className="dim settings-group-description">{description}</p>}
      {children}
    </section>
  );
}

function Row({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <label className="settings-field" htmlFor={htmlFor}>{label}</label>
      <div className="settings-control">
        {children}
        {hint && <div className="dim settings-hint">{hint}</div>}
      </div>
    </div>
  );
}

function Toggle({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className="settings-toggle" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function AppSection({
  theme,
  onThemeChange,
  level,
  onLevelChange,
  logLevel,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  level: LogLevel;
  onLevelChange: (level: LogLevel) => void;
  logLevel: Awaited<ReturnType<typeof api.getLogLevel>> | undefined;
}) {
  return (
    <SettingsGroup title={uiText.settings.sections.app}>
      <Row label={uiText.topbar.theme} htmlFor="settings-theme">
        <select id="settings-theme" value={theme} onChange={(e) => onThemeChange(e.target.value as Theme)}>
          {THEME_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </Row>
      <Row
        label={uiText.topbar.logLevel}
        htmlFor="settings-log-level"
        hint={(
          <>
            {uiText.topbar.effectivePrefix} {logLevel?.level?.toUpperCase() ?? 'N/A'}
            {logLevel?.envLevel ? ` | ${uiText.topbar.envPrefix} ${logLevel.envLevel.toUpperCase()}` : ''}
            {logLevel?.overriddenByUi ? ` | ${uiText.topbar.uiOverrideActive}` : ''}
            {!logLevel?.editable && <div>{uiText.topbar.desktopOnly}</div>}
          </>
        )}
      >
        <select
          id="settings-log-level"
          value={level}
          onChange={(e) => onLevelChange(e.target.value as LogLevel)}
          disabled={!logLevel?.editable}
        >
          {LEVEL_OPTIONS.map((option) => (
            <option key={option} value={option}>{option.toUpperCase()}</option>
          ))}
        </select>
      </Row>
    </SettingsGroup>
  );
}

function FontFamilyInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const listId = `${id}-options`;
  return (
    <>
      <input id={id} type="text" list={listId} value={value} onChange={(e) => onChange(e.target.value)} />
      <datalist id={listId}>
        {FONT_FAMILY_OPTIONS.map((font) => <option key={font} value={font} />)}
      </datalist>
    </>
  );
}

function EditorSection({ draft, onChange }: { draft: EditorPreferences; onChange: (next: EditorPreferences) => void }) {
  const text = uiText.settings.editor;
  const update = (patch: Partial<EditorPreferences>) => onChange({ ...draft, ...patch });
  const numberValue = (value: string) => Number.parseInt(value, 10);
  return (
    <>
      <SettingsGroup title={text.editorHeading}>
        <Row label={text.fontSize} htmlFor="settings-editor-font-size">
          <input id="settings-editor-font-size" type="number" min={8} max={32} value={draft.fontSize} onChange={(e) => update({ fontSize: numberValue(e.target.value) })} />
        </Row>
        <Row label={text.fontFamily} htmlFor="settings-editor-font-family">
          <FontFamilyInput id="settings-editor-font-family" value={draft.fontFamily} onChange={(fontFamily) => update({ fontFamily })} />
        </Row>
        <Row label={text.tabSize} htmlFor="settings-editor-tab-size">
          <select id="settings-editor-tab-size" value={draft.tabSize} onChange={(e) => update({ tabSize: numberValue(e.target.value) })}>
            {[2, 4, 8].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </Row>
        <div className="settings-toggles">
          <Toggle id="settings-editor-word-wrap" label={text.wordWrap} checked={draft.wordWrap} onChange={(wordWrap) => update({ wordWrap })} />
          <Toggle id="settings-editor-minimap" label={text.minimap} checked={draft.minimap} onChange={(minimap) => update({ minimap })} />
          <Toggle id="settings-editor-line-numbers" label={text.lineNumbers} checked={draft.lineNumbers} onChange={(lineNumbers) => update({ lineNumbers })} />
        </div>
        <pre className="settings-font-preview" style={{ fontFamily: draft.fontFamily, fontSize: `${draft.fontSize}px` }}>
          {'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: preview'}
        </pre>
      </SettingsGroup>
      <SettingsGroup title={text.terminalHeading}>
        <Row label={text.fontSize} htmlFor="settings-terminal-font-size">
          <input id="settings-terminal-font-size" type="number" min={8} max={32} value={draft.terminalFontSize} onChange={(e) => update({ terminalFontSize: numberValue(e.target.value) })} />
        </Row>
        <Row label={text.fontFamily} htmlFor="settings-terminal-font-family">
          <FontFamilyInput id="settings-terminal-font-family" value={draft.terminalFontFamily} onChange={(terminalFontFamily) => update({ terminalFontFamily })} />
        </Row>
        <div className="settings-toggles">
          <Toggle id="settings-terminal-cursor-blink" label={text.cursorBlink} checked={draft.terminalCursorBlink} onChange={(terminalCursorBlink) => update({ terminalCursorBlink })} />
        </div>
      </SettingsGroup>
      <div>
        <button type="button" onClick={() => onChange(DEFAULT_EDITOR_PREFERENCES)}>{text.resetDefaults}</button>
      </div>
    </>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? uiText.settings.copied : uiText.settings.copy}
    </button>
  );
}

function IntegrationsSection({
  settings,
  mcpDraft,
  onMcpChange,
}: {
  settings: AppSettingsResponse | undefined;
  mcpDraft: McpSettings | null;
  onMcpChange: (next: McpSettings) => void;
}) {
  const text = uiText.settings.integrations;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [actionError, setActionError] = useState('');

  const contextsQuery = useQuery({ queryKey: ['contexts'], queryFn: api.getContexts, refetchOnWindowFocus: false });
  const awsQuery = useQuery({ queryKey: ['aws', 'account'], queryFn: api.awsAccount });
  const azureQuery = useQuery({ queryKey: ['azure', 'accounts', 'cloud'], queryFn: () => api.azureAccounts('cloud') });

  const contexts = contextsQuery.data?.contexts ?? [];
  const eksContexts = contexts.filter((c) => c.source?.provider === 'eks');
  const aksContexts = contexts.filter((c) => c.source?.provider === 'aks');
  const localKubeconfigs = contextsQuery.data?.localKubeconfigs ?? [];

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError('');
    try {
      await action();
    } catch (err) {
      setActionError(errorMessage(err, uiText.settings.saveFailed));
    }
  };

  const signOutAws = () => runAction(async () => {
    if (!(await confirm({ title: text.signOutAwsTitle, message: text.signOutAwsMessage, confirmLabel: uiText.settings.signOut, tone: 'danger' }))) return;
    await api.awsLogout();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['aws'] }),
      queryClient.invalidateQueries({ queryKey: ['contexts'] }),
    ]);
  });

  const disconnectAzure = (email: string) => runAction(async () => {
    if (!(await confirm({ title: text.disconnectAzureTitle, message: text.disconnectAzureMessage(email), confirmLabel: uiText.settings.disconnect, tone: 'danger' }))) return;
    await api.azureDisconnectAccount(email);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['azure'] }),
      queryClient.invalidateQueries({ queryKey: ['contexts'] }),
    ]);
  });

  const removeKubeconfig = (id: string, name: string) => runAction(async () => {
    if (!(await confirm({ title: text.removeKubeconfigTitle, message: text.removeKubeconfigMessage(name), confirmLabel: uiText.settings.remove, tone: 'danger' }))) return;
    const result = await api.deleteLocalKubeconfig(id);
    queryClient.setQueryData(['contexts'], result);
  });

  return (
    <>
      {actionError && <Notice variant="error">{actionError}</Notice>}
      <SettingsGroup title={text.awsHeading}>
        {awsQuery.isLoading ? (
          <div className="dim">{uiText.common.loading}</div>
        ) : awsQuery.data?.account ? (
          <ul className="settings-list">
            <li className="settings-list-item">
              <div>
                <div className="settings-list-title">{text.awsAccount} {awsQuery.data.account.account}</div>
                <div className="dim settings-list-meta" title={awsQuery.data.account.arn}>{awsQuery.data.account.arn}</div>
                <div className="dim settings-list-meta">{text.clusters(eksContexts.length)}</div>
              </div>
              <button type="button" onClick={() => void signOutAws()}>{uiText.settings.signOut}</button>
            </li>
          </ul>
        ) : (
          <div className="dim">{text.awsNotSignedIn}</div>
        )}
      </SettingsGroup>

      <SettingsGroup title={text.azureHeading}>
        {azureQuery.isLoading ? (
          <div className="dim">{uiText.common.loading}</div>
        ) : (azureQuery.data?.accounts ?? []).length > 0 ? (
          <ul className="settings-list">
            {azureQuery.data!.accounts.map((account) => (
              <li key={account.id} className="settings-list-item">
                <div>
                  <div className="settings-list-title">{account.email}</div>
                  <div className="dim settings-list-meta">
                    {text.subscriptions(account.subscriptions.length)}
                    {' · '}
                    {text.clusters(aksContexts.filter((c) => account.subscriptions.some((s) => s.id === c.source?.subscriptionId)).length)}
                  </div>
                </div>
                <button type="button" onClick={() => void disconnectAzure(account.email)}>{uiText.settings.disconnect}</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="dim">{text.azureNoAccounts}</div>
        )}
      </SettingsGroup>

      <SettingsGroup title={text.localHeading}>
        {contextsQuery.isLoading ? (
          <div className="dim">{uiText.common.loading}</div>
        ) : localKubeconfigs.length > 0 ? (
          <ul className="settings-list">
            {localKubeconfigs.map((file) => (
              <li key={file.id} className="settings-list-item">
                <div>
                  <div className="settings-list-title">{file.name}</div>
                  <div className="dim settings-list-meta" title={file.contexts.join(', ')}>
                    {text.contexts(file.contexts.length)}
                    {file.contexts.length > 0 ? ` — ${file.contexts.join(', ')}` : ''}
                  </div>
                </div>
                <button type="button" onClick={() => void removeKubeconfig(file.id, file.name)}>{uiText.settings.remove}</button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="dim">{text.localNone}</div>
        )}
      </SettingsGroup>

      {settings && mcpDraft && <McpGroup settings={settings} draft={mcpDraft} onChange={onMcpChange} />}
    </>
  );
}

function McpGroup({ settings, draft, onChange }: { settings: AppSettingsResponse; draft: McpSettings; onChange: (next: McpSettings) => void }) {
  const text = uiText.settings.integrations;
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const entitlementQuery = useAiEntitlement();
  const [showToken, setShowToken] = useState(false);
  const regenerate = useMutation({
    mutationFn: () => api.regenerateMcpToken(),
    onSuccess: (result) => queryClient.setQueryData(['settings', 'app'], result),
  });

  const { status, token } = settings.mcp;
  const plan = entitlementQuery.data?.plan;
  const hasPaidAccess = entitlementQuery.data?.enabled && ['trial', 'pro', 'team', 'dev'].includes(plan ?? '');
  const url = `http://127.0.0.1:${draft.port}/mcp`;
  const dirty = draft.enabled !== settings.mcp.enabled || draft.port !== settings.mcp.port || draft.allowWrite !== settings.mcp.allowWrite;

  const vsCodeConfig = useMemo(
    () => JSON.stringify({ servers: { focuskube: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    [token, url],
  );
  const claudeConfig = useMemo(
    () => JSON.stringify(
      { mcpServers: { focuskube: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`] } } },
      null,
      2,
    ),
    [token, url],
  );
  const mask = (value: string) => (showToken ? value : value.split(token).join('•'.repeat(12)));

  return (
    <SettingsGroup title={text.aiHeading} description={text.mcpDescription}>
      {!entitlementQuery.isLoading && !hasPaidAccess && (
        <Notice variant="warning">{text.mcpPaidRequired}</Notice>
      )}
      <div className="settings-toggles">
        <Toggle id="settings-mcp-enabled" label={text.mcpEnable} checked={draft.enabled} disabled={!hasPaidAccess && !draft.enabled} onChange={(enabled) => onChange({ ...draft, enabled })} />
      </div>
      <Row label={text.mcpPort} htmlFor="settings-mcp-port">
        <input
          id="settings-mcp-port"
          type="number"
          min={1024}
          max={65535}
          value={draft.port}
          onChange={(e) => onChange({ ...draft, port: Number.parseInt(e.target.value, 10) || 0 })}
        />
      </Row>
      <div className="settings-toggles">
        <Toggle id="settings-mcp-write" label={text.mcpAllowWrite} checked={draft.allowWrite} onChange={(allowWrite) => onChange({ ...draft, allowWrite })} />
        <div className="dim settings-hint">{text.mcpAllowWriteHint}</div>
      </div>
      <Row label={text.mcpStatus}>
        <span className={`settings-status ${status.running ? 'ok' : status.error ? 'error' : ''}`}>
          {status.running && status.url ? text.mcpRunning(status.url) : status.error ? text.mcpError(status.error) : text.mcpStopped}
        </span>
        {dirty && <div className="dim settings-hint">{text.mcpSaveFirst}</div>}
      </Row>
      <Row label={text.mcpToken} htmlFor="settings-mcp-token">
        <div className="settings-inline">
          <input id="settings-mcp-token" type={showToken ? 'text' : 'password'} value={token} readOnly className="mono" />
          <button type="button" onClick={() => setShowToken((v) => !v)}>{showToken ? uiText.settings.hide : uiText.settings.show}</button>
          <CopyButton value={token} />
          <button
            type="button"
            disabled={regenerate.isPending}
            onClick={async () => {
              if (await confirm({ title: text.mcpRegenerateTitle, message: text.mcpRegenerateMessage, confirmLabel: text.mcpRegenerate })) {
                regenerate.mutate();
              }
            }}
          >
            {text.mcpRegenerate}
          </button>
        </div>
      </Row>
      {regenerate.error && <Notice variant="error">{errorMessage(regenerate.error, uiText.settings.saveFailed)}</Notice>}
      <h5 className="settings-subheading">{text.mcpConnectHeading}</h5>
      {[
        { label: text.mcpVsCode, value: vsCodeConfig },
        { label: text.mcpClaude, value: claudeConfig },
      ].map((snippet) => (
        <div key={snippet.label} className="settings-snippet">
          <div className="settings-snippet-header">
            <span>{snippet.label}</span>
            <CopyButton value={snippet.value} />
          </div>
          <pre className="mono">{mask(snippet.value)}</pre>
        </div>
      ))}
    </SettingsGroup>
  );
}

function NetworkSection({ draft, onChange }: { draft: NetworkSettings; onChange: (next: NetworkSettings) => void }) {
  const text = uiText.settings.network;
  const update = (patch: Partial<NetworkSettings>) => onChange({ ...draft, ...patch });
  const manual = draft.proxyMode === 'manual';
  return (
    <>
      <SettingsGroup title={text.proxyHeading} description={text.appliesHint}>
        <Row label={text.proxyMode} htmlFor="settings-proxy-mode">
          <select id="settings-proxy-mode" value={draft.proxyMode} onChange={(e) => update({ proxyMode: e.target.value as ProxyMode })}>
            {(Object.keys(text.proxyModes) as ProxyMode[]).map((mode) => (
              <option key={mode} value={mode}>{text.proxyModes[mode]}</option>
            ))}
          </select>
        </Row>
        <Row label={text.httpProxy} htmlFor="settings-http-proxy">
          <input id="settings-http-proxy" type="url" placeholder={text.proxyPlaceholder} value={draft.httpProxy} disabled={!manual} onChange={(e) => update({ httpProxy: e.target.value })} />
        </Row>
        <Row label={text.httpsProxy} htmlFor="settings-https-proxy" hint={text.httpsProxyHint}>
          <input id="settings-https-proxy" type="url" placeholder={text.proxyPlaceholder} value={draft.httpsProxy} disabled={!manual} onChange={(e) => update({ httpsProxy: e.target.value })} />
        </Row>
        <Row label={text.noProxy} htmlFor="settings-no-proxy" hint={text.noProxyHint}>
          <textarea id="settings-no-proxy" rows={2} value={draft.noProxy} disabled={!manual} onChange={(e) => update({ noProxy: e.target.value })} />
        </Row>
      </SettingsGroup>
      <SettingsGroup title={text.certHeading} description={text.certHint}>
        <Row label={text.caCertPath} htmlFor="settings-ca-path">
          <input id="settings-ca-path" type="text" placeholder={text.caCertPlaceholder} value={draft.caCertPath} onChange={(e) => update({ caCertPath: e.target.value })} />
        </Row>
        <div className="settings-toggles">
          <Toggle id="settings-system-ca" label={text.useSystemCa} checked={draft.useSystemCa} onChange={(useSystemCa) => update({ useSystemCa })} />
        </div>
      </SettingsGroup>
    </>
  );
}

function TelemetrySection({ draft, onChange }: { draft: TelemetrySettings; onChange: (next: TelemetrySettings) => void }) {
  const text = uiText.settings.telemetry;
  const queryClient = useQueryClient();
  const usageQuery = useQuery({ queryKey: ['settings', 'usage'], queryFn: () => api.getUsageStats() });
  const clear = useMutation({
    mutationFn: () => api.clearUsageStats(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings', 'usage'] }),
  });
  const top = Object.entries(usageQuery.data?.operations ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return (
    <SettingsGroup title={text.heading} description={text.usageHint}>
      <div className="settings-toggles">
        <Toggle id="settings-usage-tracking" label={text.usageTracking} checked={draft.usageTracking} onChange={(usageTracking) => onChange({ ...draft, usageTracking })} />
      </div>
      {usageQuery.data && usageQuery.data.totalEvents > 0 ? (
        <>
          <Row label={text.totalEvents}><span>{usageQuery.data.totalEvents}</span></Row>
          {usageQuery.data.since && (
            <Row label={text.since}><span>{new Date(usageQuery.data.since).toLocaleString()}</span></Row>
          )}
          <h5 className="settings-subheading">{text.topFeatures}</h5>
          <ul className="settings-list compact">
            {top.map(([operation, count]) => (
              <li key={operation} className="settings-list-item">
                <span className="mono">{operation}</span>
                <span className="dim">{count}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="dim">{text.noData}</div>
      )}
      <div>
        <button type="button" onClick={() => clear.mutate()} disabled={clear.isPending || !usageQuery.data?.totalEvents}>
          {text.clear}
        </button>
      </div>
    </SettingsGroup>
  );
}
