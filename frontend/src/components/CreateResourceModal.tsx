import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Editor from '@monaco-editor/react';
import { Modal } from './Modal';
import { api, type Scope } from '../api/client';
import type { ToastMessage } from './ToastViewport';

/**
 * Sample manifests keyed by resource plural. When the Add-resource dialog is
 * opened from a resource view we pre-fill a sample of *that* kind; the user is
 * free to edit it or paste something else entirely. Names are randomized so
 * repeated clicks never collide. Falls back to an nginx Deployment.
 */
const SAMPLE_BUILDERS: Record<string, (s: string) => string> = {
  deployments: (s) => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: sample-nginx-${s}
  labels:
    app: sample-nginx-${s}
spec:
  replicas: 1
  selector:
    matchLabels:
      app: sample-nginx-${s}
  template:
    metadata:
      labels:
        app: sample-nginx-${s}
    spec:
      containers:
        - name: nginx
          image: nginx:stable
          ports:
            - containerPort: 80
`,
  pods: (s) => `apiVersion: v1
kind: Pod
metadata:
  name: sample-pod-${s}
  labels:
    app: sample-pod-${s}
spec:
  containers:
    - name: app
      image: nginx:stable
      ports:
        - containerPort: 80
`,
  statefulsets: (s) => `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: sample-sts-${s}
spec:
  serviceName: sample-sts-${s}
  replicas: 1
  selector:
    matchLabels:
      app: sample-sts-${s}
  template:
    metadata:
      labels:
        app: sample-sts-${s}
    spec:
      containers:
        - name: nginx
          image: nginx:stable
`,
  daemonsets: (s) => `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sample-ds-${s}
spec:
  selector:
    matchLabels:
      app: sample-ds-${s}
  template:
    metadata:
      labels:
        app: sample-ds-${s}
    spec:
      containers:
        - name: agent
          image: busybox:stable
          command: ["sh", "-c", "while true; do sleep 3600; done"]
`,
  jobs: (s) => `apiVersion: batch/v1
kind: Job
metadata:
  name: sample-job-${s}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: hello
          image: busybox:stable
          command: ["sh", "-c", "echo Hello from k8-explorer && sleep 5"]
`,
  cronjobs: (s) => `apiVersion: batch/v1
kind: CronJob
metadata:
  name: sample-cron-${s}
spec:
  schedule: "*/5 * * * *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: hello
              image: busybox:stable
              command: ["sh", "-c", "date && echo tick"]
`,
  services: (s) => `apiVersion: v1
kind: Service
metadata:
  name: sample-svc-${s}
spec:
  selector:
    app: sample-nginx-${s}
  ports:
    - port: 80
      targetPort: 80
`,
  ingresses: (s) => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: sample-ing-${s}
spec:
  rules:
    - host: sample-${s}.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: sample-svc-${s}
                port:
                  number: 80
`,
  configmaps: (s) => `apiVersion: v1
kind: ConfigMap
metadata:
  name: sample-config-${s}
data:
  key: value
`,
  secrets: (s) => `apiVersion: v1
kind: Secret
metadata:
  name: sample-secret-${s}
type: Opaque
stringData:
  username: admin
  password: change-me
`,
  serviceaccounts: (s) => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: sample-sa-${s}
`,
  namespaces: (s) => `apiVersion: v1
kind: Namespace
metadata:
  name: sample-ns-${s}
`,
  persistentvolumeclaims: (s) => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sample-pvc-${s}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  horizontalpodautoscalers: (s) => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: sample-hpa-${s}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: sample-nginx-${s}
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
  poddisruptionbudgets: (s) => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: sample-pdb-${s}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: sample-nginx-${s}
`,
  networkpolicies: (s) => `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sample-netpol-${s}
spec:
  podSelector:
    matchLabels:
      app: sample-nginx-${s}
  policyTypes:
    - Ingress
`,
  roles: (s) => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: sample-role-${s}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
  rolebindings: (s) => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: sample-rb-${s}
subjects:
  - kind: ServiceAccount
    name: sample-sa-${s}
roleRef:
  kind: Role
  name: sample-role-${s}
  apiGroup: rbac.authorization.k8s.io
`,
  resourcequotas: (s) => `apiVersion: v1
kind: ResourceQuota
metadata:
  name: sample-quota-${s}
spec:
  hard:
    pods: "10"
    requests.cpu: "2"
    requests.memory: 2Gi
`,
  limitranges: (s) => `apiVersion: v1
kind: LimitRange
metadata:
  name: sample-limits-${s}
spec:
  limits:
    - default:
        cpu: 500m
        memory: 256Mi
      type: Container
`,
};

const RESOURCE_TYPE_OPTIONS = Object.keys(SAMPLE_BUILDERS)
  .sort()
  .map((value) => ({
    value,
    label: value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (letter) => letter.toUpperCase()),
  }));

function initialResourceType(resourceType?: string): string {
  return resourceType && SAMPLE_BUILDERS[resourceType] ? resourceType : 'deployments';
}

function sampleManifest(resourceType?: string): string {
  const suffix = Math.random().toString(36).slice(2, 7);
  const build = (resourceType && SAMPLE_BUILDERS[resourceType]) || SAMPLE_BUILDERS.deployments;
  return build(suffix);
}

interface Props {
  scope: Scope;
  namespaces: string[];
  selectedNamespace?: string;
  /** Active resource view's plural — used to seed a matching sample. */
  resourceType?: string;
  onClose: () => void;
  onToast: (tone: ToastMessage['tone'], text: string, durationMs?: number) => void;
}

export function CreateResourceModal({ scope, namespaces, selectedNamespace, resourceType, onClose, onToast }: Props) {
  const queryClient = useQueryClient();
  const [selectedResourceType, setSelectedResourceType] = useState(() => initialResourceType(resourceType));
  const [draft, setDraft] = useState(() => sampleManifest(initialResourceType(resourceType)));
  const [namespace, setNamespace] = useState(() => selectedNamespace ?? namespaces[0] ?? 'default');
  const [error, setError] = useState('');

  const validate = useMutation({
    mutationFn: () => api.validateResourceYaml(draft, { context: scope.context, namespace, source: scope.source }),
  });

  const apply = useMutation({
    mutationFn: () => api.applyResourceYaml(draft, { context: scope.context, namespace, source: scope.source }),
    onSuccess: (result) => {
      const obj = result.object as { kind?: string; metadata?: { name?: string } };
      const label = `${obj?.kind ?? 'Resource'} ${obj?.metadata?.name ?? ''}`.trim();
      onToast('success', `${result.created ? 'Created' : 'Updated'} ${label}`);
      queryClient.invalidateQueries({ queryKey: ['resource'] });
      queryClient.invalidateQueries({ queryKey: ['applications'] });
      onClose();
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to deploy resource');
    },
  });

  const targetLabel = `${scope.context ?? 'active context'}${namespace ? ` / ${namespace}` : ''}`;

  return (
    <Modal
      title="Add resource"
      onClose={onClose}
      footer={
        <>
          {error && <span className="badge danger create-resource-error">{error}</span>}
          <button onClick={onClose} disabled={apply.isPending}>
            Cancel
          </button>
          <button
            onClick={() => {
              setError('');
              validate.mutate();
            }}
            disabled={apply.isPending || validate.isPending || !draft.trim()}
          >
            {validate.isPending ? 'Validating...' : 'Validate'}
          </button>
          <button
            className="primary"
            onClick={() => {
              setError('');
              apply.mutate();
            }}
            disabled={apply.isPending || !draft.trim()}
          >
            {apply.isPending ? 'Deploying…' : '🚀 Deploy'}
          </button>
        </>
      }
    >
      <p className="dim create-resource-hint">
        Paste a Kubernetes manifest of any kind. It will be applied to <span className="mono">{targetLabel}</span>.
      </p>
      <div className="create-resource-controls">
        <div className="form-group create-resource-type">
          <label htmlFor="create-resource-type">Resource type</label>
          <select
            id="create-resource-type"
            value={selectedResourceType}
            onChange={(event) => {
              const nextResourceType = event.target.value;
              setSelectedResourceType(nextResourceType);
              setDraft(sampleManifest(nextResourceType));
              validate.reset();
            }}
          >
            {RESOURCE_TYPE_OPTIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div className="form-group create-resource-namespace">
          <label htmlFor="create-resource-namespace">Namespace</label>
          <select
            id="create-resource-namespace"
            value={namespace}
            onChange={(event) => {
              setNamespace(event.target.value);
              validate.reset();
            }}
          >
            {namespaces.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="create-resource-impact" aria-live="polite">
        {validate.isError ? (
          <span className="notice error">{validate.error instanceof Error ? validate.error.message : 'YAML validation failed.'}</span>
        ) : validate.data ? (
          <span className="notice success">
            YAML is valid. Applying will create <span className="mono">{validate.data.kind} {validate.data.name}</span> in{' '}
            <span className="mono">{validate.data.namespace ?? 'cluster scope'}</span>, or update it if it already exists.
          </span>
        ) : (
          <span className="dim">Validate the manifest to preview the resource and target namespace before applying it.</span>
        )}
      </div>
      <div className="yaml-editor-host">
        <Editor
          height="100%"
          language="yaml"
          theme="vs-dark"
          value={draft}
          onChange={(value) => {
            setDraft(value ?? '');
            validate.reset();
          }}
          options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false }}
        />
      </div>
    </Modal>
  );
}
