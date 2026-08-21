import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AuthUser } from '../api/types';
import type { LogLevel } from '../api/types';
import { ROLE_LABELS, describePermissions } from '../auth/permissions';
import type { Theme } from '../App';

interface Props {
  user: AuthUser;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenSettings?: () => void;
  // Hides the visual bar (used in desktop builds) while keeping the
  // menu-action listener and Preferences modal mounted.
  hideBar?: boolean;
  // onContextsRefetch: () => void;
  // onSignOut: () => Promise<void>;
}

export function TopBar({
  user,
  theme,
  onThemeChange,
  onOpenSettings,
  hideBar,
  // onContextsRefetch,
  // onSignOut,
}: Props) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedLevel, setSelectedLevel] = useState<LogLevel>('info');
  const [selectedTheme, setSelectedTheme] = useState<Theme>(theme);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const authConfigQuery = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: () => api.authConfig(),
    staleTime: 60_000,
  });
  const isDesktopMode = authConfigQuery.data?.mode === 'desktop';

  const logLevelQuery = useQuery({
    queryKey: ['settings', 'log-level'],
    queryFn: () => api.getLogLevel(),
    enabled: settingsOpen && isDesktopMode,
  });

  useEffect(() => {
    if (logLevelQuery.data?.level) {
      setSelectedLevel(logLevelQuery.data.level);
    }
  }, [logLevelQuery.data?.level]);

  useEffect(() => {
    if (!menuOpen) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target)) {
        setMenuOpen(false);
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onEscape);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onEscape);
    };
  }, [menuOpen]);

  // const reload = useMutation({
  //   mutationFn: () => api.reloadContexts(),
  //   onSuccess: () => onContextsRefetch(),
  // });

  const updateLogLevel = useMutation({
    mutationFn: (level: LogLevel) => api.setLogLevel(level),
    onSuccess: async (result) => {
      setSelectedLevel(result.level);
      await queryClient.invalidateQueries({ queryKey: ['settings', 'log-level'] });
    },
  });

  const handleOpenSettings = async () => {
    setMenuOpen(false);
    setSelectedTheme(theme);
    setSettingsOpen(true);
    await queryClient.invalidateQueries({ queryKey: ['settings', 'log-level'] });
  };

  useEffect(() => {
    if (!window.desktopMenu) return;
    return window.desktopMenu.onAction((action) => {
      if (action === 'preferences') {
        setMenuOpen(false);
        setSettingsOpen(true);
        setSelectedTheme(theme);
        onOpenSettings?.();
      }
    });
  }, [onOpenSettings, theme]);

  const handleSaveSettings = async () => {
    await updateLogLevel.mutateAsync(selectedLevel);
    onThemeChange(selectedTheme);
    setSettingsOpen(false);
  };

  const levelOptions: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  const themeOptions: Array<{ value: Theme; label: string }> = [
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
    { value: 'contrast', label: 'Contrast' },
  ];

  return (
    <>
    {!hideBar && (
    <div className="topbar">
      <span className="brand">⎈ K8 Explorer</span>

      {/* <button onClick={() => reload.mutate()} title="Reload kubeconfig">
        ⟳ Refresh
      </button> */}

      <div className="spacer" />

      <div className="auth-user" tabIndex={0} title={`Role: ${ROLE_LABELS[user.role]}`}>
        {/* <span className="auth-user-email">{user.email}</span> */}
        {/* <span className="role-badge">{ROLE_LABELS[user.role]}</span> */}
        <div className="user-permissions-popup" role="tooltip">
          <div className="user-permissions-title">{ROLE_LABELS[user.role]} permissions</div>
          <ul className="user-permissions-list">
            {describePermissions(user.role).map((perm) => (
              <li key={perm.label} className={perm.granted ? 'granted' : 'denied'}>
                <span aria-hidden="true">{perm.granted ? '✓' : '✕'}</span>
                {perm.label}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="topbar-menu" ref={menuRef}>
        <button
          type="button"
          className="menu-button"
          title="Open menu"
          aria-label="Open menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
        >
          ☰
        </button>
        {menuOpen && (
          <div className="topbar-menu-popup" role="menu" aria-label="User menu">
            {/* <button
              type="button"
              className="topbar-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onSignOut();
              }}
            >
              Logout
            </button> */}
            {isDesktopMode && (
              <button
                type="button"
                className="topbar-menu-item"
                role="menuitem"
                onClick={() => {
                  void handleOpenSettings();
                }}
              >
                Settings
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    )}

      {settingsOpen && (
        <div className="overlay center" onClick={() => setSettingsOpen(false)}>
          <div className="modal-card settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Preferences</h3>
              <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Close settings">✕</button>
            </div>
            <div className="modal-body settings-modal-body">
              {logLevelQuery.isLoading ? (
                <div className="dim">Loading settings...</div>
              ) : (
                <>
                  <div className="settings-row">
                    <label className="settings-field" htmlFor="desktop-theme">
                      Theme
                    </label>
                    <select
                      id="desktop-theme"
                      value={selectedTheme}
                      onChange={(event) => setSelectedTheme(event.target.value as Theme)}
                      disabled={updateLogLevel.isPending}
                    >
                      {themeOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="settings-row">
                    <label className="settings-field" htmlFor="desktop-log-level">
                      Log level
                    </label>
                    <select
                      id="desktop-log-level"
                      value={selectedLevel}
                      onChange={(event) => setSelectedLevel(event.target.value as LogLevel)}
                      disabled={!logLevelQuery.data?.editable || updateLogLevel.isPending}
                    >
                      {levelOptions.map((level) => (
                        <option key={level} value={level}>
                          {level.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="dim settings-message">
                    Effective: {logLevelQuery.data?.level?.toUpperCase() ?? 'N/A'}
                    {logLevelQuery.data?.envLevel ? ` | ENV: ${logLevelQuery.data.envLevel.toUpperCase()}` : ''}
                    {logLevelQuery.data?.overriddenByUi ? ' | UI override active' : ''}
                  </div>
                  {!logLevelQuery.data?.editable && (
                    <div className="dim settings-message">Log level is editable only in desktop mode.</div>
                  )}
                  {updateLogLevel.error && (
                    <div className="notice error settings-message">
                      {updateLogLevel.error instanceof Error ? updateLogLevel.error.message : 'Failed to update log level.'}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="modal-footer">
              <button type="button" onClick={() => setSettingsOpen(false)} disabled={updateLogLevel.isPending}>Cancel</button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void handleSaveSettings();
                }}
                disabled={updateLogLevel.isPending || logLevelQuery.isLoading || !logLevelQuery.data?.editable}
              >
                {updateLogLevel.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
