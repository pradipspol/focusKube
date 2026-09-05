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
import minikubeIcon from '../../assets/minikube.svg';
import { TreeDisclosure } from './TreeDisclosure';
import { SidebarAction } from './SidebarAction';
import { SidebarContextMenu } from './SidebarContextMenu';


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
  id: string;
  email: string;
  userType?: string;
  tenants: LiveAksTenantNode[];
};

const UNKNOWN_TENANT_KEY = 'unknown';

function groupSubscriptionsByTenant (
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

function tenantLabel (tenant: LiveAksTenantNode): string {
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
  /** One account signed out (not all of them); `removedContexts` are the imported contexts that went with it. */
  onAzureAccountSignedOut?: (email: string, removedContexts: string[]) => void;
  onOpenCloudAzureView?: () => void;
  awsSignedIn: boolean;
  awsRefreshToken?: number;
  onAwsSignOut: () => Promise<void> | void;
  onOpenCloudAwsView?: () => void;
}

export function SidebarProviderSources ({
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
  onAzureAccountSignedOut,
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
  const [minikubeMenuOpen, setMinikubeMenuOpen] = useState(false);
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
        id: account.id,
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

  // Two signed-in accounts can share access to the same subscription (shared tenant
  // membership, or Lighthouse delegation) - the subscription/resource-group/cluster ids
  // below are then literally identical across accounts, so every cache/tree key must be
  // scoped by accountId or actions on one account's node bleed into the other's.
  const rgCacheKeyFor = (accountId: string, subscriptionId: string) => `${accountId}:${subscriptionId}`;
  const clusterCacheKeyFor = (accountId: string, subscriptionId: string, resourceGroup: string) =>
    `${rgCacheKeyFor(accountId, subscriptionId)}:${resourceGroup}`;
  const azureSubTreeKey = (accountId: string, subscriptionId: string) => `azure-account:${accountId}:sub:${subscriptionId}`;
  const azureRgTreeKey = (accountId: string, subscriptionId: string, resourceGroup: string) =>
    `${azureSubTreeKey(accountId, subscriptionId)}:rg:${resourceGroup}`;
  const azureClusterTreeKey = (accountId: string, subscriptionId: string, resourceGroup: string, clusterName: string) =>
    `${azureRgTreeKey(accountId, subscriptionId, resourceGroup)}:cluster:${clusterName}`;

  const fetchResourceGroupsForSubscription = async (accountId: string, subscriptionId: string, force = false) => {
    const cacheKey = rgCacheKeyFor(accountId, subscriptionId);
    if (!force && subscriptionClusterCache[cacheKey]) return;
    setLoadingResourceGroups((current) => ({ ...current, [cacheKey]: true }));
    setAksError(null);
    try {
      const clusters = (await api.azureAks(subscriptionId, 'cloud', accountId)).clusters;
      setSubscriptionClusterCache((current) => ({ ...current, [cacheKey]: clusters }));

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
        current.map((account) =>
          account.id !== accountId
            ? account
            : {
              ...account,
              tenants: account.tenants.map((tenant) => ({
                ...tenant,
                subscriptions: tenant.subscriptions.map((sub) =>
                  sub.id === subscriptionId ? { ...sub, resourceGroups } : sub,
                ),
              })),
            },
        ),
      );
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to load resource groups');
    } finally {
      setLoadingResourceGroups((current) => ({ ...current, [cacheKey]: false }));
    }
  };

  const fetchClustersForResourceGroup = async (accountId: string, clusterRef: Pick<ClusterRef, 'subscriptionId' | 'resourceGroup'>) => {
    const key = clusterCacheKeyFor(accountId, clusterRef.subscriptionId, clusterRef.resourceGroup);
    if (resourceGroupClusters[key]) return;
    setLoadingClusters((current) => ({ ...current, [key]: true }));
    setAksError(null);
    try {
      const clusters = (await api.azureAks(clusterRef.subscriptionId, 'cloud', accountId)).clusters
        .filter((cluster) => cluster.resourceGroup === clusterRef.resourceGroup)
        .sort((a, b) => a.name.localeCompare(b.name));
      setResourceGroupClusters((current) => ({ ...current, [key]: clusters }));
    } catch (err) {
      setAksError(err instanceof Error ? err.message : 'Failed to load clusters');
    } finally {
      setLoadingClusters((current) => ({ ...current, [key]: false }));
    }
  };

  // Subscription names collide across tenants/accounts (e.g. two different signed-in
  // accounts can each have a "Production" subscription), so only fall back to a name
  // match when the context predates subscriptionId tracking - never let a name match
  // override a present-but-different id.
  const subscriptionMatchesContextSource = (
    sub: { id: string; name: string },
    ctxSource: { subscriptionId?: string; subscriptionName?: string } | undefined,
  ) => (ctxSource?.subscriptionId ? sub.id === ctxSource.subscriptionId : sub.name === ctxSource?.subscriptionName);

  // Contexts imported before accountId tagging (or via legacy fallback) carry no
  // accountId - treat those as matching by subscription/cluster alone. Otherwise a
  // context tagged with one account must not surface under a different account's node,
  // even when both accounts can see the same underlying subscription/cluster.
  const matchContextsForCluster = (
    allContexts: KubeContext[],
    accountId: string,
    subscriptionId: string,
    subscriptionName: string,
    clusterName: string,
  ) =>
    allContexts.filter((ctx) => {
      if (ctx.source?.provider === 'aks' && ctx.source.clusterName) {
        const accountMatches = !ctx.source.accountId || ctx.source.accountId === accountId;
        return (
          accountMatches &&
          ctx.source.clusterName === clusterName &&
          subscriptionMatchesContextSource({ id: subscriptionId, name: subscriptionName }, ctx.source)
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
          id: account.id,
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

  // An external refresh signal (sign-in, per-account sign-out, the Azure panel's Refresh
  // button) must rebuild this tree from scratch.
  //
  // Deliberately NOT gated on `azureProbeRequested`: that flag is only set from inside the
  // probe, so on a fresh page load - where the persisted expand state is cleared and nothing
  // has probed yet - the gate silently discarded the very refresh the caller asked for. It
  // also must not be a dependency: having it in the array re-ran this effect the moment a
  // later probe set it, firing a second concurrent probe whose loser could finish by wiping
  // the tree and reporting "no Azure account detected".
  //
  // `refreshAzureTree` (not a bare probe) because the probe alone leaves the resource-group
  // and cluster caches populated, and the restore effects skip any subscription that still
  // has a cache entry - leaving the tree stuck reading "no resource groups found".
  useEffect(() => {
    if (!azureRefreshToken) return;
    refreshAzureTree();

  }, [azureRefreshToken]);

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
        const sub = tenant.subscriptions.find((s) => subscriptionMatchesContextSource(s, ctx.source));
        if (sub) {
          expandGroup(`azure-account:${account.id}`);
          expandGroup(`azure-account:${account.id}:tenant:${tenant.id}`);
          expandGroup(azureSubTreeKey(account.id, sub.id));
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
        const sub = tenant.subscriptions.find((s) => subscriptionMatchesContextSource(s, ctx.source));
        const rg = sub?.resourceGroups.find((r) => r.name === ctx.source?.resourceGroup);
        if (rg) {
          expandGroup(azureRgTreeKey(account.id, sub!.id, rg.name));
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
          const cacheKey = rgCacheKeyFor(account.id, sub.id);
          if (isGroupCollapsed(azureSubTreeKey(account.id, sub.id)) || loadingResourceGroups[cacheKey] || subscriptionClusterCache[cacheKey]) {
            continue;
          }
          fetchResourceGroupsForSubscription(account.id, sub.id).catch(() => {
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
            const rgCacheKey = clusterCacheKeyFor(account.id, sub.id, rg.name);
            if (isGroupCollapsed(azureRgTreeKey(account.id, sub.id, rg.name)) || loadingClusters[rgCacheKey] || resourceGroupClusters[rgCacheKey]) {
              continue;
            }
            fetchClustersForResourceGroup(account.id, { subscriptionId: sub.id, resourceGroup: rg.name }).catch(() => {
              /* handled in state */
            });
          }
        }
      }
    }

  }, [azureAccounts, isGroupCollapsed]);

  useEffect(() => {
    if (!menuLocalKubeconfigId && !menuLocalContextKey && !azureHeaderMenuOpen && !azureAccountMenuEmail && !awsHeaderMenuOpen && !minikubeMenuOpen) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.action-menu') || target.closest('.sidebar-action-button')) return;
      setMenuLocalKubeconfigId(undefined);
      setMenuLocalContextKey(undefined);
      setAzureHeaderMenuOpen(false);
      setAzureAccountMenuEmail(undefined);
      setAwsHeaderMenuOpen(false);
      setMinikubeMenuOpen(false);
    };

    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [menuLocalKubeconfigId, menuLocalContextKey, azureHeaderMenuOpen, azureAccountMenuEmail, awsHeaderMenuOpen, minikubeMenuOpen]);

  useEffect(() => {
    const closeMenus = () => {
      setMenuLocalKubeconfigId(undefined);
      setMenuLocalContextKey(undefined);
      setAzureHeaderMenuOpen(false);
      setAzureAccountMenuEmail(undefined);
      setAwsHeaderMenuOpen(false);
      setMinikubeMenuOpen(false);
    };
    window.addEventListener('sidebar-context-menu-open', closeMenus);
    return () => window.removeEventListener('sidebar-context-menu-open', closeMenus);
  }, []);

  const refreshAzureTree = () => {
    expandGroup('azureRoot');
    // Deliberately doesn't clear `azureAccounts` first: the backend already deregisters an
    // account synchronously before /logout responds, so the very next /accounts fetch below
    // already reflects the correct list. Clearing here first used to blank EVERY signed-in
    // account (not just the one being removed) for the duration of that fetch, then refill -
    // e.g. signing sghosh out made prapol's sidebar entry flash away too, even though prapol
    // was never touched. Leaving stale data on screen until the fresh fetch swaps it in is
    // strictly better than a spurious "everyone signed out" flash.
    setSubscriptionClusterCache({});
    setResourceGroupClusters({});
    void probeAzureCloudAccounts();
  };

  const refreshAwsTree = () => {
    setAwsAccountNode(null);
    void probeAwsCloudAccounts();
  };

  /** Drops an account's imported cluster contexts but leaves it signed in. */
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
      setAksError(err instanceof Error ? err.message : 'Failed to disconnect account');
    } finally {
      setAzureBusyEmail(undefined);
    }
  };

  /**
   * Actually signs one account out: revokes its Azure CLI session, removes its isolated
   * config dir and its imported contexts, and drops it from this tree.
   *
   * This used to be wired to `handleDisconnectAzureAccount`, which by design leaves the
   * account signed in - so the menu item labelled "Sign out" removed the contexts but left
   * the account in the tree and in the Azure panel.
   */
  const handleSignOutAzureAccount = async (email: string) => {
    const ok = await confirm({
      title: uiText.confirmDialog.removeTitle,
      message: `Sign out ${email}?`,
      details: 'Its imported cluster contexts will be removed. Other signed-in accounts are unaffected.',
    });
    if (!ok) return;
    setAzureAccountMenuEmail(undefined);
    setAzureBusyEmail(email);
    setAksError(null);
    try {
      const { removed = [] } = await api.azureLogout(email, 'cloud');
      const updated = await api.reloadContexts();
      queryClient.setQueryData(['contexts'], updated);
      onAzureAccountSignedOut?.(email, removed);
      refreshAzureTree();
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
            <TreeDisclosure collapsed={isGroupCollapsed('azureRoot')} />
            <img src={azureIcon} className="svg-inject" alt="Azure" />
            <span>{uiText.sidebar.azureAccounts}</span>
            {loadingSubscriptions && <span className="tiny-spinner" aria-label={uiText.sidebar.loadingAzureAccounts} />}
          </button>
          <div className="sidebar-action-slot">
            <SidebarAction
              label={uiText.sidebar.azureConnections}
              onClick={(event) => {
                event.stopPropagation();
                setAzureHeaderMenuOpen((open) => !open);
                setAzureAccountMenuEmail(undefined);
              }}
            />
            {azureHeaderMenuOpen && (
              <SidebarContextMenu
                actions={[
                  { label: 'Add Azure connection', onSelect: () => { setAzureHeaderMenuOpen(false); onOpenCloudAzureView?.(); } },
                  { label: 'Refresh', onSelect: () => { setAzureHeaderMenuOpen(false); refreshAzureTree(); } },
                  ...(hasAzureCloudAccount ? [{
                    label: 'Sign Out All',
                    danger: true,
                    onSelect: async () => { setAzureHeaderMenuOpen(false); await onAzureSignOut(); await fetchAccounts(); },
                  }] : []),
                ]}
              />
            )}
          </div>
        </div>
        {(collapsed || !isGroupCollapsed('azureRoot')) && (
          <div className="sidebar-tree-children">
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
                const accountKey = `azure-account:${accountNode.id}`;
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
                          <TreeDisclosure collapsed={!accountExpanded} />
                          <span className="aks-account-email">{accountNode.email}</span>
                          {accountBusy && <span className="tiny-spinner" aria-label="working" />}
                        </button>
                        <div className="sidebar-action-slot">
                          <SidebarAction
                            label={`Actions for ${accountNode.email}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setAzureAccountMenuEmail(accountMenuOpen ? undefined : accountNode.email);
                              setAzureHeaderMenuOpen(false);
                            }}
                          />
                          {accountMenuOpen && (
                            <SidebarContextMenu
                              actions={[
                                { label: 'Reconnect', onSelect: () => { setAzureAccountMenuEmail(undefined); onOpenCloudAzureView?.(); } },
                                { label: 'Disconnect clusters', onSelect: () => handleDisconnectAzureAccount(accountNode.email) },
                                { label: 'Sign out', danger: true, onSelect: () => handleSignOutAzureAccount(accountNode.email) },
                              ]}
                            />
                          )}
                        </div>
                      </div>
                    )}
                    {(collapsed || accountExpanded) && (
                      <div className="sidebar-tree-children">
                        {accountNode.tenants.map((tenantNode) => {
                          const tenantKey = `azure-account:${accountNode.id}:tenant:${tenantNode.id}`;
                          const tenantExpanded = !isGroupCollapsed(tenantKey);
                          return (
                            <div key={tenantKey} className="context-root">
                              {!collapsed && (
                                <button
                                  className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                                  onClick={() => toggleGroup(tenantKey)}
                                  title={tenantNode.id === UNKNOWN_TENANT_KEY ? undefined : tenantNode.id}
                                >
                                  <TreeDisclosure collapsed={!tenantExpanded} />
                                  <span>{tenantLabel(tenantNode)}</span>
                                </button>
                              )}
                              {(collapsed || tenantExpanded) && (
                                <div className="sidebar-tree-children">
                                  {tenantNode.subscriptions.map((subscriptionNode) => {
                                    const subKey = azureSubTreeKey(accountNode.id, subscriptionNode.id);
                                    const subExpanded = !isGroupCollapsed(subKey);
                                    const subCacheKey = rgCacheKeyFor(accountNode.id, subscriptionNode.id);
                                    return (
                                      <div key={subKey} className="context-root">
                                        {!collapsed && (
                                          <button
                                            className="k8sexplorer-title k8sexplorer-toggle aks-tree-toggle"
                                            onClick={() => {
                                              const nextExpanded = isGroupCollapsed(subKey);
                                              toggleGroup(subKey);
                                              if (nextExpanded) {
                                                fetchResourceGroupsForSubscription(accountNode.id, subscriptionNode.id).catch(() => {
                                                  /* handled in state */
                                                });
                                              }
                                            }}
                                          >
                                            <TreeDisclosure collapsed={!subExpanded} />
                                            <span>{subscriptionNode.name}</span>
                                            {loadingResourceGroups[subCacheKey] && (
                                              <span className="tiny-spinner" aria-label="loading resource groups" />
                                            )}
                                          </button>
                                        )}
                                        {(collapsed || subExpanded) && (
                                          <div className="sidebar-tree-children">
                                            {!collapsed &&
                                              !loadingResourceGroups[subCacheKey] &&
                                              subscriptionNode.resourceGroups.length === 0 && (
                                                <div className="sidebar-hint">{uiText.sidebar.noResourceGroups}</div>
                                              )}
                                            {subscriptionNode.resourceGroups.map((resourceGroupNode) => {
                                              const rgKey = azureRgTreeKey(accountNode.id, subscriptionNode.id, resourceGroupNode.name);
                                              const rgExpanded = !isGroupCollapsed(rgKey);
                                              const rgCacheKey = clusterCacheKeyFor(accountNode.id, subscriptionNode.id, resourceGroupNode.name);
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
                                                          fetchClustersForResourceGroup(accountNode.id, {
                                                            subscriptionId: subscriptionNode.id,
                                                            resourceGroup: resourceGroupNode.name,
                                                          }).catch(() => {
                                                            /* handled in state */
                                                          });
                                                        }
                                                      }}
                                                    >
                                                      <TreeDisclosure collapsed={!rgExpanded} />
                                                      <span>{resourceGroupNode.name}</span>
                                                      {loadingClusters[rgCacheKey] && (
                                                        <span className="tiny-spinner" aria-label="loading clusters" />
                                                      )}
                                                    </button>
                                                  )}
                                                  {(collapsed || rgExpanded) && (
                                                    <div className="sidebar-tree-children">
                                                      {!collapsed && !loadingClusters[rgCacheKey] && clusters.length === 0 && (
                                                        <div className="sidebar-hint">{uiText.sidebar.noClustersFound}</div>
                                                      )}
                                                      {clusters.map((cluster) => {
                                                        const clusterNodeKey = azureClusterTreeKey(
                                                          accountNode.id,
                                                          subscriptionNode.id,
                                                          resourceGroupNode.name,
                                                          cluster.name,
                                                        );
                                                        const clusterExpanded = !isGroupCollapsed(clusterNodeKey);
                                                        const clusterLoading = !!loadingImportedContexts[clusterNodeKey];
                                                        const matchingContexts = matchContextsForCluster(
                                                          orderedContexts,
                                                          accountNode.id,
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
                                                                    accountId: accountNode.id,
                                                                  });
                                                                  const contextsPayload = await api.getContexts();
                                                                  queryClient.setQueryData(['contexts'], contextsPayload);
                                                                  const selectedContext =
                                                                    contextsPayload.active ??
                                                                    matchContextsForCluster(
                                                                      contextsPayload.contexts,
                                                                      accountNode.id,
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
                                                                  <TreeDisclosure collapsed={!clusterExpanded} />
                                                                )}
                                                                <span>{collapsed ? cluster.name.charAt(0) : cluster.name}</span>
                                                              </span>
                                                              {!collapsed && clusterLoading && (
                                                                <span className="tiny-spinner" aria-label="loading context" />
                                                              )}
                                                            </div>
                                                            {(collapsed || clusterExpanded) && (
                                                              <div className="sidebar-tree-children">
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
            <TreeDisclosure collapsed={isGroupCollapsed('awsRoot')} />
            <img src={awsIcon} className="svg-inject" alt="AWS" />
            <span>{uiText.sidebar.awsAccounts}</span>
            {loadingAwsTree && <span className="tiny-spinner" aria-label={uiText.sidebar.loadingAwsClusters} />}
          </button>
          <div className="sidebar-action-slot">
            <SidebarAction
              label={uiText.sidebar.awsConnections}
              onClick={(event) => {
                event.stopPropagation();
                setAwsHeaderMenuOpen((open) => !open);
              }}
            />
            {awsHeaderMenuOpen && (
              <SidebarContextMenu
                actions={[
                  { label: hasAwsCloudAccount ? 'Reconnect AWS' : 'Add AWS connection', onSelect: () => { setAwsHeaderMenuOpen(false); onOpenCloudAwsView?.(); } },
                  ...(hasAwsCloudAccount ? [
                    { label: 'Refresh', onSelect: () => { setAwsHeaderMenuOpen(false); refreshAwsTree(); } },
                    { label: 'Sign Out', danger: true, onSelect: async () => { setAwsHeaderMenuOpen(false); await onAwsSignOut(); await fetchAwsTree(); } },
                  ] : []),
                ]}
              />
            )}
          </div>
        </div>
        {(collapsed || !isGroupCollapsed('awsRoot')) && (
          <div className="sidebar-tree-children">
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
              <div className="sidebar-tree-children">
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
                          <TreeDisclosure collapsed={!regionExpanded} />
                          <span>{regionNode.name}</span>
                        </button>
                      )}
                      {(collapsed || regionExpanded) && (
                        <div className="sidebar-tree-children">
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
                                      <TreeDisclosure collapsed={!clusterExpanded} className="context-caret" />
                                    )}
                                    <span>{collapsed ? cluster.name.charAt(0) : cluster.name}</span>
                                  </span>
                                  {!collapsed && clusterLoading && (
                                    <span className="tiny-spinner" aria-label="loading context" />
                                  )}
                                </div>
                                {(collapsed || clusterExpanded) && (
                                  <div className="sidebar-tree-children">
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
              <TreeDisclosure collapsed={isGroupCollapsed('localKubeconfigsRoot')} />
              <img src={kubeIcon} className="svg-inject" alt="Kubernetes" />
              <span>Local Kubeconfigs</span>
            </button>
            <div className="sidebar-action-slot">
              <SidebarAction
                label="Upload kubeconfig"
                disabled={uploadBusy}
                onClick={() => fileInputRef.current?.click()}
              />
            </div>
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
          <div className="sidebar-tree-children">
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
                          <TreeDisclosure collapsed={!expanded} className="context-caret" />
                        </button>
                      )}
                      <span className="local-kubeconfig-bullet">◍</span>
                      <span>{collapsed ? item.name.charAt(0) : item.name}</span>
                    </span>
                    {!collapsed && (
                      <div className="context-meta">
                        <div className="sidebar-action-slot">
                          <SidebarAction
                            label={`Actions for ${item.name}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              setMenuLocalKubeconfigId((current) => (current === item.id ? undefined : item.id));
                            }}
                          />
                          {isMenuOpen && (
                            <SidebarContextMenu
                              actions={[{
                                label: 'Remove Config',
                                danger: true,
                                onSelect: async () => {
                                  setMenuLocalKubeconfigId(undefined);
                                  const ok = await confirm({
                                    title: uiText.confirmDialog.removeTitle,
                                    message: `Remove local kubeconfig "${item.name}" and all its contexts?`,
                                    details: 'This cannot be undone.',
                                    confirmLabel: uiText.confirmDialog.remove,
                                  });
                                  if (ok) await onDeleteLocalKubeconfig(item.id);
                                },
                              }]}
                            />
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {(collapsed || expanded) && (
                    <div className="sidebar-tree-children">
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
                                    <div className="sidebar-action-slot">
                                      <SidebarAction
                                        label={`Actions for ${ctxName}`}
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          setMenuLocalContextKey((current) => (current === stubKey ? undefined : stubKey));
                                        }}
                                      />
                                      {stubMenuOpen && (
                                        <SidebarContextMenu
                                          actions={[
                                            {
                                              label: 'Connect',
                                              onSelect: async () => {
                                              setMenuLocalContextKey(undefined);
                                              if (!isMinikubeConfig) {
                                                const ok = await ensureLocalAzureConnected(ctxName);
                                                if (!ok) return;
                                              }
                                              await onConnectLocalKubeconfig(item.id, ctxName);
                                              },
                                            },
                                            {
                                              label: 'Remove context',
                                              danger: true,
                                              onSelect: () => {
                                              setMenuLocalContextKey(undefined);
                                              removeContext();
                                              },
                                            },
                                          ]}
                                        />
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
            <TreeDisclosure collapsed={!minikubeExpanded} />
            <img src={minikubeIcon} className="svg-inject" alt="" />
            <span>{collapsed ? 'M' : 'Local Minikube'}</span>
          </button>
          <div className="sidebar-action-slot">
            <SidebarAction
              label="Minikube options"
              onClick={(event) => {
                event.stopPropagation();
                setMinikubeMenuOpen((open) => !open);
              }}
            />
            {minikubeMenuOpen && (
              <SidebarContextMenu
                actions={[{
                  label: 'Cluster Configuration',
                  onSelect: () => {
                    setMinikubeMenuOpen(false);
                    onSelect({ type: 'minikube' });
                  },
                }]}
              />
            )}
          </div>
        </div>
        {(collapsed || minikubeExpanded) && (
          <div className="sidebar-tree-children">
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
                      <TreeDisclosure collapsed={!minikubeResourcesExpanded} className="context-caret" />
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
