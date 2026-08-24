import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { HelmRelease } from '../api/types';
import { Modal } from './Modal';
import { HelmDiffViewer } from './HelmDiffViewer';

interface Props {
  release: HelmRelease;
  scope: Scope;
  onClose: () => void;
  onToast: (tone: 'success' | 'error' | 'info', text: string) => void;
  onUpgraded: () => void;
}

export function HelmUpgradeModal({ release, scope, onClose, onToast, onUpgraded }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'config' | 'diff'>('config');
  const [version, setVersion] = useState('');
  const [values, setValues] = useState('');
  const [isLoadingDefaults, setIsLoadingDefaults] = useState(false);

  const currentValues = useQuery({
    queryKey: ['helm-values', release.name, release.namespace],
    queryFn: () => api.helmValues(release.name, { ...scope, namespace: release.namespace }),
  });

  const currentManifest = useQuery({
    queryKey: ['helm-manifest', release.name, release.namespace],
    queryFn: () => api.helmDiff(release.name, { ...scope, namespace: release.namespace }),
  });

  useEffect(() => {
    if (currentValues.data && !values) {
      setValues(currentValues.data.values);
    }
  }, [currentValues.data]);

  const upgrade = useMutation({
    mutationFn: async () => {
      return api.helmUpgrade(
        release.name,
        {
          values: values || undefined,
          version: version || undefined,
        },
        scope
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['helm'] });
      onToast('success', `Release ${release.name} upgraded successfully`);
      onUpgraded();
      onClose();
    },
    onError: (err) => {
      onToast('error', err instanceof Error ? err.message : 'Upgrade failed');
    },
  });

  const handleViewDiff = async () => {
    setTab('diff');
  };

  const isReadyToUpgrade = (values !== currentValues.data?.values || version) && !upgrade.isPending;

  return (
    <Modal title={`Upgrade Release — ${release.name}`} onClose={onClose}>
      <div className="helm-modal-tabs">
        <button className={`tab ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
          Configuration
        </button>
        <button className={`tab ${tab === 'diff' ? 'active' : ''}`} onClick={() => setTab('diff')}>
          Diff
        </button>
      </div>

      {tab === 'config' && (
        <div className="helm-modal-content">
          {currentValues.isError && <div className="notice error">{(currentValues.error as Error).message}</div>}
          {currentValues.isLoading && <div className="dim">Loading current values...</div>}

          {currentValues.data && (
            <>
              <div className="form-group">
                <label htmlFor="version-input">Target Chart Version (optional)</label>
                <input
                  id="version-input"
                  type="text"
                  placeholder="Leave empty to keep current version"
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                />
                <small className="dim">Current: {release.chart}</small>
              </div>

              <div className="form-group">
                <label htmlFor="values-editor">Values (YAML)</label>
                <textarea
                  id="values-editor"
                  value={values}
                  onChange={(e) => setValues(e.target.value)}
                  rows={10}
                  style={{ fontFamily: 'monospace', fontSize: '12px' }}
                />
              </div>

              <div className="helm-modal-actions">
                <button onClick={handleViewDiff} disabled={upgrade.isPending} title="Review changes">
                  View Diff
                </button>
                <button
                  onClick={() => upgrade.mutate()}
                  disabled={!isReadyToUpgrade}
                  className="primary"
                  title={isReadyToUpgrade ? 'Upgrade release' : 'Make changes or select a new version'}
                >
                  {upgrade.isPending ? 'Upgrading...' : 'Upgrade Release'}
                </button>
              </div>

              {upgrade.isError && (
                <div className="notice error">{upgrade.error instanceof Error ? upgrade.error.message : 'Upgrade failed'}</div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'diff' && (
        <div className="helm-modal-content">
          {currentManifest.isLoading && <div className="dim">Loading manifest...</div>}
          {currentManifest.isError && <div className="notice error">{(currentManifest.error as Error).message}</div>}

          {currentManifest.data && (
            <>
              <HelmDiffViewer
                currentManifest={currentManifest.data.currentManifest}
                newManifest={currentManifest.data.comparisonManifest}
              />
              <div className="helm-modal-actions">
                <button onClick={() => setTab('config')}>Back to Config</button>
                <button
                  onClick={() => upgrade.mutate()}
                  disabled={!isReadyToUpgrade}
                  className="primary"
                  title={isReadyToUpgrade ? 'Upgrade release' : 'Make changes first'}
                >
                  Upgrade Release
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
