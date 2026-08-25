import { useMemo } from 'react';

interface Props {
  currentManifest: string;
  newManifest: string;
}

export function HelmDiffViewer({ currentManifest, newManifest }: Props) {
  const stats = useMemo(() => {
    if (!newManifest) {
      return { added: 0, removed: 0, modified: 0 };
    }

    const currentLines = new Set(currentManifest.split('\n').map((l) => l.trim()));
    const newLines = new Set(newManifest.split('\n').map((l) => l.trim()));

    let added = 0;
    let removed = 0;

    for (const line of newLines) {
      if (!currentLines.has(line) && line) added++;
    }

    for (const line of currentLines) {
      if (!newLines.has(line) && line) removed++;
    }

    return { added, removed, modified: 0 };
  }, [currentManifest, newManifest]);

  return (
    <div className="helm-diff-viewer">
      {newManifest && (
        <div className="diff-summary">
          <span className="diff-stat added">+{stats.added} added</span>
          <span className="diff-stat removed">−{stats.removed} removed</span>
        </div>
      )}

      <div className="diff-content">
        <div className="diff-pane">
          <div className="diff-pane-header">Current Manifest</div>
          <pre className="mono" style={{ overflow: 'auto', maxHeight: '40vh', fontSize: '12px', padding: '8px' }}>
            {currentManifest || '(empty)'}
          </pre>
        </div>

        {newManifest && (
          <div className="diff-pane">
            <div className="diff-pane-header">New Manifest</div>
            <pre
              className="mono"
              style={{
                overflow: 'auto',
                maxHeight: '40vh',
                fontSize: '12px',
                padding: '8px',
                backgroundColor: 'var(--color-diff-new)',
              }}
            >
              {newManifest}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
