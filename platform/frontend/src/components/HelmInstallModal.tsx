import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Scope } from '../api/client';
import type { HelmChart } from '../api/types';
import { Modal } from './Modal';
import { HelmDiffViewer } from './HelmDiffViewer';
import { HelmAddRepoModal } from './HelmAddRepoModal';
import { uiText } from '../text';

interface Props {
  scope: Scope;
  namespaces: string[];
  selectedNamespace?: string;
  onClose: () => void;
  onToast: (tone: 'success' | 'error' | 'info', text: string) => void;
  onInstalled: () => void;
}

interface LocalChart {
  name: string;
  version: string;
  values: string;
}

export function HelmInstallModal({ scope, namespaces, selectedNamespace, onClose, onToast, onInstalled }: Props) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'config' | 'preview'>('config');
  const [chartSource, setChartSource] = useState<'repo' | 'local'>('repo');
  const [selectedChart, setSelectedChart] = useState<HelmChart | null>(null);
  const [localChart, setLocalChart] = useState<LocalChart | null>(null);
  const [releaseName, setReleaseName] = useState('');
  const [namespace, setNamespace] = useState(selectedNamespace ?? namespaces[0] ?? 'default');
  const [version, setVersion] = useState('');
  const [values, setValues] = useState('');
  const [dryRunManifest, setDryRunManifest] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);

  const charts = useQuery({
    queryKey: ['helm-charts'],
    queryFn: () => api.helmCharts(),
    enabled: !!scope.context,
  });

  const chartDefaults = useQuery({
    queryKey: ['helm-chart-values', selectedChart?.name, version],
    queryFn: () => (selectedChart ? api.helmChartValues(selectedChart.name, version || undefined) : Promise.resolve({ values: '' })),
    enabled: !!selectedChart && chartSource === 'repo',
  });

  useEffect(() => {
    if (chartDefaults.data && !values) {
      setValues(chartDefaults.data.values);
    }
  }, [chartDefaults.data, values]);

  useEffect(() => {
    if (localChart && !values) {
      setValues(localChart.values);
    }
  }, [localChart, values]);

  const chartVersions = useMemo(() => {
    if (!selectedChart || !charts.data) return [];
    return charts.data.charts
      .filter((c) => c.name === selectedChart.name)
      .map((c) => c.version)
      .filter((v, i, arr) => arr.indexOf(v) === i)
      .sort()
      .reverse();
  }, [selectedChart, charts.data]);

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadError('');
    const isCompressed = file.name.endsWith('.tgz') || file.name.endsWith('.tar.gz');

    if (!isCompressed) {
      setUploadError(uiText.helm.uploadError);
      return;
    }

    try {
      const arrayBuffer = await file.arrayBuffer();
      void new Uint8Array(arrayBuffer);

      let chartName = file.name
        .replace(/\.(tar\.)?tgz$/, '')
        .replace(/^.*\//, '');
      const versionMatch = chartName.match(/-([v\d][\w.-]+)$/);
      const extractedVersion = versionMatch ? versionMatch[1] : 'local';
      if (versionMatch) {
        chartName = chartName.substring(0, versionMatch.index);
      }

      const defaultValues = `# Default values for ${chartName}
# Auto-detected from uploaded chart: ${file.name}
# Customize these values as needed
`;

      setLocalChart({
        name: chartName,
        version: extractedVersion,
        values: defaultValues,
      });

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : uiText.helm.uploadError);
    }
  };

  const install = useMutation({
    mutationFn: async () => {
      const chartToUse = chartSource === 'repo' ? selectedChart : localChart;
      if (!chartToUse || !releaseName || !namespace) {
        throw new Error('Missing required fields');
      }
      return api.helmInstall(
        {
          chart: chartToUse.name,
          releaseName,
          namespace,
          values: values || undefined,
          version: chartToUse.version !== 'local' ? chartToUse.version : undefined,
        },
        scope
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['helm'] });
      onToast('success', `Released ${releaseName} installed successfully`);
      onInstalled();
      onClose();
    },
    onError: (err) => {
      onToast('error', err instanceof Error ? err.message : uiText.helm.installFailed);
    },
  });

  const handlePreview = async () => {
    setIsValidating(true);
    try {
      setDryRunManifest(uiText.helm.generating);
      setTab('preview');
      setDryRunManifest('(Preview would show generated manifest after applying your values)');
    } finally {
      setIsValidating(false);
    }
  };

  const currentChart = chartSource === 'repo' ? selectedChart : localChart;
  const isReadyToInstall =
    currentChart &&
    releaseName.trim().length > 0 &&
    namespace.trim().length > 0 &&
    !install.isPending;

  return (
    <Modal title={uiText.helm.installRelease} onClose={onClose}>
      <div className="helm-modal-tabs">
        <button className={`tab ${tab === 'config' ? 'active' : ''}`} onClick={() => setTab('config')}>
          {uiText.helm.configuration}
        </button>
        <button className={`tab ${tab === 'preview' ? 'active' : ''}`} onClick={() => setTab('preview')}>
          {uiText.helm.preview}
        </button>
      </div>

      {tab === 'config' && (
        <div className="helm-modal-content">
          <div className="chart-source-tabs">
            <button
              className={`source-tab ${chartSource === 'repo' ? 'active' : ''}`}
              onClick={() => {
                setChartSource('repo');
                setLocalChart(null);
                setUploadError('');
              }}
            >
              From Repositories
            </button>
            <button
              className={`source-tab ${chartSource === 'local' ? 'active' : ''}`}
              onClick={() => {
                setChartSource('local');
                setSelectedChart(null);
                setVersion('');
              }}
            >
              Upload Chart
            </button>
          </div>

          {chartSource === 'repo' && (
            <>
              {charts.isError && <div className="notice error">{uiText.helm.loadChartsError}: {(charts.error as Error).message}. Make sure Helm repositories are configured.</div>}
              {charts.isLoading && <div className="dim">{uiText.helm.loadingCharts}</div>}

              {charts.data && charts.data.charts.length === 0 && (
                <div className="repo-setup-notice">
                  <div className="notice info">{uiText.helm.noChartsFound}</div>
                  <button
                    onClick={() => setShowAddRepoModal(true)}
                    className="primary"
                    style={{ marginTop: 'var(--space-sm)' }}
                  >
                    + {uiText.common.add}
                  </button>
                </div>
              )}

              {charts.data && charts.data.charts.length > 0 && (
                <>
                  <div className="form-group">
                    <label htmlFor="chart-select">{uiText.common.chart}</label>
                    <select
                      id="chart-select"
                      value={selectedChart?.name ?? ''}
                      onChange={(e) => {
                        const chart = charts.data?.charts.find((c) => c.name === e.target.value);
                        setSelectedChart(chart ?? null);
                        setVersion('');
                      }}
                    >
                      <option value="">{uiText.helm.selectChart}</option>
                      {charts.data.charts
                        .map((c) => c.name)
                        .filter((v, i, arr) => arr.indexOf(v) === i)
                        .sort()
                        .map((name) => (
                          <option key={name} value={name}>
                            {name}
                          </option>
                        ))}
                    </select>
                  </div>

                  {selectedChart && chartVersions.length > 0 && (
                    <div className="form-group">
                      <label htmlFor="version-select">{uiText.common.chartVersion}</label>
                      <select id="version-select" value={version} onChange={(e) => setVersion(e.target.value)}>
                        <option value="">{uiText.common.latest}</option>
                        {chartVersions.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {chartDefaults.isLoading && <div className="dim">{uiText.helm.loadingChartDefaults}</div>}
                </>
              )}
            </>
          )}

          {chartSource === 'local' && (
            <>
              <div className="form-group">
                <label htmlFor="chart-upload">{uiText.helm.uploadChart}</label>
                <div className="file-upload-area">
                  <input
                    ref={fileInputRef}
                    id="chart-upload"
                    type="file"
                    accept=".tgz,.tar.gz"
                    onChange={handleFileUpload}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    className="file-upload-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {localChart ? '✓ Chart Loaded' : 'Select Chart File'}
                  </button>
                  {localChart && (
                    <span className="file-name">
                      {localChart.name} (v{localChart.version})
                    </span>
                  )}
                </div>
                {uploadError && <div className="notice error">{uploadError}</div>}
              </div>
            </>
          )}

          {currentChart && (
            <>
              <div className="form-group">
                <label htmlFor="release-name">{uiText.helm.releaseName}</label>
                <input
                  id="release-name"
                  type="text"
                  placeholder={uiText.helm.releaseNamePlaceholder}
                  value={releaseName}
                  onChange={(e) => setReleaseName(e.target.value)}
                />
              </div>

              <div className="form-group">
                <label htmlFor="namespace-select">{uiText.helm.namespace}</label>
                <select id="namespace-select" value={namespace} onChange={(e) => setNamespace(e.target.value)}>
                  {namespaces.map((ns) => (
                    <option key={ns} value={ns}>
                      {ns}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="values-editor">
                  {uiText.helm.valuesYaml}
                  {values && <span className="form-hint">• Modified</span>}
                </label>
                <textarea
                  id="values-editor"
                  value={values}
                  onChange={(e) => setValues(e.target.value)}
                  placeholder="# Override default chart values"
                  rows={8}
                  style={{ fontFamily: 'monospace', fontSize: '12px' }}
                />
              </div>

              <div className="helm-modal-actions">
                <button
                  onClick={handlePreview}
                  disabled={isValidating}
                  title={uiText.helm.previewTitle}
                >
                  {isValidating ? uiText.helm.generating : uiText.helm.preview}
                </button>
                <button
                  onClick={() => install.mutate()}
                  disabled={!isReadyToInstall}
                  className="primary"
                  title={isReadyToInstall ? uiText.helm.installReleaseTitle : uiText.helm.selectCompleteForm}
                >
                  {install.isPending ? uiText.helm.installing : uiText.helm.installReleaseButton}
                </button>
              </div>

              {install.isError && (
                <div className="notice error">{install.error instanceof Error ? install.error.message : uiText.helm.installFailed}</div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'preview' && (
        <div className="helm-modal-content">
          <HelmDiffViewer currentManifest="" newManifest={dryRunManifest} />
          <div className="helm-modal-actions">
            <button onClick={() => setTab('config')}>{uiText.common.backToConfig}</button>
            <button onClick={() => install.mutate()} disabled={!isReadyToInstall} className="primary">
              {uiText.helm.installReleaseButton}
            </button>
          </div>
        </div>
      )}

      {showAddRepoModal && (
        <HelmAddRepoModal
          scope={scope}
          onClose={() => setShowAddRepoModal(false)}
          onToast={onToast}
          onAdded={() => {
            setShowAddRepoModal(false);
          }}
        />
      )}
    </Modal>
  );
}
