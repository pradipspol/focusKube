export interface KubeContext {
  name: string;
  cluster: string;
  user: string;
  namespace?: string;
  active: boolean;
  connected?: boolean;
  source?: {
    provider: 'aks' | 'eks' | 'local' | 'minikube';
    subscriptionId?: string;
    subscriptionName?: string;
    resourceGroup?: string;
    clusterName?: string;
    accountId?: string;
    region?: string;
  };
}

export interface ContextsResponse {
  active?: string;
  contexts: KubeContext[];
  localKubeconfigs?: LocalKubeconfigSummary[];
}

export interface LocalKubeconfigSummary {
  id: string;
  name: string;
  contexts: string[];
  createdAt: string;
  updatedAt: string;
}

export interface K8sObject {
  apiVersion?: string;
  kind?: string;
  dataKeys?: string[];
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    uid?: string;
    [k: string]: unknown;
  };
  spec?: any;
  status?: any;
  data?: Record<string, string>;
  type?: string;
  [k: string]: unknown;
}

export interface ResourceKindMeta {
  plural: string;
  apiVersion: string;
  kind: string;
  namespaced: boolean;
}

export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

export interface HelmChart {
  name: string;
  version: string;
  app_version?: string;
  description?: string;
}

export interface HelmHistoryEntry {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

export interface DeploymentRevision {
  revision: number;
  name: string;
  createdAt: string;
  images: string[];
}

export interface AzureAccount {
  name: string;
  user?: { name?: string; type?: string };
  id: string;
  tenantId?: string;
}

export interface AzureSubscription {
  id: string;
  name: string;
  isDefault: boolean;
  tenantId?: string;
  tenantDisplayName?: string;
}

/** A signed-in Azure identity grouped with the subscriptions it owns. */
export interface AzureAccountGroup {
  id: string;
  email: string;
  userType?: string;
  subscriptions: AzureSubscription[];
}

export interface AksCluster {
  name: string;
  resourceGroup: string;
  location: string;
  kubernetesVersion: string;
  powerState?: { code: string };
}

export interface AwsIdentity {
  account: string;
  arn: string;
  userId: string;
}

export interface EksCluster {
  name: string;
  region: string;
  arn?: string;
  endpoint?: string;
  status?: string;
  version?: string;
}

export interface DeviceCodeInfo {
  message: string;
  verificationUrl?: string;
  userCode?: string;
}

export interface AzureLoginStatus {
  state: 'idle' | 'pending' | 'succeeded' | 'failed' | string;
  message: string;
  deviceInfo: DeviceCodeInfo | null;
  diagnostics?: {
    lastAzCandidate?: string;
  };
}

export interface AwsLoginStatus {
  state: 'idle' | 'pending' | 'succeeded' | 'failed' | string;
  message: string;
  deviceInfo: DeviceCodeInfo | null;
  diagnostics?: {
    lastAwsCandidate?: string;
  };
}

export type AwsAuthConfig =
  | {
      mode: 'sso';
      profileName: string;
      ssoSessionName?: string;
      ssoStartUrl: string;
      ssoRegion: string;
      accountId: string;
      roleName: string;
      region: string;
      output?: string;
    }
  | {
      mode: 'static';
      profileName: string;
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
      region: string;
      output?: string;
    }
  | {
      mode: 'role';
      profileName: string;
      roleArn: string;
      region: string;
      output?: string;
      sourceProfileName?: string;
      credentialSource?: 'Environment' | 'Ec2InstanceMetadata' | 'EcsContainer';
      roleSessionName?: string;
    };

export type Role = 'admin' | 'editor' | 'rwonly' | 'viewer';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface PodMetricsContainer {
  name: string;
  cpu: string;
  memory: string;
  cpuMillicores: number;
  memoryBytes: number;
}

export interface PodMetricsSnapshot {
  timestamp?: string;
  window?: string;
  containers: PodMetricsContainer[];
}

export interface PodMetricsBatchItem {
  name: string;
  namespace?: string;
  snapshot?: PodMetricsSnapshot;
  error?: string;
}

export interface PodMetricsBatchResponse {
  items: PodMetricsBatchItem[];
}

export interface ClusterOverviewResponse {
  resources: Record<string, K8sObject[]>;
  nodes: K8sObject[];
  nodesForbidden: boolean;
  metrics: { cpuMillicores: number; memoryBytes: number; at: number };
  events: Array<{
    type?: string;
    reason?: string;
    message?: string;
    involvedObject?: { kind?: string; name?: string; namespace?: string };
    timestamp?: string;
  }>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogLevelSettingsResponse {
  level: LogLevel;
  envLevel?: LogLevel;
  overriddenByUi?: boolean;
  editable: boolean;
  mode: 'desktop';
}

// Observability types
export interface ChangeEventDoc {
  _id?: string;
  recordingId?: string;
  context: string;
  namespace?: string;
  kind: 'Pod' | 'Deployment' | 'ReplicaSet' | 'StatefulSet' | 'Event';
  name: string;
  uid?: string;
  ts: string;
  category: 'workloadChange' | 'k8sEvent';
  changeType: 'created' | 'deleted' | 'phase' | 'condition' | 'restartCount' | 'image' | 'warningEvent' | 'normalEvent';
  severity: 'info' | 'warning' | 'error';
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  involvedObject?: { kind: string; name: string; namespace?: string };
  correlatedWith?: {
    kind: string;
    namespace?: string;
    name: string;
    changeType: string;
    minutesBefore: number;
  };
}

export interface RecordingSessionDoc {
  _id?: string;
  context: string;
  userId?: string;
  startedAt: string;
  stoppedAt?: string;
  status: 'active' | 'stopped' | 'error';
  errorMessage?: string;
}
