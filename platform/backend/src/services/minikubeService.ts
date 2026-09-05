import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { serverError } from '../util/httpError.js';
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

export class MinikubeService {
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
