import React, { useState } from 'react';
import {
  useMinikubeHealth,
  useMinikubeStatus,
  useMinikubeSetupScripts,
  useStartCluster,
  useStopCluster,
  useDeleteCluster,
} from '../api/minikubeApi';
import { uiText } from '../text';
import { LoadingOverlay } from './LoadingOverlay';
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
  const [openingExplorer, setOpeningExplorer] = useState(false);
  const [clusterConfig, setClusterConfig] = useState({
    driver: 'docker',
    cpus: 4,
    memory: '4096m',
  });

  // Queries
  const { data: health, isLoading: healthLoading } = useMinikubeHealth();
  const { data: statusData, isLoading: statusLoading } = useMinikubeStatus(clusterName);
  const { data: setupScriptsData } = useMinikubeSetupScripts();

  // Mutations
  const startCluster = useStartCluster();
  const stopCluster = useStopCluster();
  const deleteCluster = useDeleteCluster();

  const status = statusData?.status || 'checking';
  // `minikube status` reports 'not-installed' both when the binary is genuinely missing and
  // when it's installed but the cluster isn't running. Split those apart for display so the
  // badge text and its colour agree (there is a distinct .status-stopped style).
  const displayStatus = status === 'not-installed' && health?.installed ? 'stopped' : status;
  const setupScripts = setupScriptsData?.scripts || [];
  const loadingMessage = startCluster.isPending
    ? uiText.minikube.starting
    : stopCluster.isPending
      ? uiText.minikube.stopping
      : openingExplorer
        ? uiText.minikube.openingExplorer
        : healthLoading || statusLoading
          ? uiText.minikube.checkingStatus
          : null;

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
      {loadingMessage && <LoadingOverlay message={loadingMessage} />}
      <div className="minikube-header">
        <h2>{uiText.minikube.title}</h2>
        {health?.installed ? (
          <span className="badge badge-success">{uiText.minikube.installed}</span>
        ) : (
          <span className="badge badge-error">{uiText.minikube.notInstalled}</span>
        )}
      </div>

      {/* Cluster Status Section */}
      <section className="minikube-section">
        <h3>{uiText.minikube.clusterStatus}</h3>
        <div className="status-info">
          <div className="info-row">
            <label>{uiText.minikube.name}</label>
            <input
              type="text"
              value={clusterName}
              onChange={(e) => setClusterName(e.target.value)}
              placeholder={uiText.minikube.namePlaceholder}
            />
          </div>
          <div className="info-row">
            <label>{uiText.minikube.status}</label>
            <span
              className={`status-badge status-${displayStatus}`}
            >
              {health?.installed
                ? displayStatus === 'stopped'
                  ? uiText.minikube.clusterStopped
                  : displayStatus.charAt(0).toUpperCase() + displayStatus.slice(1)
                : uiText.minikube.notInstalledSetup}
            </span>
          </div>
          {statusData?.kubernetesVersion && (
            <div className="info-row">
              <label>{uiText.minikube.kubernetes}</label>
              <span>{statusData.kubernetesVersion}</span>
            </div>
          )}
          {statusData?.ip && (
            <div className="info-row">
              <label>{uiText.minikube.ipAddress}</label>
              <span className="ip-address">{statusData.ip}</span>
            </div>
          )}
          {statusData?.driver && (
            <div className="info-row">
              <label>{uiText.minikube.driver}</label>
              <span>{statusData.driver}</span>
            </div>
          )}
        </div>
      </section>

      {/* Cluster Control Section */}
      <section className="minikube-section">
        <h3>{uiText.minikube.clusterControl}</h3>
        <div className="button-group">
          <button
            className="btn btn-primary"
            onClick={handleStartCluster}
            disabled={status === 'running' || startCluster.isPending}
          >
            {startCluster.isPending ? uiText.minikube.starting : uiText.minikube.start}
          </button>
          <button
            className="btn btn-warning"
            onClick={handleStopCluster}
            disabled={status !== 'running' || stopCluster.isPending}
          >
            {stopCluster.isPending ? uiText.minikube.stopping : uiText.minikube.stop}
          </button>
          <button
            className="btn btn-danger"
            onClick={handleDeleteCluster}
            disabled={deleteCluster.isPending}
          >
            {deleteCluster.isPending ? uiText.minikube.deleting : uiText.minikube.delete}
          </button>
        </div>

        {status !== 'running' && (
            <>
              <h4>{uiText.minikube.clusterParameters}</h4>
              <div className="form-group">
                <label>{uiText.minikube.driver}</label>
                <select
                  value={clusterConfig.driver}
                  onChange={(e) =>
                    setClusterConfig({ ...clusterConfig, driver: e.target.value })
                  }
                >
                  <option value="docker">{uiText.minikube.dockerDesktop}</option>
                  <option value="hyperv">{uiText.minikube.hyperV}</option>
                  <option value="virtualbox">{uiText.minikube.virtualBox}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{uiText.minikube.cpus}</label>
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
                <label>{uiText.minikube.memory}</label>
                <input
                  type="text"
                  value={clusterConfig.memory}
                  onChange={(e) =>
                    setClusterConfig({ ...clusterConfig, memory: e.target.value })
                  }
                  placeholder={uiText.minikube.memoryPlaceholder}
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
            {openingExplorer ? uiText.minikube.openingExplorer : uiText.minikube.openResourceExplorer}
          </button>
        )}
      </section>
      <section className="minikube-section">
        <h3>{uiText.minikube.setupSteps}</h3>
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
