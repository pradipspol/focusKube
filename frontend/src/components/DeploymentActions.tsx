import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { K8sObject } from '../api/types';
import { usePermissions } from '../auth/permissions';

interface Props {
  deployment: K8sObject;
  scope: Scope;
  onChanged: () => void;
}

export function DeploymentActions({ deployment, scope, onChanged }: Props) {
  const qc = useQueryClient();
  const { canWrite } = usePermissions();
  const name = deployment.metadata!.name!;
  const ns = deployment.metadata?.namespace;
  const opScope: Scope = { context: scope.context, namespace: ns };
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
    onSuccess: (r) => {
      setMessage(`Rolled back to revision ${r.rolledBackTo}.`);
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
      {!canWrite && (
        <div className="notice">Your role is read-only — deployment actions are disabled.</div>
      )}

      {canWrite && (
        <>
          <h4>Restart</h4>
          <button onClick={() => restart.mutate()} disabled={restart.isPending}>
            ⟳ Rollout restart
          </button>

          <h4 style={{ marginTop: 20 }}>Scale</h4>
          <div className="field">
            <input
              type="number"
              min={0}
              value={replicas}
              onChange={(e) => setReplicas(parseInt(e.target.value || '0', 10))}
              style={{ width: 90 }}
            />
            <button className="primary" onClick={() => scale.mutate()} disabled={scale.isPending}>
              Apply
            </button>
            <span className="dim">current desired: {deployment.spec?.replicas ?? 0}</span>
          </div>
        </>
      )}

      <h4 style={{ marginTop: 20 }}>Rollout history</h4>
      {history.isLoading && <div className="dim">Loading history…</div>}
      {history.isError && <div className="notice error">{(history.error as Error).message}</div>}
      {revisions.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Revision</th>
              <th>Images</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.revision}>
                <td>
                  {r.revision}
                  {r.revision === currentRevision && <span className="badge ok" style={{ marginLeft: 6 }}>current</span>}
                </td>
                <td className="mono dim">{r.images.join(', ')}</td>
                <td className="dim">{r.createdAt ? new Date(r.createdAt).toLocaleString() : '-'}</td>
                <td>
                  {canWrite && (
                    <button
                      disabled={r.revision === currentRevision || rollback.isPending}
                      onClick={() => {
                        if (confirm(`Roll back ${name} to revision ${r.revision}?`)) rollback.mutate(r.revision);
                      }}
                    >
                      Rollback
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
