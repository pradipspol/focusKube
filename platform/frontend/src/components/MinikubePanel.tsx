import React, { useState } from 'react';
import {
  useMinikubeHealth,
  useMinikubeStatus,
  useMinikubeSetupScripts,
  useStartCluster,
  useStopCluster,
  useDeleteCluster,
  usePods,
  useDeployments,
  useNamespaces,
  usePodLogs,
  useTestPod,
  useDeployManifest,
} from '../api/minikubeApi';
import './MinikubePanel.css';

/**
 * Main Minikube Management Panel
 * Handles cluster lifecycle, deployments, and pod management
 */
type MinikubePanelProps = {
  onOpenExplorer: () => Promise<void>;
};

export const MinikubePanel: React.FC<MinikubePanelProps> = ({ onOpenExplorer }) => {
  const [clusterName, setClusterName] = useState('minikube');
  const [namespace, setNamespace] = useState('default');
  const [selectedPod, setSelectedPod] = useState<string | null>(null);
  const [showDeployForm, setShowDeployForm] = useState(false);
  const [manifestInput, setManifestInput] = useState('');
  const [openingExplorer, setOpeningExplorer] = useState(false);
  const [clusterConfig, setClusterConfig] = useState({
    driver: 'docker',
    cpus: 4,
    memory: '4096m',
  });

  // Queries
  const { data: health, isLoading: healthLoading } = useMinikubeHealth();
  const { data: statusData, isLoading: statusLoading } = useMinikubeStatus(clusterName);
  const isClusterRunning = statusData?.status === 'running';
  const { data: podsData, isLoading: podsLoading } = usePods(clusterName, namespace, isClusterRunning);
  const { data: deploymentsData, isLoading: deploymentsLoading } = useDeployments(
    clusterName,
    namespace,
    isClusterRunning,
  );
  const { data: namespacesData } = useNamespaces(clusterName, isClusterRunning);
  const { data: logsData } = usePodLogs(selectedPod || '', clusterName, namespace, isClusterRunning);
  const { data: setupScriptsData } = useMinikubeSetupScripts();

  // Mutations
  const startCluster = useStartCluster();
  const stopCluster = useStopCluster();
  const deleteCluster = useDeleteCluster();
  const testPod = useTestPod();
  const deployManifest = useDeployManifest();

  const status = statusData?.status || 'checking';
  const pods = podsData?.pods || [];
  const deployments = deploymentsData?.deployments || [];
  const namespaces = namespacesData?.namespaces || [];
  const setupScripts = setupScriptsData?.scripts || [];

  const downloadScript = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleStartCluster = async () => {
    try {
      await startCluster.mutateAsync({
        name: clusterName,
        ...clusterConfig,
      });
    } catch (err) {
      console.error('Failed to start cluster:', err);
    }
  };

  const handleStopCluster = async () => {
    try {
      await stopCluster.mutateAsync(clusterName);
    } catch (err) {
      console.error('Failed to stop cluster:', err);
    }
  };

  const handleDeleteCluster = async () => {
    if (!window.confirm(`Are you sure you want to delete cluster "${clusterName}"?`)) return;
    try {
      await deleteCluster.mutateAsync(clusterName);
    } catch (err) {
      console.error('Failed to delete cluster:', err);
    }
  };

  const handleTestPod = async (podName: string) => {
    try {
      await testPod.mutateAsync({ podName, clusterName, namespace });
    } catch (err) {
      console.error('Failed to test pod:', err);
    }
  };

  const handleDeployManifest = async () => {
    if (!manifestInput.trim()) return;
    try {
      await deployManifest.mutateAsync({ manifest: manifestInput, clusterName });
      setManifestInput('');
      setShowDeployForm(false);
    } catch (err) {
      console.error('Failed to deploy manifest:', err);
    }
  };

  const handleOpenResourceExplorer = async () => {
    try {
      setOpeningExplorer(true);
      await onOpenExplorer();
    } catch (err) {
      console.error('Failed to open Minikube resource explorer:', err);
    } finally {
      setOpeningExplorer(false);
    }
  };

  return (
    <div className="minikube-panel">
      <div className="minikube-header">
        <h2>Minikube Local Cluster</h2>
        {health?.installed ? (
          <span className="badge badge-success">Installed</span>
        ) : (
          <span className="badge badge-error">Not Installed</span>
        )}
      </div>

      {/* Cluster Status Section */}
      <section className="minikube-section">
        <h3>Cluster Status</h3>
        <div className="status-info">
          <div className="info-row">
            <label>Name:</label>
            <input
              type="text"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
              placeholder="minikube"
            />
          </div>
          <div className="info-row">
            <label>Status:</label>
            <span
              className={`status-badge status-${status}`}
            >
              {status === 'not-installed' ? 'Not Installed: Setup Minikube. Steps Below' : status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
          </div>
          {statusData?.kubernetesVersion && (
            <div className="info-row">
              <label>Kubernetes:</label>
              <span>{statusData.kubernetesVersion}</span>
            </div>
          )}
          {statusData?.ip && (
            <div className="info-row">
              <label>IP Address:</label>
              <span className="ip-address">{statusData.ip}</span>
            </div>
          )}
          {statusData?.driver && (
            <div className="info-row">
              <label>Driver:</label>
              <span>{statusData.driver}</span>
            </div>
          )}
        </div>
      </section>

      {/* Cluster Control Section */}
      <section className="minikube-section">
        <h3>Cluster Control</h3>
        <div className="button-group">
          <button
            className="btn btn-primary"
            onClick={handleStartCluster}
            disabled={status === 'running' || startCluster.isPending}
          >
            {startCluster.isPending ? 'Starting...' : 'Start'}
          </button>
          <button
            className="btn btn-warning"
            onClick={handleStopCluster}
            disabled={status !== 'running' || stopCluster.isPending}
          >
            {stopCluster.isPending ? 'Stopping...' : 'Stop'}
          </button>
          <button
            className="btn btn-danger"
            onClick={handleDeleteCluster}
            disabled={deleteCluster.isPending}
          >
            {deleteCluster.isPending ? 'Deleting...' : 'Delete'}
          </button>
        </div>

        {status !== 'running' && (
            <>
              <h4>Cluster Parameters</h4>
              <div className="form-group">
                <label>Driver:</label>
                <select
                  value={clusterConfig.driver}
                  onChange={(e) =>
                    setClusterConfig({ ...clusterConfig, driver: e.target.value })
                  }
                >
                  <option value="docker">Docker Desktop</option>
                  <option value="hyperv">Hyper-V</option>
                  <option value="virtualbox">VirtualBox</option>
                </select>
              </div>
              <div className="form-group">
                <label>CPUs:</label>
                <input
                  type="number"
                  min="1"
                  max="16"
                  value={clusterConfig.cpus}
                  onChange={(e) =>
                    setClusterConfig({
                      ...clusterConfig,
                      cpus: parseInt(e.target.value),
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label>Memory:</label>
                <input
                  type="text"
                  value={clusterConfig.memory}
                  onChange={(e) =>
                    setClusterConfig({ ...clusterConfig, memory: e.target.value })
                  }
                  placeholder="4096m"
                />
              </div>
            </>
        )}

        {status === 'running' && (
          <button
            className="btn btn-primary"
            onClick={handleOpenResourceExplorer}
            disabled={openingExplorer}
          >
            {openingExplorer ? 'Opening Explorer...' : 'Open Resource Explorer'}
          </button>
        )}
      </section>
      <section className="minikube-section">
        <h3>Cluster Setup Steps</h3>
        <div className="config-section">
          
          <p className="config-help-text">
            1. Download the script for your platform and driver.
            <br />
            2. Run it from a terminal or shell on your machine.
            <br />
            3. Windows Hyper-V scripts require administrator permission to enable the feature.
            Docker Desktop and VirtualBox scripts may still prompt for elevation when their
            installers run.
            <br />
            4. macOS and Linux scripts may ask for <code>sudo</code> when installing packages.
            <br />
            5. After the script finishes, come back here to start or manage Minikube.
          </p>
          <div className="script-list">
            {setupScripts.map((script) => (
              <div key={script.id} className="script-row">
                <div className="script-row-text">
                  <strong>{script.title}</strong>
                  <span>{script.filename}</span>
                </div>
                <button
                  className="btn btn-small"
                  onClick={() => downloadScript(script.content, script.filename)}
                >
                  Download
                </button>
              </div>
            ))}
          </div>
          <div className="script-note">
            Windows scripts are provided for Docker Desktop, Hyper-V, and VirtualBox. macOS and
            Linux scripts use Docker-based setup.
          </div>
        </div>
      </section>
    </div>
  );
};
