import { useEffect, useRef, useState } from 'react';
import type { AuthUser, KubeContext } from '../api/types';
import type { AiEntitlement } from '../api/aiAssistantApi';
import { ROLE_LABELS } from '../auth/permissions';
import { uiText } from '../text';
import { FolderOpen, Sparkles } from 'lucide-react';

interface Props {
    active: 'explorer' | 'search' | 'settings';
    /** Sidebar is fully hidden (VSCode-style) — drops the Explorer button's active highlight
     * even though it's still conceptually the selected activity. */
    explorerHidden: boolean;
    onSelect: (activity: Props['active']) => void;
    aiActive: boolean;
    onToggleAi: () => void;
    user: AuthUser;
    entitlement?: AiEntitlement;
    onOpenSettings: () => void;
    onSignOut: () => Promise<void>;
}

export function ActivityBar ({ active, explorerHidden, onSelect, aiActive, onToggleAi, user, entitlement, onOpenSettings, onSignOut }: Props) {
    const [profileOpen, setProfileOpen] = useState(false);
    const profileRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!profileOpen) return;
        const onMouseDown = (event: MouseEvent) => {
            if (!profileRef.current?.contains(event.target as Node)) {
                setProfileOpen(false);
            }
        };
        const onEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setProfileOpen(false);
        };
        window.addEventListener('mousedown', onMouseDown);
        window.addEventListener('keydown', onEscape);
        return () => {
            window.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('keydown', onEscape);
        };
    }, [profileOpen]);

    const avatarInitial = user.email.charAt(0).toUpperCase();

    return (
        <nav className="activity-bar" aria-label={uiText.activityBar.label}>
            <button className={`activity-bar-button ${active === 'explorer' && !explorerHidden ? 'active' : ''}`} title={uiText.activityBar.explorer} aria-label={uiText.activityBar.explorer} aria-pressed={active === 'explorer' && !explorerHidden} onClick={() => onSelect('explorer')}>
                <FolderOpen className="activity-bar-icon" size={18} aria-hidden="true" />
            </button>
            <div className="activity-bar-spacer" />
            <button
                className={`activity-bar-button ${aiActive ? 'active' : ''}`}
                title={uiText.activityBar.aiAssistant}
                aria-label={uiText.activityBar.aiAssistant}
                aria-pressed={aiActive}
                onClick={onToggleAi}
            >
                <Sparkles size={18} aria-hidden="true" />
            </button>
            <div className="activity-bar-user" ref={profileRef}>
                <button
                    type="button"
                    className={`activity-bar-button ${profileOpen ? 'active' : ''}`}
                    title={uiText.activityBar.account}
                    aria-label={uiText.activityBar.account}
                    aria-expanded={profileOpen}
                    onClick={() => setProfileOpen((current) => !current)}
                >
                    <span className="activity-bar-avatar" aria-hidden="true">{avatarInitial}</span>
                </button>
                {profileOpen && (
                    <div className="activity-bar-user-popup" role="menu" aria-label={uiText.activityBar.account}>
                        <div className="activity-bar-user-header">
                            <div className="activity-bar-user-email">{user.email}</div>
                            <div className="activity-bar-user-role">{ROLE_LABELS[user.role]}</div>
                        </div>
                        <div className="activity-bar-user-plan">
                            <span className="activity-bar-plan-item">
                                {uiText.aiAssistant.planLabel}: {entitlement?.plan ?? '—'}
                            </span>
                            {typeof entitlement?.quotaRemaining === 'number' && (
                                <span className="activity-bar-plan-item">
                                    {uiText.aiAssistant.quotaRemainingLabel}: {entitlement.quotaRemaining}
                                </span>
                            )}
                        </div>
                        <div className="activity-bar-user-actions">
                            <button
                                type="button"
                                className="activity-bar-user-action"
                                role="menuitem"
                                onClick={() => {
                                    setProfileOpen(false);
                                    onOpenSettings();
                                }}
                            >
                                {uiText.topbar.settings}
                            </button>
                            <button
                                type="button"
                                className="activity-bar-user-action"
                                role="menuitem"
                                onClick={() => {
                                    setProfileOpen(false);
                                    void onSignOut();
                                }}
                            >
                                {uiText.topbar.signOut}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </nav>
    );
}

export function ActivityPanel ({ contexts, onContextChange, onOpenExplorer }: { contexts: KubeContext[]; onContextChange: (name: string) => void; onOpenExplorer: () => void }) {
    
    return (
        <div className="activity-panel">
            <div className="activity-panel-header">{uiText.activityBar.settings}</div>
            <div className="activity-search-results">
                {/* {contexts.map((context) => (
          <button key={`${context.source?.provider ?? 'context'}:${context.name}`} className="activity-search-result" onClick={() => { onContextChange(context.name); onOpenExplorer(); }}>
            <span>{context.name}</span>
            <small>{context.source?.provider ?? 'Kubernetes'}</small>
          </button>
        ))} */}
                {contexts.length === 0 && <div className="activity-panel-empty">{uiText.activityBar.noClustersFound}</div>}
            </div>
        </div>
    );
}