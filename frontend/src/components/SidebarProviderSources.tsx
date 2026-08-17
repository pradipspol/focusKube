import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { View } from '../App';
import type { Scope } from '../api/client';
import type { AksCluster, AwsIdentity, EksCluster, KubeContext, LocalKubeconfigSummary } from '../api/types';

const CLOUD_ACCOUNT_MAX_RETRIES = 5;
const CLOUD_ACCOUNT_RETRY_DELAY_MS = 1200;

type LiveAksResourceGroupNode = {
  name: string;
  clusters: AksCluster[];
};

type LiveAksSubscriptionNode = {
  id: string;
  name: string;
  resourceGroups: LiveAksResourceGroupNode[];
};

type LiveAksAccountNode = {
  email: string;
  userType?: string;
  subscriptions: LiveAksSubscriptionNode[];
};

type LiveEksRegionNode = {
  name: string;
  clusters: EksCluster[];
};

type LiveEksAccountNode = {
  accountId: string;
  arn: string;
  regions: LiveEksRegionNode[];
};

type ClusterRef = {
  subscriptionId: string;
  subscriptionName: string;
  resourceGroup: string;
  clusterName: string;
};

type RenderContextNodeOptions = {
  onRemove?: () => void;
};

interface Props {
  collapsed: boolean;
  scope: Scope;
  view?: View;
  activeTabOriginSource?: 'aks' | 'eks' | 'local';
  orderedContexts: KubeContext[];
  localKubeconfigs: LocalKubeconfigSummary[];
  azureSignedIn: boolean;
  azureRefreshToken?: number;
  localAzureAuthenticated: boolean;
  localAzureAuthStatus?: 'idle' | 'checking' | 'authenticated' | 'failed';
  localAzureRetryCount?: number;
  localAzureMaxRetries?: number;
  isGroupCollapsed: (key: string) => boolean;
  toggleGroup: (key: string) => void;
  expandGroup: (key: string) => void;
  ensureLocalAzureConnected: (contextName?: string) => Promise<boolean>;
  renderContextNode: (
    ctx: KubeContext,
    nodeKeyPrefix: string,
    labelOverride?: string,
    options?: RenderContextNodeOptions,
    originSource?: 'aks' | 'eks' | 'local',
    originKubeconfigId?: string,
  ) => React.ReactNode;
  onContextChange: (name?: string) => Promise<void> | void;
  onUploadLocalKubeconfig: (name: string, content: string) => Promise<void>;
  onConnectLocalKubeconfig: (id: string, preferredContext?: string) => Promise<void>;
  onDeleteLocalKubeconfig: (id: string) => Promise<void>;
  onDeleteLocalKubeconfigContext: (id: string, contextName: string) => Promise<void>;
  onAzureSignOut: () => Promise<void> | void;
  onOpenCloudAzureView?: () => void;
  awsSignedIn: boolean;
  awsRefreshToken?: number;
  onAwsSignOut: () => Promise<void> | void;
  onOpenCloudAwsView?: () => void;
}

export function SidebarProviderSources({
  collapsed,
  scope,
  view,
  activeTabOriginSource,
  orderedContexts,
  localKubeconfigs,
  azureSignedIn,
  azureRefreshToken,
  localAzureAuthenticated,
  localAzureAuthStatus = 'idle',
  localAzureRetryCount = 0,
  localAzureMaxRetries = 5,
  isGroupCollapsed,
  toggleGroup,
  expandGroup,
  ensureLocalAzureConnected,
  renderContextNode,
  onContextChange,
  onUploadLocalKubeconfig,
  onConnectLocalKubeconfig,
  onDeleteLocalKubeconfig,
  onDeleteLocalKubeconfigContext,
  onAzureSignOut,
  onOpenCloudAzureView,
  awsSignedIn,
  awsRefreshToken,
  onAwsSignOut,
  onOpenCloudAwsView,
}: Props) {
  const queryClient = useQueryClient();
  const [menuLocalKubeconfigId, setMenuLocalKubeconfigId] = useState<string | undefined>();
  const [menuLocalContextKey, setMenuLocalContextKey] = useState<string | undefined>();
  const [uploadBusy, setUploadBusy] = useState(false);
  const [azureAccounts, setAzureAccounts] = useState<LiveAksAccountNode[]>([]);
  const [subscriptionClusterCache, setSubscriptionClusterCache] = useState<Record<string, AksCluster[]>>({});
  const [resourceGroupClusters, setResourceGroupClusters] = useState<Record<string, AksCluster[]>>({});
  const [loadingSubscriptions, setLoadingSubscriptions] = useState(false);
  const [loadingResourceGroups, setLoadingResourceGroups] = useState<Record<string, boolean>>({});
  const [loadingClusters, setLoadingClusters] = useState<Record<string, boolean>>({});
  const [loadingImportedContexts, setLoadingImportedContexts] = useState<Record<string, boolean>>({});
  const [aksError, setAksError] = useState<string | null>(null);
  const [azureHeaderMenuOpen, setAzureHeaderMenuOpen] = useState(false);
  const [azureAccountMenuEmail, setAzureAccountMenuEmail] = useState<string | undefined>();
  const [awsHeaderMenuOpen, setAwsHeaderMenuOpen] = useState(false);
  const [awsAccountNode, setAwsAccountNode] = useState<LiveEksAccountNode | null>(null);
  const [azureProbeAttempts, setAzureProbeAttempts] = useState(0);
  const [awsProbeAttempts, setAwsProbeAttempts] = useState(0);
  const [azureProbeRequested, setAzureProbeRequested] = useState(false);
  const [awsProbeRequested, setAwsProbeRequested] = useState(false);
  const [loadingAwsTree, setLoadingAwsTree] = useState(false);
  const [loadingAwsImportedContexts, setLoadingAwsImportedContexts] = useState<Record<string, boolean>>({});
  const [awsError, setAwsError] = useState<string | null>(null);
  const [azureBusyEmail, setAzureBusyEmail] = useState<string | undefined>();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const localAzureAuthInProgress = !localAzureAuthenticated && localAzureAuthStatus === 'checking';
  const localAzureAuthFailed = !localAzureAuthenticated && localAzureAuthStatus === 'failed';
  const hasAzureCloudAccount = azureSignedIn || azureAccounts.length > 0;
  const hasAwsCloudAccount = awsSignedIn || !!awsAccountNode;

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const fetchAccounts = async () => {
    setLoadingSubscriptions(true);
    setAksError(null);
    try {
      setAzureAccounts((current) => current);
      const accounts = (await api.azureAccounts('cloud')).accounts.map((account) => ({
        email: account.email,
        userType: account.userType,
        subscriptions: account.subscriptions
          .map((s) => ({ id: s.id, name: s.name, resourceGroups: [] as LiveAksResourceGroupNode[] }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }));
      setAzureAccounts(accounts);
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to load Azure accounts');
    } finally {
      setLoadingSubscriptions(false);
    }
  };

  const fetchResourceGroupsForSubscription = async (subscriptionId: string, force = false) => {
    if (!force && subscriptionClusterCache[subscriptionId]) return;
    setLoadingResourceGroups((current) => ({ ...current, [subscriptionId]: true }));
    setAksError(null);
    try {
      const clusters = (await api.azureAks(subscriptionId, 'cloud')).clusters;
      setSubscriptionClusterCache((current) => ({ ...current, [subscriptionId]: clusters }));

      const grouped = new Map<string, AksCluster[]>();
      for (const cluster of clusters) {
        const list = grouped.get(cluster.resourceGroup) ?? [];
        list.push(cluster);
        grouped.set(cluster.resourceGroup, list);
      }

      const resourceGroups = Array.from(grouped.entries())
        .map(([name, rgClusters]) => ({
          name,
          clusters: [...rgClusters].sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setAzureAccounts((current) =>
        current.map((account) => ({
          ...account,
          subscriptions: account.subscriptions.map((sub) =>
            sub.id === subscriptionId ? { ...sub, resourceGroups } : sub,
          ),
        })),
      );
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to load resource groups');
    } finally {
      setLoadingResourceGroups((current) => ({ ...current, [subscriptionId]: false }));
    }
  };

  const fetchClustersForResourceGroup = async (clusterRef: Pick<ClusterRef, 'subscriptionId' | 'resourceGroup'>) => {
    const key = `${clusterRef.subscriptionId}:${clusterRef.resourceGroup}`;
    if (resourceGroupClusters[key]) return;
    setLoadingClusters((current) => ({ ...current, [key]: true }));
    setAksError(null);
    try {
      const clusters = (await api.azureAks(clusterRef.subscriptionId, 'cloud')).clusters
        .filter((cluster) => cluster.resourceGroup === clusterRef.resourceGroup)
        .sort((a, b) => a.name.localeCompare(b.name));
      setResourceGroupClusters((current) => ({ ...current, [key]: clusters }));
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to load clusters');
    } finally {
      setLoadingClusters((current) => ({ ...current, [key]: false }));
    }
  };

  const matchContextsForCluster = (
    allContexts: KubeContext[],
    subscriptionId: string,
    subscriptionName: string,
    clusterName: string,
  ) =>
    allContexts.filter((ctx) => {
      if (ctx.source?.provider === 'aks' && ctx.source.clusterName) {
        return (
          ctx.source.clusterName === clusterName &&
          (ctx.source.subscriptionId === subscriptionId || ctx.source.subscriptionName === subscriptionName)
        );
      }
      return false;
    });

  const matchContextsForEksCluster = (
    allContexts: KubeContext[],
    accountId: string,
    region: string,
    clusterName: string,
  ) =>
    allContexts.filter((ctx) => {
      if (ctx.source?.provider !== 'eks' || !ctx.source.clusterName) return false;
      const accountMatches = !ctx.source.accountId || ctx.source.accountId === accountId;
      return ctx.source.clusterName === clusterName && ctx.source.region === region && accountMatches;
    });

  const fetchAwsTree = async () => {
    setLoadingAwsTree(true);
    setAwsError(null);
    try {
      const identity = (await api.awsAccount()).account as AwsIdentity | null;
      if (!identity) {
        setAwsAccountNode(null);
        return;
      }

      const eksResult = await api.awsEks();
      const clusters = eksResult.clusters;
      if (eksResult.error) setAwsError(eksResult.error);
      const grouped = new Map<string, EksCluster[]>();
      for (const cluster of clusters) {
        const list = grouped.get(cluster.region) ?? [];
        list.push(cluster);
        grouped.set(cluster.region, list);
      }

      const regions = Array.from(grouped.entries())
        .map(([name, regionClusters]) => ({
          name,
          clusters: [...regionClusters].sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setAwsAccountNode({
        accountId: identity.account,
        arn: identity.arn,
        regions,
      });
    } catch (err) {
      setAwsError(err instanceof Error ? err.message : 'Failed to load AWS EKS clusters');
    } finally {
      setLoadingAwsTree(false);
    }
  };

  const probeAzureCloudAccounts = async () => {
    setAzureProbeRequested(true);
    setAzureProbeAttempts(0);
    setLoadingSubscriptions(true);
    setAksError(null);

    for (let attempt = 1; attempt <= CLOUD_ACCOUNT_MAX_RETRIES; attempt += 1) {
      setAzureProbeAttempts(attempt);
      try {
        const accounts = (await api.azureAccounts('cloud')).accounts.map((account) => ({
          email: account.email,
          userType: account.userType,
          subscriptions: account.subscriptions
            .map((s) => ({ id: s.id, name: s.name, resourceGroups: [] as LiveAksResourceGroupNode[] }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }));

        if (accounts.length > 0) {
          setAzureAccounts(accounts);
          setLoadingSubscriptions(false);
          setAksError(null);
          return true;
        }
      } catch {
        // Keep retrying until the attempt budget is exhausted.
      }

      if (attempt < CLOUD_ACCOUNT_MAX_RETRIES) {
        await sleep(CLOUD_ACCOUNT_RETRY_DELAY_MS);
      }
    }

    setAzureAccounts([]);
    setLoadingSubscriptions(false);
    setAksError('No Azure account detected. Please sign in to Azure.');
    onOpenCloudAzureView?.();
    return false;
  };

  const probeAwsCloudAccounts = async () => {
    setAwsProbeRequested(true);
    setAwsProbeAttempts(0);
    setLoadingAwsTree(true);
    setAwsError(null);

    for (let attempt = 1; attempt <= CLOUD_ACCOUNT_MAX_RETRIES; attempt += 1) {
      setAwsProbeAttempts(attempt);
      try {
        const identity = (await api.awsAccount()).account as AwsIdentity | null;
        if (identity) {
          const eksResult = await api.awsEks();
          const clusters = eksResult.clusters;
          if (eksResult.error) setAwsError(eksResult.error);

          const grouped = new Map<string, EksCluster[]>();
          for (const cluster of clusters) {
            const list = grouped.get(cluster.region) ?? [];
            list.push(cluster);
            grouped.set(cluster.region, list);
          }

          const regions = Array.from(grouped.entries())
            .map(([name, regionClusters]) => ({
              name,
              clusters: [...regionClusters].sort((a, b) => a.name.localeCompare(b.name)),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

          setAwsAccountNode({
            accountId: identity.account,
            arn: identity.arn,
            regions,
          });
          setLoadingAwsTree(false);
          return true;
        }
      } catch {
        // Keep retrying until the attempt budget is exhausted.
      }

      if (attempt < CLOUD_ACCOUNT_MAX_RETRIES) {
        await sleep(CLOUD_ACCOUNT_RETRY_DELAY_MS);
      }
    }

    setAwsAccountNode(null);
    setLoadingAwsTree(false);
    setAwsError('No AWS account detected. Please sign in to AWS.');
    onOpenCloudAwsView?.();
    return false;
  };

  useEffect(() => {
    if (hasAzureCloudAccount) return;
    setAzureAccounts([]);
    setSubscriptionClusterCache({});
    setResourceGroupClusters({});
    if (!azureProbeRequested) {
      setAksError(null);
    }
  }, [hasAzureCloudAccount, azureProbeRequested]);

  useEffect(() => {
    if (!azureRefreshToken || !azureProbeRequested) return;
    expandGroup('aksRoot');
    void probeAzureCloudAccounts();
  }, [azureRefreshToken, azureProbeRequested, expandGroup]);

  useEffect(() => {
    if (hasAwsCloudAccount) return;
    setAwsAccountNode(null);
    if (!awsProbeRequested) {
      setAwsError(null);
    }
  }, [hasAwsCloudAccount, awsProbeRequested]);

  useEffect(() => {
    if (!awsRefreshToken || !awsProbeRequested) return;
    expandGroup('awsRoot');
    void probeAwsCloudAccounts();
  }, [awsRefreshToken, awsProbeRequested, expandGroup]);

  useEffect(() => {
    if (!menuLocalKubeconfigId && !menuLocalContextKey && !azureHeaderMenuOpen && !azureAccountMenuEmail && !awsHeaderMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.action-menu') || target.closest('.action-trigger')) return;
      setMenuLocalKubeconfigId(undefined);
      setMenuLocalContextKey(undefined);
      setAzureHeaderMenuOpen(false);
      setAzureAccountMenuEmail(undefined);
      setAwsHeaderMenuOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuLocalKubeconfigId, menuLocalContextKey, azureHeaderMenuOpen, azureAccountMenuEmail, awsHeaderMenuOpen]);

  const refreshAzureTree = () => {
    setAzureAccounts([]);
    setSubscriptionClusterCache({});
    setResourceGroupClusters({});
    void probeAzureCloudAccounts();
  };

  const refreshAwsTree = () => {
    setAwsAccountNode(null);
    void probeAwsCloudAccounts();
  };

  const handleDisconnectAzureAccount = async (email: string) => {
    if (
      !window.confirm(
        `Disconnect imported AKS clusters for ${email}? The account stays signed in, but its imported cluster contexts will be removed.`,
      )
    ) {
      return;
    }
    setAzureAccountMenuEmail(undefined);
    setAzureBusyEmail(email);
    setAksError(null);
    try {
      await api.azureDisconnectAccount(email);
      const updated = await api.reloadContexts();
      queryClient.setQueryData(['contexts'], updated);
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to sign out account');
    } finally {
      setAzureBusyEmail(undefined);
    }
  };

  const handleUploadFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setUploadBusy(true);
      const content = await file.text();
      const fallbackName = file.name.replace(/\.(yaml|yml)$/i, '').trim();
      const name = fallbackName || `kubeconfig-${Date.now()}`;
      await onUploadLocalKubeconfig(name, content);
      expandGroup('localKubeconfigsRoot');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to upload kubeconfig:', err);
    } finally {
      setUploadBusy(false);
      event.target.value = '';
    }
  };

  return (
    <>
      <div className="k8sexplorer-group">
        <div className="aks-header-row">
          <button
            className="k8sexplorer-title k8sexplorer-toggle"
            onClick={() => {
              const nextExpanded = isGroupCollapsed('azureRoot');
              toggleGroup('azureRoot');
              if (nextExpanded) {
                void probeAzureCloudAccounts();
              }
            }}
          >
            <span>{isGroupCollapsed('azureRoot') ? '▸' : '▾'}</span>
            <span>Azure / AKS</span>
            {loadingSubscriptions && <span className="tiny-spinner" aria-label="loading Azure accounts" />}
          </button>
          <div className="action-trigger-wrap">
            <button
              className="aks-auth-button action-trigger"
              title="Azure connections"
              aria-label="Azure connections"
              onClick={(event) => {
                event.stopPropagation();
                setAzureHeaderMenuOpen((open) => !open);
                setAzureAccountMenuEmail(undefined);
              }}
            >
              {hasAzureCloudAccount ? '⋮' : '+'}
            </button>
            {azureHeaderMenuOpen && (
              <div className="action-menu sidebar-action-menu">
                <button
                  className="action-menu-item"
                  onClick={() => {
                    setAzureHeaderMenuOpen(false);
                    onOpenCloudAzureView?.();
                  }}
                >
                  Add Azure connection
                </button>
                {hasAzureCloudAccount && (
                  <button
                    className="action-menu-item"
                    onClick={() => {
                      setAzureHeaderMenuOpen(false);
                      onOpenCloudAzureView?.();
                    }}
                  >
                    Reconnect Azure
                  </button>
                )}
                {hasAzureCloudAccount && (
                  <button
                    className="action-menu-item"
                    onClick={() => {
                      setAzureHeaderMenuOpen(false);
                      refreshAzureTree();
                    }}
                  >
                    Refresh
                  </button>
                )}
                {hasAzureCloudAccount && (
                  <button
                    className="action-menu-item danger"
                    onClick={() => {
                      setAzureHeaderMenuOpen(false);
                      Promise.resolve(onAzureSignOut())
                        .then(() => fetchAccounts())
                        .catch(() => {
                          /* handled in state */
                        });
                    }}
                  >
                    Sign Out All
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {(collapsed || !isGroupCollapsed('azureRoot')) && (
          <div className="k8sexplorer-items">
            {azureProbeRequested && loadingSubscriptions && !collapsed && (
              <div className="sidebar-hint">
                Checking Azure account ({azureProbeAttempts}/{CLOUD_ACCOUNT_MAX_RETRIES})...
              </div>
            )}
            {hasAzureCloudAccount && loadingSubscriptions && !collapsed && (
              <div className="sidebar-hint">Loading Azure accounts...</div>
            )}
            {hasAzureCloudAccount && aksError && !collapsed && <div className="sidebar-hint">{aksError}</div>}
            {!hasAzureCloudAccount && !aksError && !loadingSubscriptions && !collapsed && (
              <div className="sidebar-hint">Click Azure / AKS to check cloud account.</div>
            )}
            {!hasAzureCloudAccount && aksError && !collapsed && <div className="sidebar-hint">{aksError}</div>}
            {hasAzureCloudAccount &&
              azureAccounts.map((accountNode) => {
                const accountKey = `azure-account:${accountNode.email}`;
                const accountExpanded = !isGroupCollapsed(accountKey);
                const accountMenuOpen = azureAccountMenuEmail === accountNode.email;
                const accountBusy = azureBusyEmail === accountNode.email;
                return (
                  <div key={accountKey} className="context-root">
                    {!collapsed && (
                      <div className="aks-account-row">
                        <button
                          className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle aks-account-toggle"
                          onClick={() => toggleGroup(accountKey)}
                          title={accountNode.email}
                        >
                          <span>{accountExpanded ? '▾' : '▸'}</span>
                          <span className="aks-account-email">{accountNode.email}</span>
                          {accountBusy && <span className="tiny-spinner" aria-label="working" />}
                        </button>
                        <div className="action-trigger-wrap">
                          <button
                            className="aks-auth-button action-trigger"
                            title={`Actions for ${accountNode.email}`}
                            aria-label={`Actions for ${accountNode.email}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setAzureAccountMenuEmail(accountMenuOpen ? undefined : accountNode.email);
                              setAzureHeaderMenuOpen(false);
                            }}
                          >
                            ⋮
                          </button>
                          {accountMenuOpen && (
                            <div className="action-menu sidebar-action-menu">
                              <button
                                className="action-menu-item"
                                onClick={() => {
                                  setAzureAccountMenuEmail(undefined);
                                  onOpenCloudAzureView?.();
                                }}
                              >
                                Reconnect
                              </button>
                              <button
                                className="action-menu-item"
                                onClick={() => handleDisconnectAzureAccount(accountNode.email)}
                              >
                                Disconnect clusters
                              </button>
                              <button
                                className="action-menu-item danger"
                                onClick={() => handleDisconnectAzureAccount(accountNode.email)}
                              >
                                Sign out
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {(collapsed || accountExpanded) && (
                      <div className="aks-tree-children">
                        {accountNode.subscriptions.map((subscriptionNode) => {
                          const subKey = `azure-sub:${subscriptionNode.id}`;
                          const subExpanded = !isGroupCollapsed(subKey);
                          return (
                            <div key={subKey} className="context-root">
                              {!collapsed && (
                                <button
                                  className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                                  onClick={() => {
                                    const nextExpanded = isGroupCollapsed(subKey);
                                    toggleGroup(subKey);
                                    if (nextExpanded) {
                                      fetchResourceGroupsForSubscription(subscriptionNode.id).catch(() => {
                                        /* handled in state */
                                      });
                                    }
                                  }}
                                >
                                  <span>{subExpanded ? '▾' : '▸'}</span>
                                  <span>{subscriptionNode.name}</span>
                                  {loadingResourceGroups[subscriptionNode.id] && (
                                    <span className="tiny-spinner" aria-label="loading resource groups" />
                                  )}
                                </button>
                              )}
                              {(collapsed || subExpanded) && (
                                <div className="aks-tree-children">
                                  {subscriptionNode.resourceGroups.map((resourceGroupNode) => {
                                    const rgKey = `azure-sub:${subscriptionNode.id}:rg:${resourceGroupNode.name}`;
                                    const rgExpanded = !isGroupCollapsed(rgKey);
                                    const rgCacheKey = `${subscriptionNode.id}:${resourceGroupNode.name}`;
                                    const clusters = resourceGroupClusters[rgCacheKey] ?? [];
                                    return (
                                      <div key={rgKey} className="context-root">
                                        {!collapsed && (
                                          <button
                                            className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                                            onClick={() => {
                                              const nextExpanded = isGroupCollapsed(rgKey);
                                              toggleGroup(rgKey);
                                              if (nextExpanded) {
                                                fetchClustersForResourceGroup({
                                                  subscriptionId: subscriptionNode.id,
                                                  resourceGroup: resourceGroupNode.name,
                                                }).catch(() => {
                                                  /* handled in state */
                                                });
                                              }
                                            }}
                                          >
                                            <span>{rgExpanded ? '▾' : '▸'}</span>
                                            <span>{resourceGroupNode.name}</span>
                                            {loadingClusters[rgCacheKey] && (
                                              <span className="tiny-spinner" aria-label="loading clusters" />
                                            )}
                                          </button>
                                        )}
                                        {(collapsed || rgExpanded) && (
                                          <div className="aks-tree-children">
                                            {clusters.map((cluster) => {
                                              const clusterNodeKey = `azure-sub:${subscriptionNode.id}:rg:${resourceGroupNode.name}:cluster:${cluster.name}`;
                                              const clusterExpanded = !isGroupCollapsed(clusterNodeKey);
                                              const clusterLoading = !!loadingImportedContexts[clusterNodeKey];
                                              const matchingContexts = matchContextsForCluster(
                                                orderedContexts,
                                                subscriptionNode.id,
                                                subscriptionNode.name,
                                                cluster.name,
                                              );
                                              return (
                                                <div key={clusterNodeKey} className="context-root">
                                                  <div
                                                    className="nav-item context-item"
                                                    title={cluster.name}
                                                    onClick={() => {
                                                      const nextExpanded = isGroupCollapsed(clusterNodeKey);
                                                      toggleGroup(clusterNodeKey);
                                                      if (!nextExpanded) return;

                                                      void (async () => {
                                                        setLoadingImportedContexts((current) => ({
                                                          ...current,
                                                          [clusterNodeKey]: true,
                                                        }));
                                                        await api.azureAksCredentials({
                                                          resourceGroup: resourceGroupNode.name,
                                                          name: cluster.name,
                                                          subscription: subscriptionNode.id,
                                                        });
                                                        const contextsPayload = await api.getContexts();
                                                        queryClient.setQueryData(['contexts'], contextsPayload);
                                                        const selectedContext =
                                                          contextsPayload.active ??
                                                          matchContextsForCluster(
                                                            contextsPayload.contexts,
                                                            subscriptionNode.id,
                                                            subscriptionNode.name,
                                                            cluster.name,
                                                          )[0]?.name;
                                                        if (selectedContext) {
                                                          onContextChange(selectedContext);
                                                        }
                                                      })()
                                                        .catch(() => {
                                                          /* handled in state */
                                                        })
                                                        .finally(() => {
                                                          setLoadingImportedContexts((current) => {
                                                            const next = { ...current };
                                                            delete next[clusterNodeKey];
                                                            return next;
                                                          });
                                                        });
                                                    }}
                                                  >
                                                    <span className="context-label-wrap">
                                                      {!collapsed && (
                                                        <span className="context-caret">{clusterExpanded ? '▾' : '▸'}</span>
                                                      )}
                                                      <span>{collapsed ? cluster.name.charAt(0) : cluster.name}</span>
                                                    </span>
                                                    {!collapsed && clusterLoading && (
                                                      <span className="tiny-spinner" aria-label="loading context" />
                                                    )}
                                                  </div>
                                                  {(collapsed || clusterExpanded) && (
                                                    <div className="aks-tree-children">
                                                      {matchingContexts.length === 0 && !collapsed && !clusterLoading && (
                                                        <div className="sidebar-hint">No context imported yet.</div>
                                                      )}
                                                      {matchingContexts.map((ctx) =>
                                                        renderContextNode(ctx, `aks-context:${clusterNodeKey}`, undefined, undefined, 'aks'),
                                                      )}
                                                    </div>
                                                  )}
                                                </div>
                                              );
                                            })}
                                          </div>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div className="k8sexplorer-group">
        <div className="aks-header-row">
          <button
            className="k8sexplorer-title k8sexplorer-toggle"
            onClick={() => {
              const nextExpanded = isGroupCollapsed('awsRoot');
              toggleGroup('awsRoot');
              if (nextExpanded) {
                void probeAwsCloudAccounts();
              }
            }}
          >
            <span>{isGroupCollapsed('awsRoot') ? '▸' : '▾'}</span>
            <span>AWS / EKS</span>
            {loadingAwsTree && <span className="tiny-spinner" aria-label="loading AWS clusters" />}
          </button>
          <div className="action-trigger-wrap">
            <button
              className="aks-auth-button action-trigger"
              title="AWS connections"
              aria-label="AWS connections"
              onClick={(event) => {
                event.stopPropagation();
                setAwsHeaderMenuOpen((open) => !open);
              }}
            >
              {hasAwsCloudAccount ? '⋮' : '+'}
            </button>
            {awsHeaderMenuOpen && (
              <div className="action-menu sidebar-action-menu">
                <button
                  className="action-menu-item"
                  onClick={() => {
                    setAwsHeaderMenuOpen(false);
                    onOpenCloudAwsView?.();
                  }}
                >
                  {hasAwsCloudAccount ? 'Reconnect AWS' : 'Add AWS connection'}
                </button>
                {hasAwsCloudAccount && (
                  <button
                    className="action-menu-item"
                    onClick={() => {
                      setAwsHeaderMenuOpen(false);
                      refreshAwsTree();
                    }}
                  >
                    Refresh
                  </button>
                )}
                {hasAwsCloudAccount && (
                  <button
                    className="action-menu-item danger"
                    onClick={() => {
                      setAwsHeaderMenuOpen(false);
                      Promise.resolve(onAwsSignOut())
                        .then(() => fetchAwsTree())
                        .catch(() => {
                          /* handled in state */
                        });
                    }}
                  >
                    Sign Out
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
        {(collapsed || !isGroupCollapsed('awsRoot')) && (
          <div className="k8sexplorer-items">
            {awsProbeRequested && loadingAwsTree && !collapsed && (
              <div className="sidebar-hint">
                Checking AWS account ({awsProbeAttempts}/{CLOUD_ACCOUNT_MAX_RETRIES})...
              </div>
            )}
            {hasAwsCloudAccount && loadingAwsTree && !collapsed && (
              <div className="sidebar-hint">Loading AWS clusters...</div>
            )}
            {hasAwsCloudAccount && awsError && !collapsed && <div className="sidebar-hint">{awsError}</div>}
            {!hasAwsCloudAccount && !awsError && !loadingAwsTree && !collapsed && (
              <div className="sidebar-hint">Click AWS / EKS to check cloud account.</div>
            )}
            {!hasAwsCloudAccount && awsError && !collapsed && <div className="sidebar-hint">{awsError}</div>}
            {hasAwsCloudAccount && awsAccountNode && (
              <div className="aks-tree-children">
                {awsAccountNode.regions.length === 0 && !collapsed && (
                  <div className="sidebar-hint">No EKS clusters found.</div>
                )}
                {awsAccountNode.regions.map((regionNode) => {
                  const regionKey = `aws-region:${regionNode.name}`;
                  const regionExpanded = !isGroupCollapsed(regionKey);
                  return (
                    <div key={regionKey} className="context-root">
                      {!collapsed && (
                        <button
                          className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                          onClick={() => toggleGroup(regionKey)}
                        >
                          <span>{regionExpanded ? '▾' : '▸'}</span>
                          <span>{regionNode.name}</span>
                        </button>
                      )}
                      {(collapsed || regionExpanded) && (
                        <div className="aks-tree-children">
                          {regionNode.clusters.map((cluster) => {
                            const clusterNodeKey = `aws-region:${regionNode.name}:cluster:${cluster.name}`;
                            const clusterExpanded = !isGroupCollapsed(clusterNodeKey);
                            const clusterLoading = !!loadingAwsImportedContexts[clusterNodeKey];
                            const matchingContexts = matchContextsForEksCluster(
                              orderedContexts,
                              awsAccountNode.accountId,
                              regionNode.name,
                              cluster.name,
                            );
                            return (
                              <div key={clusterNodeKey} className="context-root">
                                <div
                                  className="nav-item context-item"
                                  title={cluster.name}
                                  onClick={() => {
                                    const nextExpanded = isGroupCollapsed(clusterNodeKey);
                                    toggleGroup(clusterNodeKey);
                                    if (!nextExpanded) return;

                                    void (async () => {
                                      setLoadingAwsImportedContexts((current) => ({
                                        ...current,
                                        [clusterNodeKey]: true,
                                      }));
                                      await api.awsEksCredentials({ region: regionNode.name, name: cluster.name });
                                      const contextsPayload = await api.getContexts();
                                      queryClient.setQueryData(['contexts'], contextsPayload);
                                      const selectedContext =
                                        contextsPayload.active ??
                                        matchContextsForEksCluster(
                                          contextsPayload.contexts,
                                          awsAccountNode.accountId,
                                          regionNode.name,
                                          cluster.name,
                                        )[0]?.name;
                                      if (selectedContext) {
                                        onContextChange(selectedContext);
                                      }
                                    })()
                                      .catch(() => {
                                        /* handled in state */
                                      })
                                      .finally(() => {
                                        setLoadingAwsImportedContexts((current) => {
                                          const next = { ...current };
                                          delete next[clusterNodeKey];
                                          return next;
                                        });
                                      });
                                  }}
                                >
                                  <span className="context-label-wrap">
                                    {!collapsed && (
                                      <span className="context-caret">{clusterExpanded ? '▾' : '▸'}</span>
                                    )}
                                    <span>{collapsed ? cluster.name.charAt(0) : cluster.name}</span>
                                  </span>
                                  {!collapsed && clusterLoading && (
                                    <span className="tiny-spinner" aria-label="loading context" />
                                  )}
                                </div>
                                {(collapsed || clusterExpanded) && (
                                  <div className="aks-tree-children">
                                    {matchingContexts.length === 0 && !collapsed && !clusterLoading && (
                                      <div className="sidebar-hint">No context imported yet.</div>
                                    )}
                                    {matchingContexts.map((ctx) =>
                                      renderContextNode(ctx, `eks-context:${clusterNodeKey}`, undefined, undefined, 'eks'),
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="k8sexplorer-group">
        {!collapsed && (
          <div className="local-kubeconfigs-header-row">
            <button className="k8sexplorer-title k8sexplorer-toggle" onClick={() => toggleGroup('localKubeconfigsRoot')}>
              <span>{isGroupCollapsed('localKubeconfigsRoot') ? '▸' : '▾'}</span>
              <span>Local Kubeconfigs</span>
            </button>
            <button
              className="local-kubeconfig-upload-button"
              title="Upload kubeconfig"
              disabled={uploadBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              {uploadBusy ? '⋮' : '+'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml,.conf,.txt"
              className="hidden-file-input"
              onChange={handleUploadFile}
            />
          </div>
        )}
        {(collapsed || !isGroupCollapsed('localKubeconfigsRoot')) && (
          <div className="k8sexplorer-items">
            {localKubeconfigs.length === 0 && !collapsed && (
              <div className="sidebar-hint">No local kubeconfigs uploaded yet.</div>
            )}
            {localKubeconfigs.map((item) => {
              const isMenuOpen = menuLocalKubeconfigId === item.id;
              const nodeKey = `localkube:${item.id}`;
              const expanded = !isGroupCollapsed(nodeKey);
              return (
                <div key={item.id} className="context-root">
                  <div
                    className="nav-item context-item"
                    title={item.name}
                    onClick={async () => {
                      const willExpand = isGroupCollapsed(nodeKey);
                      if (willExpand) {
                        const preferredContext = item.contexts[0];
                        const ok = await ensureLocalAzureConnected(preferredContext);
                        if (!ok) return;
                      }
                      toggleGroup(nodeKey);
                    }}
                  >
                    <span className="context-label-wrap">
                      {!collapsed && (
                        <button
                          className="context-caret-button"
                          title={expanded ? `Collapse ${item.name}` : `Expand ${item.name}`}
                          onClick={async (event) => {
                            event.stopPropagation();
                            const willExpand = isGroupCollapsed(nodeKey);
                            if (willExpand) {
                              const preferredContext = item.contexts[0];
                              const ok = await ensureLocalAzureConnected(preferredContext);
                              if (!ok) return;
                            }
                            toggleGroup(nodeKey);
                          }}
                        >
                          <span className="context-caret">{expanded ? '▾' : '▸'}</span>
                        </button>
                      )}
                      <span className="local-kubeconfig-bullet">◍</span>
                      <span>{collapsed ? item.name.charAt(0) : item.name}</span>
                    </span>
                    {!collapsed && (
                      <span className="context-meta">
                        <button
                          className="action-trigger sidebar-action-trigger"
                          title={`Actions for ${item.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuLocalKubeconfigId((current) => (current === item.id ? undefined : item.id));
                          }}
                        >
                          ⋮
                        </button>
                      </span>
                    )}
                  </div>
                  {!collapsed && isMenuOpen && (
                    <div className="action-menu sidebar-action-menu">
                      <button
                        className="action-menu-item"
                        onClick={async (event) => {
                          event.stopPropagation();
                          setMenuLocalKubeconfigId(undefined);
                          const ok = await ensureLocalAzureConnected(item.contexts[0]);
                          if (!ok) return;
                          onConnectLocalKubeconfig(item.id).catch((err) => {
                            // eslint-disable-next-line no-console
                            console.error('Failed to connect local kubeconfig:', err);
                          });
                        }}
                      >
                        Connect
                      </button>
                      {!!scope.context && item.contexts.includes(scope.context) && (
                        <button
                          className="action-menu-item"
                          onClick={(event) => {
                            event.stopPropagation();
                            setMenuLocalKubeconfigId(undefined);
                            onContextChange(undefined);
                          }}
                        >
                          Disconnect
                        </button>
                      )}
                      <button
                        className="action-menu-item danger"
                        onClick={(event) => {
                          event.stopPropagation();
                          setMenuLocalKubeconfigId(undefined);
                          if (
                            !confirm(
                              `Remove local kubeconfig "${item.name}" and all its contexts?\n\nThis cannot be undone.`,
                            )
                          ) {
                            return;
                          }
                          onDeleteLocalKubeconfig(item.id).catch((err) => {
                            // eslint-disable-next-line no-console
                            console.error('Failed to remove local kubeconfig:', err);
                          });
                        }}
                      >
                        Remove Config
                      </button>
                    </div>
                  )}
                  {(collapsed || expanded) && (
                    <div className="aks-tree-children">
                      {localAzureAuthInProgress && !collapsed && (
                        <div className="sidebar-hint sidebar-hint-loading">
                          <span className="tiny-spinner" aria-label="checking local Azure authentication" />
                          <span>{`Checking local Azure authentication (${localAzureRetryCount}/${localAzureMaxRetries})...`}</span>
                        </div>
                      )}
                      {localAzureAuthFailed && !collapsed && (
                        <div className="sidebar-hint">Authenticate Azure (local scope) to view contexts.</div>
                      )}
                      {!localAzureAuthenticated && collapsed && null}
                      {localAzureAuthenticated && item.contexts.length === 0 && !collapsed && (
                        <div className="sidebar-hint">No contexts found in this file.</div>
                      )}
                      {localAzureAuthenticated &&
                        item.contexts.map((ctxName) => {
                          const removeContext = () => {
                            if (
                              confirm(
                                `Remove context "${ctxName}" from "${item.name}"?\n\nThis edits the stored kubeconfig and cannot be undone.`,
                              )
                            ) {
                              onDeleteLocalKubeconfigContext(item.id, ctxName).catch((err) => {
                                // eslint-disable-next-line no-console
                                console.error('Failed to remove context:', err);
                              });
                            }
                          };

                          const matched =
                            orderedContexts.find((ctx) => ctx.name === ctxName && ctx.source?.provider === 'local') ??
                            orderedContexts.find((ctx) => ctx.name === ctxName);
                          if (matched) {
                            return renderContextNode(
                              matched,
                              `localkube:${item.id}`,
                              undefined,
                              {
                                onRemove: removeContext,
                              },
                              'local',
                              item.id,
                            );
                          }

                          const stubKey = `${item.id}:${ctxName}`;
                          const stubMenuOpen = menuLocalContextKey === stubKey;
                          return (
                            <div key={stubKey} className="context-root">
                              <div
                                className="nav-item context-item"
                                title={`Connect ${ctxName}`}
                                onClick={async () => {
                                  const ok = await ensureLocalAzureConnected(ctxName);
                                  if (!ok) return;
                                  onConnectLocalKubeconfig(item.id, ctxName).catch((err) => {
                                    // eslint-disable-next-line no-console
                                    console.error('Failed to connect local kubeconfig context:', err);
                                  });
                                }}
                              >
                                <span className="context-label-wrap">
                                  <span>{collapsed ? ctxName.charAt(0) : ctxName}</span>
                                </span>
                                {!collapsed && (
                                  <span className="context-meta">
                                    <span
                                      className="context-status-dot disconnected"
                                      title="Disconnected — click to connect"
                                    />
                                    <button
                                      className="action-trigger sidebar-action-trigger"
                                      title={`Actions for ${ctxName}`}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setMenuLocalContextKey((current) => (current === stubKey ? undefined : stubKey));
                                      }}
                                    >
                                      ⋮
                                    </button>
                                  </span>
                                )}
                              </div>
                              {!collapsed && stubMenuOpen && (
                                <div className="action-menu sidebar-action-menu">
                                  <button
                                    className="action-menu-item"
                                    onClick={async (event) => {
                                      event.stopPropagation();
                                      setMenuLocalContextKey(undefined);
                                      const ok = await ensureLocalAzureConnected(ctxName);
                                      if (!ok) return;
                                      onConnectLocalKubeconfig(item.id, ctxName).catch((err) => {
                                        // eslint-disable-next-line no-console
                                        console.error('Failed to connect local kubeconfig context:', err);
                                      });
                                    }}
                                  >
                                    Connect
                                  </button>
                                  <button
                                    className="action-menu-item danger"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setMenuLocalContextKey(undefined);
                                      removeContext();
                                    }}
                                  >
                                    Remove context
                                  </button>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
