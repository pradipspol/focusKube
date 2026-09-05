import type { KubeContext } from '../api/types';

interface Props {
    active: 'explorer' | 'search';
    onSelect: (activity: Props['active']) => void;
}

export function ActivityBar ({ active, onSelect }: Props) {
    return (
        <nav className="activity-bar" aria-label="Activity bar">
            <button className={`activity-bar-button ${active === 'explorer' ? 'active' : ''}`} title="Explorer" aria-label="Explorer" onClick={() => onSelect('explorer')}>
                <svg className="activity-bar-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10Z" />
                    <path d="M4 9h16" />
                </svg>
            </button>
            <button className={`activity-bar-button ${active === 'search' ? 'active' : ''}`} title="Search" aria-label="Search" onClick={() => onSelect('search')}>
                <span aria-hidden="true">⌕</span>
            </button>
        </nav>
    );
}

export function ActivityPanel ({ contexts, onContextChange, onOpenExplorer }: { contexts: KubeContext[]; onContextChange: (name: string) => void; onOpenExplorer: () => void }) {
    return (
        <div className="activity-panel">
            <div className="activity-panel-header">Search</div>
            <div className="activity-search-results">
                {/* {contexts.map((context) => (
          <button key={`${context.source?.provider ?? 'context'}:${context.name}`} className="activity-search-result" onClick={() => { onContextChange(context.name); onOpenExplorer(); }}>
            <span>{context.name}</span>
            <small>{context.source?.provider ?? 'Kubernetes'}</small>
          </button>
        ))} */}
                {contexts.length === 0 && <div className="activity-panel-empty">No clusters found.</div>}
            </div>
        </div>
    );
}