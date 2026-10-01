import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AuthUser } from '../api/types';
import { ROLE_LABELS, describePermissions } from '../auth/permissions';
import type { Theme } from '../App';
import { uiText } from '../text';
import { SettingsModal } from './SettingsModal';
import { Check, Menu, X } from 'lucide-react';

interface Props {
  user: AuthUser;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onOpenSettings?: () => void;
  // Hides the visual bar (used in desktop builds) while keeping the
  // menu-action listener and Preferences modal mounted.
  hideBar?: boolean;
  onSignOut: () => Promise<void>;
  /** Bumped by a parent (e.g. the activity bar's account menu) to open the Preferences modal
   * from outside this component, the same way the desktop native menu's 'preferences' action does. */
  openSettingsSignal?: number;
}

export function TopBar({
  user,
  theme,
  onThemeChange,
  onOpenSettings,
  hideBar,
  onSignOut,
  openSettingsSignal,
}: Props) {
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Captures the initial value so the effect below only fires on a later bump, not on mount.
  const lastOpenSettingsSignalRef = useRef(openSettingsSignal);

  // Mirror the saved proxy configuration into the desktop shell once per sign-in.
  useEffect(() => {
    if (!window.desktopMenu?.setNetworkProxy) return;
    void api.getAppSettings()
      .then((settings) => window.desktopMenu?.setNetworkProxy?.(settings.network))
      .catch(() => undefined);
  }, []);

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

  const handleOpenSettings = async () => {
    setMenuOpen(false);
    setSettingsOpen(true);
    await queryClient.invalidateQueries({ queryKey: ['settings'] });
  };

  useEffect(() => {
    if (openSettingsSignal === undefined || openSettingsSignal === lastOpenSettingsSignalRef.current) return;
    lastOpenSettingsSignalRef.current = openSettingsSignal;
    void handleOpenSettings();
  }, [openSettingsSignal]);

  useEffect(() => {
    if (!window.desktopMenu) return;
    return window.desktopMenu.onAction((action) => {
      if (action === 'preferences') {
        setMenuOpen(false);
        setSettingsOpen(true);
        onOpenSettings?.();
      }
    });
  }, [onOpenSettings]);

  return (
    <>
    {!hideBar && (
    <div className="topbar">
      <span className="brand">{uiText.brand.appName}</span>

      {/* <button onClick={() => reload.mutate()} title="Reload kubeconfig">
        ⟳ Refresh
      </button> */}

      <div className="spacer" />

      <div className="auth-user" tabIndex={0} title={`${uiText.topbar.rolePrefix} ${ROLE_LABELS[user.role]}`}>
        {/* <span className="auth-user-email">{user.email}</span> */}
        {/* <span className="role-badge">{ROLE_LABELS[user.role]}</span> */}
        <div className="user-permissions-popup" role="tooltip">
          <div className="user-permissions-title">{ROLE_LABELS[user.role]} {uiText.topbar.permissionsSuffix}</div>
          <ul className="user-permissions-list">
            {describePermissions(user.role).map((perm) => (
              <li key={perm.label} className={perm.granted ? 'granted' : 'denied'}>
                {perm.granted
                  ? <Check size={14} aria-hidden="true" />
                  : <X size={14} aria-hidden="true" />}
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
          title={uiText.topbar.openMenu}
          aria-label={uiText.topbar.openMenu}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <Menu size={17} aria-hidden="true" />
        </button>
        {menuOpen && (
          <div className="topbar-menu-popup" role="menu" aria-label={uiText.topbar.userMenu}>
            <button
              type="button"
              className="topbar-menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void onSignOut();
              }}
            >
              {uiText.topbar.signOut}
            </button>
            <button
              type="button"
              className="topbar-menu-item"
              role="menuitem"
              onClick={() => {
                void handleOpenSettings();
              }}
            >
              {uiText.topbar.settings}
            </button>
          </div>
        )}
      </div>
    </div>
    )}

      {settingsOpen && (
        <SettingsModal theme={theme} onThemeChange={onThemeChange} onClose={() => setSettingsOpen(false)} />
      )}
    </>
  );
}
