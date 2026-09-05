import type { KubeContext } from '../api/types';
import { uiText } from '../text';

interface Props {
    active: 'explorer' | 'search' | 'settings';
    onSelect: (activity: Props['active']) => void;
}

export function ActivityBar ({ active, onSelect }: Props) {
    return (
        <nav className="activity-bar" aria-label={uiText.activityBar.label}>
            <button className={`activity-bar-button ${active === 'explorer' ? 'active' : ''}`} title={uiText.activityBar.explorer} aria-label={uiText.activityBar.explorer} onClick={() => onSelect('explorer')}>
                <svg className="activity-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10Z" />
                    <path d="M4 9h16" />
                </svg>
            </button>
            {/* <button className={`activity-bar-button ${active === 'search' ? 'active' : ''}`} title={uiText.activityBar.search} aria-label={uiText.activityBar.search} onClick={() => onSelect('search')}>
                <span aria-hidden="true">⌕</span>
            </button>
            <button className={`activity-bar-button ${active === 'settings' ? 'active' : ''}`} title={uiText.activityBar.settings} aria-label={uiText.activityBar.settings} onClick={() => onSelect('settings')}>
                <svg className="activity-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 8a4 4 0 1 0 4 4 4 4 0 0 0-4-4zm0 6a2 2 0 1 1 2-2 2 2 0 0 1-2 2zm0-10a8 8 0 0 0-8 8 8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8zm0 14a6 6 0 0 1-6-6 6 6 0 0 1 6-6 6 6 0 0 1 6 6 6 6 0 0 1-6 6z" />
                </svg>
            </button> */}
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