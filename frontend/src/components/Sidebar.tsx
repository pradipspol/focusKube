import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { View } from '../App';
import type { Scope } from '../api/client';
import type { KubeContext, LocalKubeconfigSummary } from '../api/types';
import { SidebarProviderSources } from './SidebarProviderSources';

interface Props {
  view?: View;
  activeTabOriginContext?: string;
  activeTabOriginSource?: 'aks' | 'eks' | 'local';
  activeTabOriginKubeconfigId?: string;
  onSelect: (view: View, originContext?: string, originSource?: 'aks' | 'eks' | 'local', originKubeconfigId?: string) => void;
  onPin: (view: View, originContext?: string, originSource?: 'aks' | 'eks' | 'local', originKubeconfigId?: string) => void;
  onOpenExplorer: () => void;
  scope: Scope;
  contexts: KubeContext[];
  localKubeconfigs: LocalKubeconfigSummary[];
  azureSignedIn: boolean;
  azureRefreshToken?: number;
  awsSignedIn: boolean;
  awsRefreshToken?: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onContextChange: (name?: string) => Promise<void> | void;
  onUploadLocalKubeconfig: (name: string, content: string) => Promise<void>;
  onConnectLocalKubeconfig: (id: string, preferredContext?: string) => Promise<void>;
  onDeleteLocalKubeconfig: (id: string) => Promise<void>;
  onDeleteLocalKubeconfigContext: (id: string, contextName: string) => Promise<void>;
  onAzureSignOut: () => Promise<void> | void;
  onOpenCloudAzureView?: () => void;
  onAwsSignOut: () => Promise<void> | void;
  onOpenCloudAwsView?: () => void;
}

type GroupItem = {
  label: string;
  plural?: string;
  view?: View;
  disabled?: boolean;
};

type LocalAzureAuthStatus = 'idle' | 'checking' | 'authenticated' | 'failed';

const LOCAL_AZURE_AUTH_MAX_RETRIES = 5;
const LOCAL_AZURE_AUTH_RETRY_DELAY_MS = 1200;

const GROUPS: { title: string; icon: string; items: GroupItem[] }[] = [
  {
    title: 'Applications',
    icon: '◈',
    items: [{ label: 'Applications', view: { type: 'applications' } }],
  },
  {
    title: 'Observability',
    icon: '◷',
    items: [{ label: 'Observability', view: { type: 'observability' } }],
  },
  {
    title: 'Workloads',
    icon: '◉',
    items: [
      { label: 'Pods', plural: 'pods' },
      { label: 'Deployments', plural: 'deployments' },
      { label: 'StatefulSets', plural: 'statefulsets' },
      { label: 'DaemonSets', plural: 'daemonsets' },
      { label: 'ReplicaSets', plural: 'replicasets' },
      { label: 'Jobs', plural: 'jobs' },
      { label: 'CronJobs', plural: 'cronjobs' },
    ],
  },
  {
    title: 'Helm',
    icon: '⎈',
    items: [
      { label: 'Charts', view: { type: 'helm', mode: 'charts' } },
      { label: 'Releases', view: { type: 'helm', mode: 'releases' } },
    ],
  },
  {
    title: 'Config',
    icon: '⚙',
    items: [
      { label: 'ConfigMaps', plural: 'configmaps' },
      { label: 'Secrets', plural: 'secrets' },
      { label: 'Resource Quotas', plural: 'resourcequotas' },
      { label: 'Limit Ranges', plural: 'limitranges' },
      { label: 'Horizontal Pod Autoscalers', plural: 'horizontalpodautoscalers' },
      { label: 'Pod Disruption Budgets', plural: 'poddisruptionbudgets' },
      { label: 'Leases', plural: 'leases' },
    ],
  },
  {
    title: 'Access Control',
    icon: '🛡',
    items: [
      { label: 'Service Accounts', plural: 'serviceaccounts' },
      { label: 'Roles', plural: 'roles' },
      { label: 'Role Bindings', plural: 'rolebindings' },
    ],
  },
  {
    title: 'Custom Resources',
    icon: '🧩',
    items: [{ label: 'Custom Resource Definitions', plural: 'customresourcedefinitions' }],
  },
  {
    title: 'Security Center',
    icon: '◍',
    items: [
      { label: 'Overview', disabled: true },
      { label: 'Images', disabled: true },
      { label: 'Resources', disabled: true },
      { label: 'Roles', disabled: true },
    ],
  },
  {
    title: 'Network',
    icon: '⇅',
    items: [
      { label: 'Services', plural: 'services' },
      { label: 'Endpoint Slices', plural: 'endpointslices' },
      { label: 'Endpoints', plural: 'endpoints' },
      { label: 'Ingresses', plural: 'ingresses' },
      { label: 'Ingress Classes', plural: 'ingressclasses' },
      { label: 'Network Policies', plural: 'networkpolicies' },
      { label: 'Port Forwarding', view: { type: 'portForwarding' } },
    ],
  },
  {
    title: 'Storage',
    icon: '◍',
    items: [
      { label: 'Persistent Volume Claims', plural: 'persistentvolumeclaims' },
      { label: 'Storage Classes', plural: 'storageclasses' },
    ],
  },
  {
    title: 'Cluster',
    icon: '◎',
    items: [
      { label: 'Namespaces', plural: 'namespaces' },
      { label: 'Events', plural: 'events' },
      { label: 'Nodes', plural: 'nodes' },
    ],
  },
];

export function Sidebar({
  view,
  activeTabOriginContext,
  activeTabOriginSource,
  activeTabOriginKubeconfigId,
  onSelect,
  onPin,
  onOpenExplorer,
  scope,
  contexts,
  localKubeconfigs,
  azureSignedIn,
  azureRefreshToken,
  awsSignedIn,
  awsRefreshToken,
  collapsed,
  onToggleCollapsed,
  onContextChange,
  onUploadLocalKubeconfig,
  onConnectLocalKubeconfig,
  onDeleteLocalKubeconfig,
  onDeleteLocalKubeconfigContext,
  onAzureSignOut,
  onOpenCloudAzureView,
  onAwsSignOut,
  onOpenCloudAwsView,
}: Props) {
  const [explorerRootOpen, setExplorerRootOpen] = useState(true);
  const [menuContextName, setMenuContextName] = useState<string | undefined>();
  const [connectingContextName, setConnectingContextName] = useState<string | undefined>();
  const [localAzureAuthenticated, setLocalAzureAuthenticated] = useState(false);
  const [localAzureAuthStatus, setLocalAzureAuthStatus] = useState<LocalAzureAuthStatus>('idle');
  const [localAzureRetryCount, setLocalAzureRetryCount] = useState(0);
  // const localResourceCheckRef = useRef<Set<string>>(new Set());
  const localAzureAuthPromiseRef = useRef<Promise<boolean> | null>(null);
  const [starredContexts, setStarredContexts] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('k8sExplorer.starredContexts');
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem('k8sExplorer.sidebarGroups');
      const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
      return {
        ...parsed,
        azureRoot: true,
        awsRoot: true,
      };
    } catch {
      return { azureRoot: true, awsRoot: true };
    }
  });

  const openExplorerView = (
    nextView: View,
    originContext = scope.context,
    originSource?: 'aks' | 'eks' | 'local',
    originKubeconfigId?: string,
  ) => {
    onOpenExplorer();
    onSelect(nextView, originContext, originSource, originKubeconfigId);
  };

  const isActive = (groupTitle: string, plural: string) => {
    if (!view) return false;
    if (groupTitle === 'Applications') return view.type === 'applications';
    if (groupTitle === 'Observability') return view.type === 'observability';
    if (view.type === 'portForwarding') return false;
    return view.type === 'resource' && view.plural === plural;
  };

  const checkLocalAzureConnected = async (contextName?: string, openAuthPanelOnFail = true): Promise<boolean> => {
    if (localAzureAuthenticated) return true;
    if (localAzureAuthPromiseRef.current) return localAzureAuthPromiseRef.current;

    const promise = (async () => {
      setLocalAzureAuthStatus('checking');
      setLocalAzureRetryCount(0);

      for (let attempt = 1; attempt <= LOCAL_AZURE_AUTH_MAX_RETRIES; attempt += 1) {
        setLocalAzureRetryCount(attempt);
        try {
          const account = (await api.azureAccount('local')).account;
          if (account) {
            setLocalAzureAuthenticated(true);
            setLocalAzureAuthStatus('authenticated');
            return true;
          }
        } catch {
          // Keep retrying until the configured attempt budget is exhausted.
        }

        if (attempt < LOCAL_AZURE_AUTH_MAX_RETRIES) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, LOCAL_AZURE_AUTH_RETRY_DELAY_MS));
        }
      }

      setLocalAzureAuthenticated(false);
      setLocalAzureAuthStatus('failed');

      if (openAuthPanelOnFail) {
        // Do not activate the context before auth succeeds; this can trigger
        // repeated /contexts/active failures in desktop mode.
        openExplorerView({ type: 'azure' }, contextName, 'local');
      }

      return false;
    })().finally(() => {
      localAzureAuthPromiseRef.current = null;
    });

    localAzureAuthPromiseRef.current = promise;
    return promise;
  };

  const ensureLocalAzureConnected = async (contextName?: string): Promise<boolean> => {
    return checkLocalAzureConnected(contextName, true);
  };

  useEffect(() => {
    if (localKubeconfigs.length === 0) {
      setLocalAzureAuthenticated(false);
      setLocalAzureAuthStatus('idle');
      setLocalAzureRetryCount(0);
      return;
    }

    if (localAzureAuthenticated || localAzureAuthStatus !== 'idle') return;

    const preferredContext = localKubeconfigs[0]?.contexts[0];
    void checkLocalAzureConnected(preferredContext, true);
  }, [checkLocalAzureConnected, localAzureAuthenticated, localAzureAuthStatus, localKubeconfigs]);

  useEffect(() => {
    if (!azureRefreshToken || localAzureAuthenticated || localKubeconfigs.length === 0) return;
    const preferredContext = localKubeconfigs[0]?.contexts[0];
    void checkLocalAzureConnected(preferredContext, false);
  }, [azureRefreshToken, checkLocalAzureConnected, localAzureAuthenticated, localKubeconfigs]);

  // useEffect(() => {
  //   if (localKubeconfigs.length === 0) {
  //     setLocalAzureAuthenticated(false);
  //     setLocalAzureAuthStatus('idle');
  //     setLocalAzureRetryCount(0);
  //     return;
  //   }
  //   if (localAzureAuthenticated || localAzureAuthStatus !== 'idle') return;

  //   const preferredContext = localKubeconfigs[0]?.contexts[0];
  //   void checkLocalAzureConnected(preferredContext, true);
  // }, [localAzureAuthenticated, localAzureAuthStatus, localKubeconfigs]);

  // useEffect(() => {
  //   if (!azureRefreshToken || localAzureAuthenticated || localKubeconfigs.length === 0) return;
  //   const preferredContext = localKubeconfigs[0]?.contexts[0];
  //   void checkLocalAzureConnected(preferredContext, false);
  // }, [azureRefreshToken, localAzureAuthenticated, localKubeconfigs]);

  // useEffect(() => {
  //   const contextName = scope.context;
  //   if (!contextName) return;

  //   const activeContext = contexts.find((ctx) => ctx.name === contextName);
  //   if (activeContext?.source?.provider !== 'local') return;

  //   const isResourcePage =
  //     view?.type === 'resource' ||
  //     view?.type === 'applications' ||
  //     view?.type === 'helm' ||
  //     view?.type === 'portForwarding';
  //   if (!isResourcePage) return;
  //   if (localResourceCheckRef.current.has(contextName)) return;

  //   localResourceCheckRef.current.add(contextName);
  //   void ensureLocalAzureConnected(contextName);
  // }, [contexts, scope.context, view?.type]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.sidebarGroups', JSON.stringify(collapsedGroups));
  }, [collapsedGroups]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.starredContexts', JSON.stringify(starredContexts));
  }, [starredContexts]);

  useEffect(() => {
    if (!menuContextName) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.action-menu') || target.closest('.action-trigger')) return;
      setMenuContextName(undefined);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuContextName]);

  const orderedContexts = useMemo(() => contexts, [contexts]);
  const starredContextList = useMemo(
    () => orderedContexts.filter((ctx) => starredContexts[ctx.name]),
    [orderedContexts, starredContexts],
  );
  const selectedContextName = activeTabOriginContext ?? scope.context;
  const activeResourcePlural = view?.type === 'resource' ? view.plural : undefined;

  const computeCollapsed = useCallback((key: string, map: Record<string, boolean>) => {
    const explicit = map[key];
    if (typeof explicit === 'boolean') return explicit;

    if (
      key === 'azureRoot' ||
      key === 'awsRoot' ||
      key.startsWith('azure-account:') ||
      key.startsWith('azure-sub:') ||
      key.startsWith('aws-region:') ||
      key.startsWith('aws-cluster:') ||
      key.includes(':rg:') ||
      key.includes(':cluster:') ||
      key.startsWith('aks-context:') ||
      key.startsWith('eks-context:') ||
      key.startsWith('localkube:')
    ) {
      return true;
    }

    return false;
  }, []);

  const isGroupCollapsed = useCallback((key: string) => computeCollapsed(key, collapsedGroups), [collapsedGroups, computeCollapsed]);
  const toggleGroup = useCallback(
    (key: string) => setCollapsedGroups((current) => ({ ...current, [key]: !computeCollapsed(key, current) })),
    [computeCollapsed],
  );
  const expandGroup = useCallback(
    (key: string) =>
      setCollapsedGroups((current) => {
        if (current[key] === false) return current;
        return { ...current, [key]: false };
      }),
    [],
  );

  const toggleStar = (contextName: string) => {
    setStarredContexts((current) => ({
      ...current,
      [contextName]: !current[contextName],
    }));
  };

  const renderSectionGroups = (contextName: string, originSource?: 'aks' | 'eks' | 'local', originKubeconfigId?: string) => (
    <div className="context-sections">
      {GROUPS.map((group) => {
        const consumedActivePlurals = new Set<string>();

        return (
          <div key={`${contextName}-${group.title}`} className="k8sexplorer-group nested-group">
            {!collapsed && (
              <button className="k8sexplorer-title k8sexplorer-toggle section-toggle" onClick={() => toggleGroup(`${contextName}:${group.title}`)}>
                <span>{isGroupCollapsed(`${contextName}:${group.title}`) ? '▸' : '▾'}</span>
                <span className="k8sexplorer-title-icon" aria-hidden="true">{group.icon}</span>
                <span>{group.title}</span>
              </button>
            )}
            {(collapsed || !isGroupCollapsed(`${contextName}:${group.title}`)) && (
              <div className="k8sexplorer-items nested-items">
                {group.items.map((item) => {
                  const isContextMatched = activeTabOriginContext === contextName && activeTabOriginKubeconfigId === originKubeconfigId;
                  const itemActive = item.view
                    ? isContextMatched &&
                      !!view &&
                      view.type === item.view.type &&
                      (item.view.type !== 'resource' || (view.type === 'resource' && view.plural === item.view.plural)) &&
                      (item.view.type !== 'helm' || (view.type === 'helm' && view.mode === item.view.mode))
                    : isContextMatched && !!item.plural && !consumedActivePlurals.has(item.plural) && isActive(group.title, item.plural);

                  if (itemActive && item.plural) {
                    consumedActivePlurals.add(item.plural);
                  }

                  return (
                    <div
                      key={`${group.title}:${item.label}`}
                      className={`nav-item ${itemActive ? 'active' : ''} ${item.disabled ? 'disabled' : ''}`}
                      onClick={() => {
                        if (item.disabled) return;
                        onOpenExplorer();
                        onContextChange(contextName);
                        if (item.view) {
                          openExplorerView(item.view, contextName, originSource ?? 'aks', originKubeconfigId);
                          return;
                        }
                        if (item.plural) {
                          openExplorerView({ type: 'resource', plural: item.plural, focusContext: contextName, focusName: undefined }, contextName, originSource ?? 'aks', originKubeconfigId);
                        } else {
                          openExplorerView({ type: 'applications' }, contextName, originSource ?? 'aks', originKubeconfigId);
                        }
                      }}
                      onDoubleClick={() => {
                        if (item.disabled) return;
                        const nextView: View = item.view ?? (item.plural
                          ? { type: 'resource', plural: item.plural, focusContext: contextName }
                          : { type: 'applications' });
                        onPin(nextView, contextName, originSource ?? 'aks', originKubeconfigId);
                      }}
                      title={item.label}
                    >
                      <span>{collapsed ? item.label.charAt(0) : item.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const renderContextNode = (
    ctx: KubeContext,
    nodeKeyPrefix: string,
    labelOverride?: string,
    options?: { onRemove?: () => void },
    originSource?: 'aks' | 'eks' | 'local',
    originKubeconfigId?: string,
  ) => {
    const isSelectedContext = selectedContextName === ctx.name;
    const contextExpanded = !isGroupCollapsed(`${nodeKeyPrefix}:${ctx.name}`);
    const isStarred = !!starredContexts[ctx.name];
    const isLocalContextNode = (originSource ?? ctx.source?.provider) === 'local';
    const canExpandLocalContextNode = !isLocalContextNode || localAzureAuthenticated;

    return (
      <div key={`${nodeKeyPrefix}:${ctx.name}`} className="context-root">
        <div
          className={`nav-item context-item ${isSelectedContext ? 'active' : ''}`}
          onClick={async () => {
            onOpenExplorer();
            if (isLocalContextNode) {
              const ok = await ensureLocalAzureConnected(ctx.name);
              if (!ok) return;
            }
            setConnectingContextName(ctx.name);
            try {
              await Promise.resolve(onContextChange(ctx.name));
              await new Promise(resolve => setTimeout(resolve, 300));
            } finally {
              setConnectingContextName(undefined);
            }
            expandGroup(`${nodeKeyPrefix}:${ctx.name}`);
            setMenuContextName(undefined);
          }}
          title={ctx.name}
        >
          <span className="context-label-wrap">
            {!collapsed && (
              <button
                className="context-caret-button"
                title={contextExpanded ? `Collapse ${ctx.name}` : `Expand ${ctx.name}`}
                onClick={async (event) => {
                  event.stopPropagation();
                  const key = `${nodeKeyPrefix}:${ctx.name}`;
                  const willExpand = isGroupCollapsed(key);
                  if (willExpand && isLocalContextNode) {
                    const ok = await ensureLocalAzureConnected(ctx.name);
                    if (!ok) return;
                  }
                  toggleGroup(`${nodeKeyPrefix}:${ctx.name}`);
                }}
              >
                <span className="context-caret">{contextExpanded ? '▾' : '▸'}</span>
              </button>
            )}
            <span>{collapsed ? (labelOverride ?? ctx.name).charAt(0) : (labelOverride ?? ctx.name)}</span>
            {!collapsed && labelOverride && labelOverride !== ctx.name && (
              <span className="context-secondary-label">({ctx.name})</span>
            )}
          </span>
          <span className="context-meta">
            {connectingContextName === ctx.name ? (
              <span className="tiny-spinner" aria-label="connecting" />
            ) : (
              <span
                className={`context-status-dot ${isSelectedContext ? 'connected' : 'disconnected'}`}
                title={isSelectedContext ? 'Connected' : 'Disconnected'}
              />
            )}
            {!collapsed && (
              <div className="action-trigger-wrap">
                <button
                  className="action-trigger sidebar-action-trigger"
                  title={`Actions for ${ctx.name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenuContextName((current) => (current === ctx.name ? undefined : ctx.name));
                  }}
                >
                  ⋮
                </button>
                {menuContextName === ctx.name && (
                  <div className="action-menu sidebar-action-menu">
                    <button
                      className="action-menu-item"
                      onClick={async (event) => {
                        event.stopPropagation();
                        setMenuContextName(undefined);
                        if (isSelectedContext) {
                          setConnectingContextName(ctx.name);
                          try {
                            await Promise.resolve(onContextChange(undefined));
                            await new Promise(resolve => setTimeout(resolve, 300));
                          } finally {
                            setConnectingContextName(undefined);
                          }
                          return;
                        }
                        if (isLocalContextNode) {
                          const ok = await ensureLocalAzureConnected(ctx.name);
                          if (!ok) return;
                        }
                        setConnectingContextName(ctx.name);
                        try {
                          await Promise.resolve(onContextChange(ctx.name));
                          await new Promise(resolve => setTimeout(resolve, 300));
                        } finally {
                          setConnectingContextName(undefined);
                        }
                        expandGroup(`${nodeKeyPrefix}:${ctx.name}`);
                      }}
                    >
                      {isSelectedContext ? 'Disconnect' : 'Connect'}
                    </button>
                    {/* <button
                      className="action-menu-item"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenuContextName(undefined);
                        toggleStar(ctx.name);
                      }}
                    >
                      {isStarred ? 'Unstar' : 'Star'}
                    </button> */}
                    {options?.onRemove && (
                      <button
                        className="action-menu-item danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuContextName(undefined);
                          options.onRemove?.();
                        }}
                      >
                        Remove context
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </span>
        </div>
        {!collapsed && contextExpanded && canExpandLocalContextNode && renderSectionGroups(ctx.name, originSource ?? ctx.source?.provider, originKubeconfigId)}
      </div>
    );
  };

  return (
    <div className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-root-tree">
        <div className="k8sexplorer-group root-group">
          <div className="sidebar-header-row root-header">
            <button
              className="root-toggle route-link active"
              type="button"
              onClick={() => {
                setExplorerRootOpen((current) => !current);
                onOpenExplorer();
              }}
            >
              <span>{explorerRootOpen ? '▾' : '▸'}</span>
              <span>K8S Cluster</span>
            </button>
          </div>

          {(collapsed || explorerRootOpen) && !collapsed && (
            <>
              <div className="k8sexplorer-group">
                <button className="k8sexplorer-title k8sexplorer-toggle" onClick={() => toggleGroup('contextsRoot')}>
                  <span>{isGroupCollapsed('contextsRoot') ? '▸' : '▾'}</span>
                  <span>STARRED CONTEXTS</span>
                </button>
                <div className="k8sexplorer-items">
                  {(collapsed || !isGroupCollapsed('contextsRoot')) && (
                    <>
                      {!collapsed && starredContextList.length === 0 && (
                        <div className="sidebar-hint">No starred contexts yet.</div>
                      )}
                      {starredContextList.map((ctx) => renderContextNode(ctx, 'starred', undefined, undefined, ctx.source?.provider))}
                    </>
                  )}
                </div>
              </div>

              <SidebarProviderSources
                collapsed={collapsed}
                scope={scope}
                view={view}
                activeTabOriginSource={activeTabOriginSource}
                orderedContexts={orderedContexts}
                localKubeconfigs={localKubeconfigs}
                azureSignedIn={azureSignedIn}
                azureRefreshToken={azureRefreshToken}
                localAzureAuthenticated={localAzureAuthenticated}
                localAzureAuthStatus={localAzureAuthStatus}
                localAzureRetryCount={localAzureRetryCount}
                localAzureMaxRetries={LOCAL_AZURE_AUTH_MAX_RETRIES}
                isGroupCollapsed={isGroupCollapsed}
                toggleGroup={toggleGroup}
                expandGroup={expandGroup}
                ensureLocalAzureConnected={ensureLocalAzureConnected}
                renderContextNode={renderContextNode}
                onPin={onPin}
                onContextChange={onContextChange}
                onUploadLocalKubeconfig={onUploadLocalKubeconfig}
                onConnectLocalKubeconfig={onConnectLocalKubeconfig}
                onDeleteLocalKubeconfig={onDeleteLocalKubeconfig}
                onDeleteLocalKubeconfigContext={onDeleteLocalKubeconfigContext}
                onAzureSignOut={onAzureSignOut}
                onOpenCloudAzureView={onOpenCloudAzureView}
                awsSignedIn={awsSignedIn}
                awsRefreshToken={awsRefreshToken}
                onAwsSignOut={onAwsSignOut}
                onOpenCloudAwsView={onOpenCloudAwsView}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
