import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export type MinikubeStatus = 'running' | 'stopped' | 'paused' | 'not-installed' | 'checking';

export type MinikubeCluster = {
  name: string;
  status: MinikubeStatus;
  driver?: string;
  kubernetesVersion?: string;
  ip?: string;
  cpus?: number;
  memory?: string;
};

export type DeploymentInfo = {
  name: string;
  namespace: string;
  replicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  availableReplicas: number;
  age: string;
};

export type PodInfo = {
  name: string;
  namespace: string;
  status: string;
  ready: string;
  restarts: number;
  age: string;
};

export type MinikubeSetupScript = {
  id: string;
  title: string;
  filename: string;
  platform: 'windows' | 'macos' | 'linux';
  driver?: 'docker' | 'hyperv' | 'virtualbox';
  shell: 'powershell' | 'bash';
  content: string;
};

const MINIKUBE_API_BASE = '/api/minikube';

/**
 * API client for Minikube operations
 */
export const minikubeApi = {
  async getHealth(): Promise<{ installed: boolean }> {
    const res = await fetch(`${MINIKUBE_API_BASE}/health`);
    if (!res.ok) throw new Error('Failed to check minikube health');
    return res.json();
  },

  async getStatus(clusterName: string = 'minikube'): Promise<MinikubeCluster> {
    const res = await fetch(`${MINIKUBE_API_BASE}/status?clusterName=${clusterName}`);
    if (!res.ok) throw new Error('Failed to get cluster status');
    return res.json();
  },

  async getKubeconfig(clusterName: string = 'minikube'): Promise<{ clusterName: string; kubeconfig: string }> {
    const params = new URLSearchParams({ clusterName });
    const res = await fetch(`${MINIKUBE_API_BASE}/kubeconfig?${params}`);
    if (!res.ok) throw new Error('Failed to export the Minikube kubeconfig');
    return res.json();
  },

  async getSetupScripts(): Promise<{ scripts: MinikubeSetupScript[] }> {
    const res = await fetch(`${MINIKUBE_API_BASE}/setup-scripts`);
    if (!res.ok) throw new Error('Failed to load Minikube setup scripts');
    return res.json();
  },

  async startCluster(options: {
    name?: string;
    driver?: string;
    cpus?: number;
    memory?: string;
    kubernetesVersion?: string;
  }): Promise<MinikubeCluster> {
    const res = await fetch(`${MINIKUBE_API_BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    if (!res.ok) throw new Error('Failed to start cluster');
    return res.json();
  },

  async stopCluster(clusterName: string = 'minikube'): Promise<MinikubeCluster> {
    const res = await fetch(`${MINIKUBE_API_BASE}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusterName }),
    });
    if (!res.ok) throw new Error('Failed to stop cluster');
    return res.json();
  },

  async deleteCluster(clusterName: string = 'minikube'): Promise<{ success: boolean; message: string }> {
    const res = await fetch(`${MINIKUBE_API_BASE}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clusterName }),
    });
    if (!res.ok) throw new Error('Failed to delete cluster');
    return res.json();
  },

  async deployManifest(manifest: string, clusterName: string = 'minikube'): Promise<{ success: boolean; output: string }> {
    const res = await fetch(`${MINIKUBE_API_BASE}/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest, clusterName }),
    });
    if (!res.ok) throw new Error('Failed to deploy manifest');
    return res.json();
  },

  async getDeployments(
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{ deployments: DeploymentInfo[] }> {
    const params = new URLSearchParams({ clusterName, namespace });
    const res = await fetch(`${MINIKUBE_API_BASE}/deployments?${params}`);
    if (!res.ok) throw new Error('Failed to get deployments');
    return res.json();
  },

  async getPods(
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{ pods: PodInfo[] }> {
    const params = new URLSearchParams({ clusterName, namespace });
    const res = await fetch(`${MINIKUBE_API_BASE}/pods?${params}`);
    if (!res.ok) throw new Error('Failed to get pods');
    return res.json();
  },

  async getPodLogs(
    podName: string,
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{ logs: string }> {
    const params = new URLSearchParams({ clusterName, namespace });
    const res = await fetch(`${MINIKUBE_API_BASE}/pods/${podName}/logs?${params}`);
    if (!res.ok) throw new Error('Failed to get pod logs');
    return res.json();
  },

  async execInPod(
    podName: string,
    command: string[],
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{ output: string }> {
    const params = new URLSearchParams({ clusterName, namespace });
    const res = await fetch(`${MINIKUBE_API_BASE}/pods/${podName}/exec?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    if (!res.ok) throw new Error('Failed to execute command in pod');
    return res.json();
  },

  async testPod(
    podName: string,
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{ name: string; status: string; readiness: boolean; logs: string }> {
    const params = new URLSearchParams({ clusterName, namespace });
    const res = await fetch(`${MINIKUBE_API_BASE}/pods/${podName}/test?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error('Failed to test pod');
    return res.json();
  },

  async getNamespaces(clusterName: string = 'minikube'): Promise<{ namespaces: string[] }> {
    const params = new URLSearchParams({ clusterName });
    const res = await fetch(`${MINIKUBE_API_BASE}/namespaces?${params}`);
    if (!res.ok) throw new Error('Failed to get namespaces');
    return res.json();
  },
};

/**
 * React hooks for Minikube operations
 */

export const useMinikubeHealth = () => {
  return useQuery({
    queryKey: ['minikube', 'health'],
    queryFn: () => minikubeApi.getHealth(),
    refetchInterval: 30000, // 30 seconds
  });
};

export const useMinikubeStatus = (clusterName: string = 'minikube') => {
  return useQuery({
    queryKey: ['minikube', 'status', clusterName],
    queryFn: () => minikubeApi.getStatus(clusterName),
    refetchInterval: 10000, // 10 seconds
  });
};

export const useStartCluster = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: Parameters<typeof minikubeApi.startCluster>[0]) =>
      minikubeApi.startCluster(options),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['minikube', 'status'] });
    },
  });
};

export const useStopCluster = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clusterName: string) => minikubeApi.stopCluster(clusterName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['minikube', 'status'] });
    },
  });
};

export const useDeleteCluster = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (clusterName: string) => minikubeApi.deleteCluster(clusterName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['minikube'] });
    },
  });
};

export const useDeployManifest = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      manifest,
      clusterName,
    }: {
      manifest: string;
      clusterName?: string;
    }) => minikubeApi.deployManifest(manifest, clusterName),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ['minikube', 'deployments', variables.clusterName || 'minikube'],
      });
    },
  });
};

export const useDeployments = (
  clusterName: string = 'minikube',
  namespace: string = 'default',
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ['minikube', 'deployments', clusterName, namespace],
    queryFn: () => minikubeApi.getDeployments(clusterName, namespace),
    enabled,
    refetchInterval: 15000, // 15 seconds
  });
};

export const usePods = (
  clusterName: string = 'minikube',
  namespace: string = 'default',
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ['minikube', 'pods', clusterName, namespace],
    queryFn: () => minikubeApi.getPods(clusterName, namespace),
    enabled,
    refetchInterval: 15000, // 15 seconds
  });
};

export const usePodLogs = (
  podName: string,
  clusterName: string = 'minikube',
  namespace: string = 'default',
  enabled: boolean = true,
) => {
  return useQuery({
    queryKey: ['minikube', 'pod-logs', podName, clusterName, namespace],
    queryFn: () => minikubeApi.getPodLogs(podName, clusterName, namespace),
    enabled: !!podName && enabled,
  });
};

export const useTestPod = () => {
  return useMutation({
    mutationFn: ({
      podName,
      clusterName,
      namespace,
    }: {
      podName: string;
      clusterName?: string;
      namespace?: string;
    }) => minikubeApi.testPod(podName, clusterName, namespace),
  });
};

export const useNamespaces = (clusterName: string = 'minikube', enabled: boolean = true) => {
  return useQuery({
    queryKey: ['minikube', 'namespaces', clusterName],
    queryFn: () => minikubeApi.getNamespaces(clusterName),
    enabled,
    refetchInterval: 30000, // 30 seconds
  });
};

export const useMinikubeSetupScripts = () => {
  return useQuery({
    queryKey: ['minikube', 'setup-scripts'],
    queryFn: () => minikubeApi.getSetupScripts(),
    staleTime: Infinity,
  });
};
