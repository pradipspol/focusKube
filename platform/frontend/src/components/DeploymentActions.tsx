import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';
import { useConfirm } from './ConfirmDialog';
import { uiText } from '../text';

interface Props {
  deployment: K8sObject;
  scope: Scope;
  onChanged: () => void;
}

export function DeploymentActions({ deployment, scope, onChanged }: Props) {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const confirm = useConfirm();
  const name = deployment.metadata!.name!;
  const ns = deployment.metadata?.namespace;
  const opScope: Scope = { ...scope, namespace: ns };
  const [replicas, setReplicas] = useState<number>(deployment.spec?.replicas ?? 1);
  const [message, setMessage] = useState<string>('');

  const refresh = () => {
    onChanged();
    qc.invalidateQueries({ queryKey: ['deployment-history', name, ns] });
  };

  const restart = useMutation({
    mutationFn: () => api.restartDeployment(name, opScope),
    onSuccess: () => {
      setMessage('Restart triggered.');
      refresh();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const scale = useMutation({
    mutationFn: () => api.scaleDeployment(name, replicas, opScope),
    onSuccess: () => {
      setMessage(`Scaled to ${replicas} replicas.`);
      refresh();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const history = useQuery({
    queryKey: ['deployment-history', name, ns],
    queryFn: () => api.deploymentHistory(name, opScope),
  });

  const rollback = useMutation({
    mutationFn: (revision: number) => api.rollbackDeployment(name, revision, opScope),
    onSuccess: (result) => {
      setMessage(`Rolled back to revision ${result.rolledBackTo}.`);
      refresh();
    },
    onError: (e) => setMessage((e as Error).message),
  });

  const revisions = (history.data?.revisions ?? []).slice().reverse();
  const currentRevision = parseInt(
    deployment.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? '0',
    10,
  );

  return (
    <div style={{ padding: 14, overflow: 'auto' }}>
      {message && <div className="notice">{message}</div>}
      {!canWrite && <div className="notice">{uiText.deployment.readOnlyNotice}</div>}

      {canWrite && (
        <>
          <h4>{uiText.deployment.restart}</h4>
          <button onClick={() => restart.mutate()} disabled={restart.isPending}>
            ⟳ {uiText.deployment.rolloutRestart}
          </button>

          <h4 style={{ marginTop: 20 }}>{uiText.deployment.scale}</h4>
          <div className="field">
            <input
              type="number"
              min={0}
              value={replicas}
              onChange={(e) => setReplicas(parseInt(e.target.value || '0', 10))}
              style={{ width: 90 }}
            />
            <button className="primary" onClick={() => scale.mutate()} disabled={scale.isPending}>
              {uiText.deployment.apply}
            </button>
            <span className="dim">{uiText.deployment.currentDesiredPrefix} {deployment.spec?.replicas ?? 0}</span>
          </div>
        </>
      )}

      <h4 style={{ marginTop: 20 }}>{uiText.deployment.rolloutHistory}</h4>
      {history.isLoading && <div className="dim">{uiText.deployment.loadingHistory}</div>}
      {history.isError && <div className="notice error">{(history.error as Error).message}</div>}
      {revisions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>{uiText.deployment.revision}</th>
              <th>{uiText.deployment.images}</th>
              <th>{uiText.deployment.created}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision) => (
              <tr key={revision.revision}>
                <td>
                  {revision.revision}
                  {revision.revision === currentRevision && (
                    <span className="badge ok" style={{ marginLeft: 6 }}>
                      {uiText.deployment.current}
                    </span>
                  )}
                </td>
                <td className="mono dim">{revision.images.join(', ')}</td>
                <td className="dim">{revision.createdAt ? new Date(revision.createdAt).toLocaleString() : '-'}</td>
                <td>
                  {canWrite && (
                    <button
                      disabled={revision.revision === currentRevision || rollback.isPending}
                      onClick={async () => {
                        const ok = await confirm({
                          title: uiText.confirmDialog.rollbackTitle,
                          message: uiText.confirmDialog.rollbackQuestion(name, revision.revision),
                          confirmLabel: uiText.confirmDialog.rollback,
                        });
                        if (ok) rollback.mutate(revision.revision);
                      }}
                    >
                      {uiText.deployment.rollback}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
