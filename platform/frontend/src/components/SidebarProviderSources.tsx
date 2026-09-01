import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useMinikubeStatus } from '../api/minikubeApi';
import { useConfirm } from './ConfirmDialog';
import { uiText } from '../text';
import type { View } from '../App';
import type { Scope } from '../api/client';
import type { AksCluster, AwsIdentity, EksCluster, KubeContext, LocalKubeconfigSummary } from '../api/types';
import azureIcon from '../../assets/azure.svg';
import awsIcon from '../../assets/aws.svg';
import kubeIcon from '../../assets/local-kubeconfigs.svg';


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

/** Subscriptions grouped by the Azure AD tenant they actually belong to - one
 * signed-in account can have subscriptions across several tenants. */
type LiveAksTenantNode = {
  id: string;
  name?: string;
  subscriptions: LiveAksSubscriptionNode[];
};

type LiveAksAccountNode = {
  email: string;
  userType?: string;
  tenants: LiveAksTenantNode[];
};

const UNKNOWN_TENANT_KEY = 'unknown';

function groupSubscriptionsByTenant(
  subscriptions: { id: string; name: string; tenantId?: string; tenantDisplayName?: string }[],
): LiveAksTenantNode[] {
  const byTenant = new Map<string, { name?: string; subs: LiveAksSubscriptionNode[] }>();
  for (const s of subscriptions) {
    const tenantId = s.tenantId || UNKNOWN_TENANT_KEY;
    const bucket = byTenant.get(tenantId) ?? { name: undefined, subs: [] };
    bucket.name ??= s.tenantDisplayName;
    bucket.subs.push({ id: s.id, name: s.name, resourceGroups: [] });
    byTenant.set(tenantId, bucket);
  }
  return Array.from(byTenant.entries())
    .map(([id, { name, subs }]) => ({
      id,
      name,
      subscriptions: subs.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

function tenantLabel(tenant: LiveAksTenantNode): string {
  if (tenant.id === UNKNOWN_TENANT_KEY) return 'Unknown tenant';
  return tenant.name ?? `Tenant ${tenant.id.slice(0, 8)}…`;
}

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
  activeTabOriginContext?: string;
  activeTabOriginSource?: 'aks' | 'eks' | 'local' | 'minikube';
  /** True right after a Starred Contexts selection - the reveal effects below
   * skip forcing this tree open in that case (see the useEffect above them). */
  suppressTreeReveal?: boolean;
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
    originSource?: 'aks' | 'eks' | 'local' | 'minikube',
    originKubeconfigId?: string,
  ) => React.ReactNode;
  renderSectionGroups: (contextName: string, originSource?: 'aks' | 'eks' | 'local' | 'minikube', originKubeconfigId?: string) => React.ReactNode;
  onSelect: (view: View, originContext?: string, originSource?: 'aks' | 'eks' | 'local' | 'minikube', originKubeconfigId?: string) => void;
  onContextChange: (name?: string, origin?: { source?: 'aks' | 'eks' | 'local' | 'minikube'; kubeconfigId?: string; reveal?: boolean }) => Promise<void> | void;
  onPin: (view: View, originContext?: string, originSource?: 'aks' | 'eks' | 'local' | 'minikube', originKubeconfigId?: string) => void;
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
  activeTabOriginContext,
  activeTabOriginSource,
  suppressTreeReveal,
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
  renderSectionGroups,
  onSelect,
  onContextChange,
  onPin,
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
  const confirm = useConfirm();
  const localAzureAuthInProgress = !localAzureAuthenticated && localAzureAuthStatus === 'checking';
  const localAzureAuthFailed = !localAzureAuthenticated && localAzureAuthStatus === 'failed';
  const hasAzureCloudAccount = azureSignedIn || azureAccounts.length > 0;
  const hasAwsCloudAccount = awsSignedIn || !!awsAccountNode;
  const { data: minikubeStatus } = useMinikubeStatus('minikube');
  const isMinikubeRunning = minikubeStatus?.status === 'running';
  const minikubeExpanded = !isGroupCollapsed('minikubeRoot');
  const minikubeResourcesExpanded = !isGroupCollapsed('minikubeResourcesRoot');

  useEffect(() => {
    if (isMinikubeRunning) return;
    if (!isGroupCollapsed('minikubeResourcesRoot')) {
      toggleGroup('minikubeResourcesRoot');
    }
  }, [isMinikubeRunning, isGroupCollapsed, toggleGroup]);

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

  const fetchAccounts = async () => {
    setLoadingSubscriptions(true);
    setAksError(null);
    try {
      setAzureAccounts((current) => current);
      const accounts = (await api.azureAccounts('cloud')).accounts.map((account) => ({
        email: account.email,
        userType: account.userType,
        tenants: groupSubscriptionsByTenant(account.subscriptions),
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
          tenants: account.tenants.map((tenant) => ({
            ...tenant,
            subscriptions: tenant.subscriptions.map((sub) =>
              sub.id === subscriptionId ? { ...sub, resourceGroups } : sub,
            ),
          })),
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
          tenants: groupSubscriptionsByTenant(account.subscriptions),
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
    if (!azureSignedIn) return;
    if (azureAccounts.length > 0 || loadingSubscriptions) return;
    void probeAzureCloudAccounts();
  }, [azureSignedIn, azureAccounts.length, loadingSubscriptions]);

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

  // Whichever cloud-sourced context the still-open active tab points at (if any). Its
  // location in the tree is the one thing besides an explicit click that's allowed to
  // auto-expand — see the effects below.
  const activeTabTargetContext = useMemo(() => {
    if (!activeTabOriginContext) return undefined;
    if (activeTabOriginSource !== 'aks' && activeTabOriginSource !== 'eks') return undefined;
    return orderedContexts.find(
      (ctx) => ctx.name === activeTabOriginContext && ctx.source?.provider === activeTabOriginSource,
    );
  }, [activeTabOriginContext, activeTabOriginSource, orderedContexts]);

  useEffect(() => {
    if (suppressTreeReveal) return;
    if (activeTabTargetContext?.source?.provider === 'aks') expandGroup('azureRoot');
    if (activeTabTargetContext?.source?.provider === 'eks') expandGroup('awsRoot');
  }, [activeTabTargetContext, expandGroup, suppressTreeReveal]);

  // Single reactive trigger for probing cloud accounts: fires whenever the root is
  // expanded (by click or by the effect above) and nothing's been loaded yet.
  useEffect(() => {
    if (isGroupCollapsed('azureRoot') || azureAccounts.length > 0 || loadingSubscriptions || aksError) return;
    void probeAzureCloudAccounts();
     
  }, [isGroupCollapsed, azureAccounts.length, loadingSubscriptions, aksError]);

  useEffect(() => {
    if (isGroupCollapsed('awsRoot') || awsAccountNode || loadingAwsTree || awsError) return;
    void probeAwsCloudAccounts();
     
  }, [isGroupCollapsed, awsAccountNode, loadingAwsTree, awsError]);

  // Once the matching subscription is known, reveal it (and its owning account/tenant) too.
  useEffect(() => {
    if (suppressTreeReveal) return;
    const ctx = activeTabTargetContext;
    if (!ctx || ctx.source?.provider !== 'aks') return;
    findMatchingSubscription: for (const account of azureAccounts) {
      for (const tenant of account.tenants) {
        const sub = tenant.subscriptions.find(
          (s) => s.id === ctx.source?.subscriptionId || s.name === ctx.source?.subscriptionName,
        );
        if (sub) {
          expandGroup(`azure-account:${account.email}`);
          expandGroup(`azure-account:${account.email}:tenant:${tenant.id}`);
          expandGroup(`azure-sub:${sub.id}`);
          break findMatchingSubscription;
        }
      }
    }
  }, [activeTabTargetContext, azureAccounts, expandGroup, suppressTreeReveal]);

  // ...and once that subscription's resource groups load, reveal the matching one.
  useEffect(() => {
    if (suppressTreeReveal) return;
    const ctx = activeTabTargetContext;
    if (!ctx || ctx.source?.provider !== 'aks' || !ctx.source.resourceGroup) return;
    findMatchingResourceGroup: for (const account of azureAccounts) {
      for (const tenant of account.tenants) {
        const sub = tenant.subscriptions.find(
          (s) => s.id === ctx.source?.subscriptionId || s.name === ctx.source?.subscriptionName,
        );
        const rg = sub?.resourceGroups.find((r) => r.name === ctx.source?.resourceGroup);
        if (rg) {
          expandGroup(`azure-sub:${sub!.id}:rg:${rg.name}`);
          break findMatchingResourceGroup;
        }
      }
    }
  }, [activeTabTargetContext, azureAccounts, expandGroup, suppressTreeReveal]);

  // AWS has no account/resource-group nesting in the tree — region is the only level.
  useEffect(() => {
    if (suppressTreeReveal) return;
    const ctx = activeTabTargetContext;
    if (!ctx || ctx.source?.provider !== 'eks' || !ctx.source.region) return;
    expandGroup(`aws-region:${ctx.source.region}`);
  }, [activeTabTargetContext, expandGroup, suppressTreeReveal]);

  // Expand/collapse state persists across reloads, but resource groups are only ever
  // fetched from the subscription toggle's onClick. A subscription restored already
  // expanded from a previous session would otherwise sit with no data (and, worse,
  // read as "no resource groups found") until the user collapses and re-expands it.
  useEffect(() => {
    for (const account of azureAccounts) {
      for (const tenant of account.tenants) {
        for (const sub of tenant.subscriptions) {
          if (isGroupCollapsed(`azure-sub:${sub.id}`) || loadingResourceGroups[sub.id] || subscriptionClusterCache[sub.id]) continue;
          fetchResourceGroupsForSubscription(sub.id).catch(() => {
            /* handled in state */
          });
        }
      }
    }
     
  }, [azureAccounts, isGroupCollapsed]);

  // Same restored-expanded-with-no-data gap one level down: a resource group left
  // expanded from a previous session needs its clusters fetched too.
  useEffect(() => {
    for (const account of azureAccounts) {
      for (const tenant of account.tenants) {
        for (const sub of tenant.subscriptions) {
          for (const rg of sub.resourceGroups) {
            const rgCacheKey = `${sub.id}:${rg.name}`;
            if (isGroupCollapsed(`azure-sub:${sub.id}:rg:${rg.name}`) || loadingClusters[rgCacheKey] || resourceGroupClusters[rgCacheKey]) {
              continue;
            }
            fetchClustersForResourceGroup({ subscriptionId: sub.id, resourceGroup: rg.name }).catch(() => {
              /* handled in state */
            });
          }
        }
      }
    }
     
  }, [azureAccounts, isGroupCollapsed]);

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
    expandGroup('azureRoot');
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
    const ok = await confirm({
      title: uiText.confirmDialog.removeTitle,
      message: `Disconnect imported AKS clusters for ${email}?`,
      details: 'The account stays signed in, but its imported cluster contexts will be removed.',
    });
    if (!ok) return;
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
            onClick={() => toggleGroup('azureRoot')}
          >
            <span>{isGroupCollapsed('azureRoot') ? '▸' : '▾'}</span>
            <img src={azureIcon} className="svg-inject" alt="Azure" />
            <span>{uiText.sidebar.azureAccounts}</span>
            {loadingSubscriptions && <span className="tiny-spinner" aria-label={uiText.sidebar.loadingAzureAccounts} />}
          </button>
          <div className="action-trigger-wrap">
            <button
              className="aks-auth-button action-trigger"
              title={uiText.sidebar.azureConnections}
              aria-label={uiText.sidebar.azureConnections}
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
                {/* {hasAzureCloudAccount && (
                  <button
                    className="action-menu-item"
                    onClick={() => {
                      setAzureHeaderMenuOpen(false);
                      onOpenCloudAzureView?.();
                    }}
                  >
                    Reconnect Azure
                  </button>
                )} */}
                <button
                  className="action-menu-item"
                  onClick={() => {
                    setAzureHeaderMenuOpen(false);
                    refreshAzureTree();
                  }}
                >
                  Refresh
                </button>
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
              <div className="sidebar-hint">{uiText.sidebar.loadingAzureAccounts}</div>
            )}
            {hasAzureCloudAccount && aksError && !collapsed && <div className="sidebar-hint">{aksError}</div>}
            {!hasAzureCloudAccount && !aksError && !loadingSubscriptions && !collapsed && (
              <div className="sidebar-hint">{uiText.sidebar.checkAzureAccount}</div>
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
                              {/* <button
                                className="action-menu-item"
                                onClick={() => handleDisconnectAzureAccount(accountNode.email)}
                              >
                                Disconnect clusters
                              </button> */}
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
                        {accountNode.tenants.map((tenantNode) => {
                          const tenantKey = `azure-account:${accountNode.email}:tenant:${tenantNode.id}`;
                          const tenantExpanded = !isGroupCollapsed(tenantKey);
                          return (
                            <div key={tenantKey} className="context-root">
                              {!collapsed && (
                                <button
                                  className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                                  onClick={() => toggleGroup(tenantKey)}
                                  title={tenantNode.id === UNKNOWN_TENANT_KEY ? undefined : tenantNode.id}
                                >
                                  <span>{tenantExpanded ? '▾' : '▸'}</span>
                                  <span>{tenantLabel(tenantNode)}</span>
                                </button>
                              )}
                              {(collapsed || tenantExpanded) && (
                                <div className="aks-tree-children">
                                  {tenantNode.subscriptions.map((subscriptionNode) => {
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
                                            {!collapsed &&
                                              !loadingResourceGroups[subscriptionNode.id] &&
                                              subscriptionNode.resourceGroups.length === 0 && (
                                                <div className="sidebar-hint">{uiText.sidebar.noResourceGroups}</div>
                                              )}
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
                                                      {!collapsed && !loadingClusters[rgCacheKey] && clusters.length === 0 && (
                                                        <div className="sidebar-hint">{uiText.sidebar.noClustersFound}</div>
                                                      )}
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
                                                                // Guard against firing a second `az aks get-credentials` while one
                                                                // is still in flight for this cluster (e.g. a rapid double-click) -
                                                                // two concurrent writes to the same kubeconfig file can race and
                                                                // leave a duplicated context entry behind.
                                                                if (clusterLoading) return;
          
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
                                                                    onContextChange(selectedContext, { source: 'aks' });
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
                                                                  <div className="sidebar-hint">{uiText.sidebar.noContextImported}</div>
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
                );
              })}
          </div>
        )}
      </div>

      <div className="k8sexplorer-group">
        <div className="aks-header-row">
          <button
            className="k8sexplorer-title k8sexplorer-toggle"
            onClick={() => toggleGroup('awsRoot')}
          >
            <span>{isGroupCollapsed('awsRoot') ? '▸' : '▾'}</span>
            <img src={awsIcon} className="svg-inject" alt="AWS" />
            <span>{uiText.sidebar.awsAccounts}</span>
            {loadingAwsTree && <span className="tiny-spinner" aria-label={uiText.sidebar.loadingAwsClusters} />}
          </button>
          <div className="action-trigger-wrap">
            <button
              className="aks-auth-button action-trigger"
              title={uiText.sidebar.awsConnections}
              aria-label={uiText.sidebar.awsConnections}
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
              <div className="sidebar-hint">{uiText.sidebar.loadingAwsClusters}</div>
            )}
            {hasAwsCloudAccount && awsError && !collapsed && <div className="sidebar-hint">{awsError}</div>}
            {!hasAwsCloudAccount && !awsError && !loadingAwsTree && !collapsed && (
              <div className="sidebar-hint">{uiText.sidebar.checkAwsAccount}</div>
            )}
            {!hasAwsCloudAccount && awsError && !collapsed && <div className="sidebar-hint">{awsError}</div>}
            {hasAwsCloudAccount && awsAccountNode && (
              <div className="aks-tree-children">
                {awsAccountNode.regions.length === 0 && !collapsed && (
                  <div className="sidebar-hint">{uiText.sidebar.noEksClustersFound}</div>
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
                          {!collapsed && regionNode.clusters.length === 0 && (
                            <div className="sidebar-hint">No clusters found.</div>
                          )}
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
                                        onContextChange(selectedContext, { source: 'eks' });
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
              <img src={kubeIcon} className="svg-inject" alt="Kubernetes" />
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
              const isMinikubeConfig = item.contexts.includes('minikube');
              return (
                <div key={item.id} className="context-root">
                  <div
                    className="nav-item context-item"
                    title={item.name}
                    onClick={async () => {
                      const willExpand = isGroupCollapsed(nodeKey);
                      if (willExpand) {
                        const preferredContext = item.contexts[0];
                        if (!isMinikubeConfig) {
                          const ok = await ensureLocalAzureConnected(preferredContext);
                          if (!ok) return;
                        }
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
                              if (!isMinikubeConfig) {
                                const ok = await ensureLocalAzureConnected(preferredContext);
                                if (!ok) return;
                              }
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
                      <div className="context-meta">
                        <div className="action-trigger-wrap">
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
                          {isMenuOpen && (
                            <div className="action-menu sidebar-action-menu">
                              <button
                                className="action-menu-item danger"
                                onClick={async (event) => {
                                  event.stopPropagation();
                                  setMenuLocalKubeconfigId(undefined);
                                  const ok = await confirm({
                                    title: uiText.confirmDialog.removeTitle,
                                    message: `Remove local kubeconfig "${item.name}" and all its contexts?`,
                                    details: 'This cannot be undone.',
                                    confirmLabel: uiText.confirmDialog.remove,
                                  });
                                  if (!ok) return;
                                  onDeleteLocalKubeconfig(item.id).catch((err) => {
                                    console.error('Failed to remove local kubeconfig:', err);
                                  });
                                }}
                              >
                                Remove Config
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
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
                      {(localAzureAuthenticated || isMinikubeConfig) && item.contexts.length === 0 && !collapsed && (
                        <div className="sidebar-hint">No contexts found in this file.</div>
                      )}
                      {(localAzureAuthenticated || isMinikubeConfig) &&
                        item.contexts.map((ctxName) => {
                          const removeContext = async () => {
                            const ok = await confirm({
                              title: uiText.confirmDialog.removeTitle,
                              message: `Remove context "${ctxName}" from "${item.name}"?`,
                              details: 'This edits the stored kubeconfig and cannot be undone.',
                              confirmLabel: uiText.confirmDialog.remove,
                            });
                            if (!ok) return;
                            onDeleteLocalKubeconfigContext(item.id, ctxName).catch((err) => {
                              console.error('Failed to remove context:', err);
                            });
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
                                  if (!isMinikubeConfig) {
                                    const ok = await ensureLocalAzureConnected(ctxName);
                                    if (!ok) return;
                                  }
                                  onConnectLocalKubeconfig(item.id, ctxName).catch((err) => {
                                    console.error('Failed to connect local kubeconfig context:', err);
                                  });
                                }}
                              >
                                <span className="context-label-wrap">
                                  <span>{collapsed ? ctxName.charAt(0) : ctxName}</span>
                                </span>
                                {!collapsed && (
                                  <div className="context-meta">
                                    <span
                                      className="context-status-dot disconnected"
                                      title="Disconnected — click to connect"
                                    />
                                    <div className="action-trigger-wrap">
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
                                      {stubMenuOpen && (
                                        <div className="action-menu sidebar-action-menu">
                                          <button
                                            className="action-menu-item"
                                            onClick={async (event) => {
                                              event.stopPropagation();
                                              setMenuLocalContextKey(undefined);
                                              if (!isMinikubeConfig) {
                                                const ok = await ensureLocalAzureConnected(ctxName);
                                                if (!ok) return;
                                              }
                                              onConnectLocalKubeconfig(item.id, ctxName).catch((err) => {
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
                                  </div>
                                )}
                              </div>
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
        <div className="local-kubeconfigs-header-row">
          <button
            className="k8sexplorer-title k8sexplorer-toggle"
            title="Local Minikube"
            onClick={() => toggleGroup('minikubeRoot')}
          >
            <span>{minikubeExpanded ? '▾' : '▸'}</span>
            <img src={kubeIcon} className="svg-inject" alt="" />
            <span>{collapsed ? 'M' : 'Local Minikube'}</span>
          </button>
        </div>
        {(collapsed || minikubeExpanded) && (
          <div className="k8sexplorer-items">
            <div className="context-root">
            <div
              className={`nav-item context-item ${view?.type === 'minikube' ? 'active' : ''}`}
              title="Cluster Configuration"
              onClick={() => onSelect({ type: 'minikube' })}
              onDoubleClick={() => onPin({ type: 'minikube' })}
            >
              <span className="context-label-wrap">
                <span className="context-caret">*</span>
                <span className="local-kubeconfig-bullet">◍</span>
                <span>{collapsed ? 'C' : 'Cluster Configuration'}</span>
              </span>
            </div>
            </div>
            <div className="context-root">
              <div
                className={`nav-item context-item ${activeTabOriginSource === 'minikube' ? 'active' : ''} ${!isMinikubeRunning ? 'disabled' : ''}`}
                title={isMinikubeRunning ? 'Open Minikube resource explorer' : 'Start Minikube to expand resources'}
                onClick={async () => {
                  if (!isMinikubeRunning) {
                    if (!isGroupCollapsed('minikubeResourcesRoot')) {
                      toggleGroup('minikubeResourcesRoot');
                    }
                    return;
                  }
                  try {
                    const { contextName } = await api.connectMinikube();
                    await queryClient.invalidateQueries({ queryKey: ['contexts'] });
                    await Promise.resolve(onContextChange(contextName, { source: 'minikube' }));
                    if (!minikubeResourcesExpanded) toggleGroup('minikubeResourcesRoot');
                  } catch (err) {
                    console.error('Minikube must be running before its resources can be opened:', err);
                  }
                }}
              >
                <span className="context-label-wrap">
                  {!collapsed && (
                    <button
                        disabled={!isMinikubeRunning}
                      className="context-caret-button"
                        title={
                          isMinikubeRunning
                            ? (minikubeResourcesExpanded ? 'Collapse minikube resources' : 'Expand minikube resources')
                            : 'Minikube is not running'
                        }
                      onClick={(event) => {
                        event.stopPropagation();
                          if (!isMinikubeRunning) return;
                        toggleGroup('minikubeResourcesRoot');
                      }}
                    >
                      <span className="context-caret">{minikubeResourcesExpanded ? '▾' : '▸'}</span>
                    </button>
                  )}
                  <span className="local-kubeconfig-bullet">◍</span>
                  <span>{collapsed ? 'M' : 'minikube'}</span>
                </span>
              </div>
              {(collapsed || minikubeResourcesExpanded) && renderSectionGroups('minikube', 'minikube')}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
