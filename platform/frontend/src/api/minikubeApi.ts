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

export const useMinikubeSetupScripts = () => {
  return useQuery({
    queryKey: ['minikube', 'setup-scripts'],
    queryFn: () => minikubeApi.getSetupScripts(),
    staleTime: Infinity,
  });
};
