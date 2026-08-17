export interface ChangeEventDoc {
  id: string;
  recordingId: string;
  context: string;
  namespace?: string;
  kind: 'Pod' | 'Deployment' | 'ReplicaSet' | 'StatefulSet' | 'Event';
  name: string;
  uid?: string;
  ts: Date;
  category: 'workloadChange' | 'k8sEvent';
  changeType:
    | 'created'
    | 'deleted'
    | 'phase'
    | 'condition'
    | 'restartCount'
    | 'image'
    | 'warningEvent'
    | 'normalEvent';
  severity: 'info' | 'warning' | 'error';
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  involvedObject?: { kind: string; name: string; namespace?: string };
  expiresAt: Date;
}

export interface RecordingSessionDoc {
  id: string;
  /** Unique recording identifier (computed from userId, context, serverUrl) */
  recordingKey: string;
  context: string;
  userId: string;
  /** Kubernetes server URL (e.g., https://api.cluster.com:6443) - for multi-cluster support */
  serverUrl?: string;
  /** Kubeconfig file path or local kubeconfig ID */
  kubeconfigPath?: string;
  kubeconfigId?: string;
  startedAt: Date;
  stoppedAt?: Date;
  status: 'active' | 'stopped' | 'error';
  errorMessage?: string;
}

export interface ChangeRecord {
  kind: 'Pod' | 'Deployment' | 'ReplicaSet' | 'StatefulSet' | 'Event';
  namespace?: string;
  name: string;
  uid?: string;
  ts: Date;
  category: 'workloadChange' | 'k8sEvent';
  changeType:
    | 'created'
    | 'deleted'
    | 'phase'
    | 'condition'
    | 'restartCount'
    | 'image'
    | 'warningEvent'
    | 'normalEvent';
  severity: 'info' | 'warning' | 'error';
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  involvedObject?: { kind: string; name: string; namespace?: string };
}
