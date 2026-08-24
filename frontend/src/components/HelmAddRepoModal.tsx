import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import { Modal } from './Modal';
import { uiText } from '../text';

interface Props {
  scope: Scope;
  onClose: () => void;
  onToast: (tone: 'success' | 'error' | 'info', text: string) => void;
  onAdded: () => void;
}

export function HelmAddRepoModal({ scope, onClose, onToast, onAdded }: Props) {
  const qc = useQueryClient();
  const [repoName, setRepoName] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [error, setError] = useState('');

  const addRepo = useMutation({
    mutationFn: async () => {
      if (!repoName.trim() || !repoUrl.trim()) {
        throw new Error('Repo name and URL are required');
      }
      return api.helmAddRepo(repoName, repoUrl, scope);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['helm-charts'] });
      qc.invalidateQueries({ queryKey: ['helm-repos'] });
      onToast('success', `Repository "${repoName}" added successfully`);
      onAdded();
      onClose();
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : uiText.helm.addRepositoryError;
      setError(msg);
      onToast('error', msg);
    },
  });

  const isReadyToAdd = repoName.trim().length > 0 && repoUrl.trim().length > 0 && !addRepo.isPending;

  return (
    <Modal title={uiText.helm.addHelmRepositoryTitle} onClose={onClose}>
      <div className="helm-modal-content">
        <div className="form-group">
          <label htmlFor="repo-name">{uiText.helm.repositoryName}</label>
          <input
            id="repo-name"
            type="text"
            placeholder="e.g., bitnami"
            value={repoName}
            onChange={(e) => {
              setRepoName(e.target.value);
              setError('');
            }}
          />
          <small className="dim">{uiText.helm.addRepoHint}</small>
        </div>

        <div className="form-group">
          <label htmlFor="repo-url">{uiText.helm.repositoryUrl}</label>
          <input
            id="repo-url"
            type="url"
            placeholder="e.g., https://charts.bitnami.com/bitnami"
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              setError('');
            }}
          />
          <small className="dim">{uiText.helm.repoUrlHint}</small>
        </div>

        {error && <div className="notice error">{error}</div>}

        <div className="helm-modal-actions">
          <button onClick={onClose} disabled={addRepo.isPending}>
            {uiText.common.cancel}
          </button>
          <button
            onClick={() => addRepo.mutate()}
            disabled={!isReadyToAdd}
            className="primary"
            title={isReadyToAdd ? uiText.helm.addRepository : 'Enter repo name and URL'}
          >
            {addRepo.isPending ? 'Adding...' : uiText.helm.addRepository}
          </button>
        </div>

        <div className="repo-examples">
          <small className="dim">
            <strong>{uiText.helm.commonRepositories}</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: '20px' }}>
              <li>
                <code>bitnami</code> → <code>https://charts.bitnami.com/bitnami</code>
              </li>
              <li>
                <code>stable</code> → <code>https://charts.helm.sh/stable</code>
              </li>
              <li>
                <code>prometheus-community</code> → <code>https://prometheus-community.github.io/helm-charts</code>
              </li>
            </ul>
          </small>
        </div>
      </div>
    </Modal>
  );
}
