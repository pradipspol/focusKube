import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { badRequest, serverError } from '../util/httpError.js';
import { logInfo, logWarn, logError } from '../util/logger.js';

const execAsync = promisify(exec);

export type MinikubeStatus = 'running' | 'stopped' | 'paused' | 'not-installed';

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

export class MinikubeService {
  private minikubeHome: string;
  private kubeconfig: string;

  constructor() {
    this.minikubeHome = path.join(process.env.HOME || process.env.USERPROFILE || '', '.minikube');
    this.kubeconfig = path.join(this.minikubeHome, 'kubeconfig');
  }

  /**
   * Check if minikube is installed
   */
  async isMinikubeInstalled(): Promise<boolean> {
    try {
      await execAsync('minikube version');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get current minikube cluster status
   */
  async getStatus(clusterName: string = 'minikube'): Promise<MinikubeCluster> {
    try {
      const { stdout } = await execAsync(`minikube status -p ${clusterName}`);

      // Parse minikube status output
      const lines = stdout.split('\n');
      const statusLine = lines.find((l) => l.includes('host:'));
      const status = this.parseMinikubeStatus(stdout);

      return {
        name: clusterName,
        status,
        driver: this.extractField(stdout, 'driver:'),
        kubernetesVersion: this.extractField(stdout, 'kubernetes:'),
        ip: await this.getMinikubeIP(clusterName),
      };
    } catch (err) {
      logWarn(`Failed to get minikube status: ${(err as Error).message}`);
      return {
        name: clusterName,
        status: 'not-installed',
      };
    }
  }

  async exportKubeconfig(clusterName: string = 'minikube'): Promise<{ clusterName: string; kubeconfig: string }> {
    try {
      const { stdout } = await execAsync(`minikube -p ${clusterName} kubectl -- config view --raw --minify`);
      if (!stdout.trim()) throw new Error('Minikube returned an empty kubeconfig');
      return { clusterName, kubeconfig: stdout };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to export Minikube kubeconfig: ${errorMsg}`);
      throw serverError(`Failed to export Minikube kubeconfig: ${errorMsg}`);
    }
  }

  async getSetupScripts(): Promise<MinikubeSetupScript[]> {
    return [
      {
        id: 'windows-powershell-docker',
        title: 'Windows PowerShell - Docker Desktop',
        filename: 'focuskube-minikube-windows-docker.ps1',
        platform: 'windows',
        driver: 'docker',
        shell: 'powershell',
        content: this.buildWindowsPowerShellScript('docker'),
      },
      {
        id: 'windows-powershell-hyperv',
        title: 'Windows PowerShell - Hyper-V',
        filename: 'focuskube-minikube-windows-hyperv.ps1',
        platform: 'windows',
        driver: 'hyperv',
        shell: 'powershell',
        content: this.buildWindowsPowerShellScript('hyperv'),
      },
      {
        id: 'windows-powershell-virtualbox',
        title: 'Windows PowerShell - VirtualBox',
        filename: 'focuskube-minikube-windows-virtualbox.ps1',
        platform: 'windows',
        driver: 'virtualbox',
        shell: 'powershell',
        content: this.buildWindowsPowerShellScript('virtualbox'),
      },
      {
        id: 'macos-bash-docker',
        title: 'macOS Bash - Docker Desktop',
        filename: 'focuskube-minikube-macos-docker.sh',
        platform: 'macos',
        driver: 'docker',
        shell: 'bash',
        content: this.buildUnixSetupScript('macos', 'docker'),
      },
      {
        id: 'linux-bash-docker',
        title: 'Linux Bash - Docker',
        filename: 'focuskube-minikube-linux-docker.sh',
        platform: 'linux',
        driver: 'docker',
        shell: 'bash',
        content: this.buildUnixSetupScript('linux', 'docker'),
      },
    ];
  }

  /**
   * Start a minikube cluster
   */
  async startCluster(options: {
    name?: string;
    driver?: string;
    cpus?: number;
    memory?: string;
    kubernetesVersion?: string;
  } = {}): Promise<MinikubeCluster> {
    const clusterName = options.name || 'minikube';

    try {
      logInfo(`Starting minikube cluster: ${clusterName}`);

      const cmd = this.buildStartCommand(clusterName, options);
      await execAsync(cmd, { timeout: 300000 }); // 5 minute timeout

      logInfo(`Minikube cluster ${clusterName} started successfully`);
      return this.getStatus(clusterName);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to start minikube: ${errorMsg}`);
      throw serverError(`Failed to start minikube cluster: ${errorMsg}`);
    }
  }

  /**
   * Stop a minikube cluster
   */
  async stopCluster(clusterName: string = 'minikube'): Promise<MinikubeCluster> {
    try {
      logInfo(`Stopping minikube cluster: ${clusterName}`);
      await execAsync(`minikube stop -p ${clusterName}`);

      logInfo(`Minikube cluster ${clusterName} stopped`);
      return this.getStatus(clusterName);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to stop minikube: ${errorMsg}`);
      throw serverError(`Failed to stop minikube cluster: ${errorMsg}`);
    }
  }

  /**
   * Delete a minikube cluster
   */
  async deleteCluster(clusterName: string = 'minikube'): Promise<{ success: boolean; message: string }> {
    try {
      logInfo(`Deleting minikube cluster: ${clusterName}`);
      await execAsync(`minikube delete -p ${clusterName}`);

      logInfo(`Minikube cluster ${clusterName} deleted`);
      return { success: true, message: `Cluster ${clusterName} deleted successfully` };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to delete minikube: ${errorMsg}`);
      throw serverError(`Failed to delete minikube cluster: ${errorMsg}`);
    }
  }

  /**
   * Deploy a manifest to minikube
   */
  async deployManifest(manifest: string, clusterName: string = 'minikube'): Promise<{ success: boolean; output: string }> {
    try {
      if (!manifest || manifest.trim().length === 0) {
        throw badRequest('Manifest cannot be empty');
      }

      logInfo(`Deploying manifest to minikube cluster: ${clusterName}`);

      // Write manifest to temp file
      const tempManifestPath = path.join(this.minikubeHome, `manifest-${Date.now()}.yaml`);
      fs.writeFileSync(tempManifestPath, manifest);

      try {
        const kubeconfig = this.getKubeconfigPath(clusterName);
        const { stdout } = await execAsync(
          `kubectl apply -f ${tempManifestPath} --kubeconfig=${kubeconfig}`,
        );

        logInfo(`Manifest deployed successfully to ${clusterName}`);
        return { success: true, output: stdout };
      } finally {
        // Clean up temp file
        try {
          fs.unlinkSync(tempManifestPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to deploy manifest: ${errorMsg}`);
      throw serverError(`Failed to deploy manifest: ${errorMsg}`);
    }
  }

  /**
   * Get deployments in minikube
   */
  async getDeployments(
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<DeploymentInfo[]> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(kubeconfig);

      const k8sApi = kc.makeApiClient(k8s.AppsV1Api);
      const response = await k8sApi.listNamespacedDeployment(namespace);

      return response.body.items.map((deployment) => ({
        name: deployment.metadata?.name || '',
        namespace: deployment.metadata?.namespace || namespace,
        replicas: deployment.spec?.replicas || 0,
        readyReplicas: deployment.status?.readyReplicas || 0,
        updatedReplicas: deployment.status?.updatedReplicas || 0,
        availableReplicas: deployment.status?.availableReplicas || 0,
        age: this.calculateAge(deployment.metadata?.creationTimestamp),
      }));
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to get deployments: ${errorMsg}`);
      throw serverError(`Failed to get deployments: ${errorMsg}`);
    }
  }

  /**
   * Get pods in minikube
   */
  async getPods(
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<PodInfo[]> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(kubeconfig);

      const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      const response = await k8sApi.listNamespacedPod(namespace);

      return response.body.items.map((pod) => {
        const ready = pod.status?.conditions?.filter((c) => c.type === 'Ready')[0]?.status === 'True' ? 1 : 0;
        const totalContainers = pod.spec?.containers?.length || 0;

        return {
          name: pod.metadata?.name || '',
          namespace: pod.metadata?.namespace || namespace,
          status: pod.status?.phase || 'Unknown',
          ready: `${ready}/${totalContainers}`,
          restarts: pod.status?.containerStatuses?.[0]?.restartCount || 0,
          age: this.calculateAge(pod.metadata?.creationTimestamp),
        };
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to get pods: ${errorMsg}`);
      throw serverError(`Failed to get pods: ${errorMsg}`);
    }
  }

  /**
   * Get logs from a pod
   */
  async getPodLogs(
    podName: string,
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<string> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const { stdout } = await execAsync(
        `kubectl logs ${podName} -n ${namespace} --kubeconfig=${kubeconfig} --tail=100`,
      );

      return stdout;
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to get pod logs: ${errorMsg}`);
      throw serverError(`Failed to get pod logs: ${errorMsg}`);
    }
  }

  /**
   * Execute command in a pod
   */
  async execInPod(
    podName: string,
    command: string[],
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<string> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const cmdStr = command.join(' ');
      const { stdout } = await execAsync(
        `kubectl exec ${podName} -n ${namespace} --kubeconfig=${kubeconfig} -- ${cmdStr}`,
      );

      return stdout;
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to execute command in pod: ${errorMsg}`);
      throw serverError(`Failed to execute command in pod: ${errorMsg}`);
    }
  }

  /**
   * Test pod connectivity
   */
  async testPod(
    podName: string,
    clusterName: string = 'minikube',
    namespace: string = 'default',
  ): Promise<{
    name: string;
    status: string;
    readiness: boolean;
    logs: string;
  }> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(kubeconfig);

      const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      const { body: pod } = await k8sApi.readNamespacedPod(podName, namespace);

      const isReady = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') || false;
      const logs = await this.getPodLogs(podName, clusterName, namespace);

      return {
        name: podName,
        status: pod.status?.phase || 'Unknown',
        readiness: isReady,
        logs: logs.substring(0, 500), // First 500 chars of logs
      };
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to test pod: ${errorMsg}`);
      throw serverError(`Failed to test pod: ${errorMsg}`);
    }
  }

  /**
   * Get list of available namespaces
   */
  async getNamespaces(clusterName: string = 'minikube'): Promise<string[]> {
    try {
      const kubeconfig = this.getKubeconfigPath(clusterName);
      const kc = new k8s.KubeConfig();
      kc.loadFromFile(kubeconfig);

      const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
      const response = await k8sApi.listNamespace();

      return response.body.items.map((ns) => ns.metadata?.name || '').filter((name) => !!name);
    } catch (err) {
      const errorMsg = (err as Error).message;
      logError(`Failed to get namespaces: ${errorMsg}`);
      throw serverError(`Failed to get namespaces: ${errorMsg}`);
    }
  }

  // ===== Private Helper Methods =====

  private buildStartCommand(
    clusterName: string,
    options: {
      driver?: string;
      cpus?: number;
      memory?: string;
      kubernetesVersion?: string;
    },
  ): string {
    let cmd = `minikube start -p ${clusterName}`;

    if (options.driver) {
      cmd += ` --driver=${options.driver}`;
    }
    if (options.cpus) {
      cmd += ` --cpus=${options.cpus}`;
    }
    if (options.memory) {
      cmd += ` --memory=${options.memory}`;
    }
    if (options.kubernetesVersion) {
      cmd += ` --kubernetes-version=${options.kubernetesVersion}`;
    }

    return cmd;
  }

  private buildWindowsPowerShellScript(driver: 'docker' | 'hyperv' | 'virtualbox'): string {
    const driverInstall =
      driver === 'docker'
        ? `Write-Host 'Docker Desktop is required for the Docker driver. If it is not installed, install it from https://www.docker.com/products/docker-desktop/'`
        : driver === 'hyperv'
          ? `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All -NoRestart\nWrite-Host 'Hyper-V was enabled. A reboot may be required before starting Minikube.'`
          : `Write-Host 'VirtualBox is required for the VirtualBox driver. Install it from https://www.virtualbox.org/wiki/Downloads'`;

    const driverFlag = driver === 'virtualbox' ? 'virtualbox' : driver;

    return `#requires -Version 5.1
$ErrorActionPreference = 'Stop'

Write-Host 'Installing Minikube prerequisites for Windows...'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget is required to install Minikube automatically. Install App Installer from the Microsoft Store, then rerun this script.'
}

winget install -e --id Kubernetes.minikube --accept-package-agreements --accept-source-agreements
winget install -e --id Kubernetes.kubectl --accept-package-agreements --accept-source-agreements

${driverInstall}

Write-Host 'Starting Minikube with the ${driverFlag} driver...'
minikube start --driver=${driverFlag} --cpus=4 --memory=4096mb
minikube status
`;
  }

  private buildUnixSetupScript(platform: 'macos' | 'linux', driver: 'docker'): string {
    const packageManagerCheck =
      platform === 'macos'
        ? `if ! command -v brew >/dev/null 2>&1; then\n  echo 'Homebrew is required. Install it first from https://brew.sh/'\n  exit 1\nfi`
        : `if ! command -v apt-get >/dev/null 2>&1 && ! command -v yum >/dev/null 2>&1 && ! command -v dnf >/dev/null 2>&1; then\n  echo 'A supported package manager (apt, yum, or dnf) is required.'\n  exit 1\nfi`;

    const installCommands =
      platform === 'macos'
        ? `brew install minikube kubectl`
        : `if command -v apt-get >/dev/null 2>&1; then\n  sudo apt-get update\n  sudo apt-get install -y curl wget apt-transport-https\n  curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube_latest_amd64.deb\n  sudo dpkg -i minikube_latest_amd64.deb\n  rm -f minikube_latest_amd64.deb\n  sudo apt-get install -y kubectl || true\nelif command -v dnf >/dev/null 2>&1; then\n  sudo dnf install -y https://storage.googleapis.com/minikube/releases/latest/minikube-latest.x86_64.rpm\n  sudo dnf install -y kubectl || true\nelse\n  sudo yum install -y https://storage.googleapis.com/minikube/releases/latest/minikube-latest.x86_64.rpm\n  sudo yum install -y kubectl || true\nfi`;

    const dockerHint =
      platform === 'macos'
        ? `open -a Docker || echo 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/'`
        : `echo 'Install Docker Engine or Docker Desktop for your distribution if it is not already present.'`;

    return `#!/usr/bin/env bash
set -euo pipefail

echo 'Installing Minikube prerequisites for ${platform}...'
${packageManagerCheck}

${installCommands}

${dockerHint}

echo 'Starting Minikube with the ${driver} driver...'
minikube start --driver=${driver} --cpus=4 --memory=4096mb
minikube status
`;
  }

  private parseMinikubeStatus(output: string): MinikubeStatus {
    if (output.includes('Running')) return 'running';
    if (output.includes('Stopped')) return 'stopped';
    if (output.includes('Paused')) return 'paused';
    return 'not-installed';
  }

  private extractField(output: string, fieldName: string): string | undefined {
    const match = output.match(new RegExp(`${fieldName}\\s+(.+?)(?:\n|$)`, 'i'));
    return match ? match[1].trim() : undefined;
  }

  private async getMinikubeIP(clusterName: string): Promise<string | undefined> {
    try {
      const { stdout } = await execAsync(`minikube ip -p ${clusterName}`);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private getKubeconfigPath(clusterName: string): string {
    if (clusterName === 'minikube') {
      return this.kubeconfig;
    }
    return path.join(this.minikubeHome, `kubeconfig-${clusterName}`);
  }

  private calculateAge(createdAt?: string | Date): string {
    if (!createdAt) return 'Unknown';

    const created = new Date(createdAt);
    const now = new Date();
    const diffMs = now.getTime() - created.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) return `${diffDays}d`;
    if (diffHours > 0) return `${diffHours}h`;
    if (diffMins > 0) return `${diffMins}m`;
    return 'now';
  }
}

export const minikubeService = new MinikubeService();
