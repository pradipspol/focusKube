import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, setDesktopEmail } from './api/client';
import type { AzureScope, ContextScope } from './api/client';
import { TopBar } from './components/TopBar';
import { Sidebar } from './components/Sidebar';
import { ResourceTable } from './components/ResourceTable';
import { HelmPanel } from './components/HelmPanel';
import { AzurePanel } from './components/AzurePanel';
import { AwsPanel } from './components/AwsPanel';
import { ObservabilityPanel } from './components/observability/ObservabilityPanel';
import { ToastViewport, type ToastMessage } from './components/ToastViewport';
import { ApplicationsPanel } from './components/ApplicationsPanel';
import { PortForwardingPanel } from './components/PortForwardingPanel';
import { AuthGate } from './components/AuthGate';
import { CreateResourceModal } from './components/CreateResourceModal';
import {
  TerminalDock,
  type DockSession,
  type OpenPodLogsTerminalRequest,
  type OpenPodTerminalRequest,
  type TerminalSession,
} from './components/TerminalDock';
import { PermissionsProvider, capabilitiesFor } from './auth/permissions';
import type { AwsIdentity, AzureAccount, ContextsResponse, KubeContext } from './api/types';

export type View =
  | { type: 'resource'; plural: string; focusContext?: string; focusName?: string }
  | { type: 'applications' }
  | { type: 'helm'; mode: 'charts' | 'releases' }
  | { type: 'portForwarding' }
  | { type: 'logs' }
  | { type: 'observability'; tab?: 'timeline' | 'logs' | 'correlation' }
  | { type: 'azure' }
  | { type: 'aws' };

type UiRoute = 'login' | 'k8-explorer';

const ROUTE_PATHS: Record<UiRoute, string> = {
  login: '/login',
  'k8-explorer': '/k8-explorer',
};

function routeFromPath(pathname: string): UiRoute {
  if (pathname === ROUTE_PATHS.login) return 'login';
  return 'k8-explorer';
}

function pathForRoute(route: UiRoute): string {
  return ROUTE_PATHS[route];
}

interface ViewTab {
  id: string;
  label: string;
  view: View;
  originContext?: string;
  originSource?: 'aks' | 'eks' | 'local';
  originKubeconfigId?: string;
}

function contextScopeFromOriginSource(source?: 'aks' | 'eks' | 'local'): ContextScope | undefined {
  if (source === 'local') return 'local';
  if (source === 'aks') return 'azure';
  if (source === 'eks') return 'aws';
  return undefined;
}

function resolveScopeFromContext(ctx?: KubeContext): ContextScope | null {
  if (!ctx?.source?.provider) return null;
  if (ctx.source.provider === 'local') return 'local';
  if (ctx.source.provider === 'aks') return 'azure';
  if (ctx.source.provider === 'eks') return 'aws';
  return null;
}

function viewId(view: View, originContext?: string, originSource?: 'aks' | 'eks' | 'local', originKubeconfigId?: string): string {
  const sourceKey = originSource ?? 'unknown';
  const contextKey = originContext ?? 'global';
  const kubeconfigKey = originKubeconfigId ?? '';
  const suffix = kubeconfigKey ? `:${kubeconfigKey}` : '';
  if (view.type === 'resource') return `resource:${view.plural}:${sourceKey}:${contextKey}${suffix}:${view.focusContext ?? ''}:${view.focusName ?? ''}`;
  if (view.type === 'helm') return `helm:${view.mode}:${sourceKey}:${contextKey}${suffix}`;
  if (view.type === 'applications') return `applications:${sourceKey}:${contextKey}${suffix}`;
  if (view.type === 'portForwarding') return `portForwarding:${sourceKey}:${contextKey}${suffix}`;
  if (view.type === 'observability') return `observability:${view.tab ?? 'timeline'}:${sourceKey}:${contextKey}${suffix}`;
  if (view.type === 'azure') return 'azure';
  if (view.type === 'aws') return 'aws';
  return view.type;
}

function viewLabel(view: View, context?: string, originSource?: 'aks' | 'eks' | 'local'): string {
  const base =
    view.type === 'resource'
      ? view.plural.charAt(0).toUpperCase() + view.plural.slice(1)
      : view.type === 'applications'
        ? 'Applications'
      : view.type === 'helm'
        ? view.mode === 'charts' ? 'Helm Charts' : 'Helm Releases'
      : view.type === 'portForwarding'
        ? 'Port Forwarding'
      : view.type === 'logs'
        ? 'Logs'
      : view.type === 'observability'
        ? 'Observability'
      : view.type === 'azure'
        ? 'Azure / AKS Connections'
      : view.type === 'aws'
        ? 'AWS / EKS Connections'
      : 'Unknown';
  // Azure and logs views aren't context-scoped, so don't append the context name.
  if (view.type === 'azure' || view.type === 'logs' ) return base;
  return context ? `${base} - ${context}` : base;
}

const TABS_STORAGE_KEY = 'k8sExplorer.openTabs';
const ACTIVE_TAB_STORAGE_KEY = 'k8sExplorer.activeTab';
const NAMESPACE_SELECTIONS_STORAGE_KEY = 'k8sExplorer.namespacesByContext';
// Where the footer "Support" button points. Update to your team's support channel.
const SUPPORT_URL = 'mailto:support@k8-explorer.local?subject=K8S%20Explorer%20Support';

function isView(value: unknown): value is View {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; plural?: unknown; mode?: unknown; provider?: unknown; tab?: unknown };
  if (candidate.type === 'resource') return typeof candidate.plural === 'string' && candidate.plural.length > 0;
  if (candidate.type === 'helm') return candidate.mode === 'charts' || candidate.mode === 'releases';
  if (candidate.type === 'observability') {
    return candidate.tab === undefined || candidate.tab === 'timeline' || candidate.tab === 'logs' || candidate.tab === 'correlation';
  }
  if (candidate.type === 'azure') {
    return true;
  }
  return candidate.type === 'applications' || candidate.type === 'portForwarding' || candidate.type === 'logs' || candidate.type === 'azure' || candidate.type === 'aws';
}

function loadStoredTabs(): ViewTab[] {
  try {
    const raw = localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const tabs: ViewTab[] = [];
    for (const item of parsed) {
      const tab = item && typeof item === 'object' && 'view' in item ? (item as ViewTab) : undefined;
      const view = tab?.view ?? (isView(item) ? (item as View) : undefined);
      if (!view) continue;
      const id = typeof tab?.id === 'string' && tab.id.length > 0
        ? tab.id
        : viewId(view, tab?.originContext, tab?.originSource);
      if (seen.has(id)) continue;
      seen.add(id);
      tabs.push({
        id,
        label: viewLabel(view, tab?.originContext),
        view,
        originContext: tab?.originContext,
        originSource: tab?.originSource,
        originKubeconfigId: tab?.originKubeconfigId,
      });
    }
    return tabs;
  } catch {
    return [];
  }
}

function loadStoredActiveTabId(tabs: ViewTab[]): string {
  const stored = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY) ?? '';
  if (tabs.some((tab) => tab.id === stored)) return stored;
  return tabs[0]?.id ?? '';
}

type NamespaceSelections = Record<string, string[]>;

function loadStoredNamespaceSelections(): NamespaceSelections {
  try {
    const raw = localStorage.getItem(NAMESPACE_SELECTIONS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const selections: NamespaceSelections = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      selections[key] = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    }
    return selections;
  } catch {
    return {};
  }
}

function loadLegacyNamespaceSelection(): string[] {
  try {
    const raw = localStorage.getItem('k8sExplorer.namespaces');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
      }
    }
  } catch {
    // ignore invalid legacy value
  }

  const legacy = localStorage.getItem('k8sExplorer.namespace') || '';
  return legacy ? [legacy] : [];
}

function namespacesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function namespaceSelectionKeyForContext(
  tab?: ViewTab,
  contextEntry?: KubeContext,
  fallbackContext?: string,
): string {
  const sourceProvider = tab?.originSource ?? contextEntry?.source?.provider;
  const contextName = tab?.originContext ?? contextEntry?.name ?? fallbackContext ?? 'unknown';

  if (sourceProvider === 'local') {
    return `LOCAL/${tab?.originKubeconfigId ?? 'unknown'}/${contextName}`;
  }

  if (sourceProvider === 'eks') {
    return `AWS/${contextEntry?.source?.region ?? 'unknown'}/${contextEntry?.source?.clusterName ?? contextName}`;
  }

  if (sourceProvider === 'aks') {
    return `AZURE/${contextEntry?.source?.subscriptionId ?? contextEntry?.source?.subscriptionName ?? 'unknown'}/${contextEntry?.source?.resourceGroup ?? 'unknown'}/${contextEntry?.source?.clusterName ?? contextName}`;
  }

  return `GLOBAL/${contextName}`;
}

export default function App() {
  const queryClient = useQueryClient();
  const [route, setRoute] = useState<UiRoute>(() => routeFromPath(window.location.pathname));
  const SIDEBAR_DEFAULT_WIDTH_VW = 15;
  const SIDEBAR_MIN_WIDTH_VW = 12;
  const SIDEBAR_MAX_WIDTH_VW = 30;
  const [context, setContext] = useState<string | undefined>();
  const [contextInitialized, setContextInitialized] = useState(false);
  const [namespaceSelections, setNamespaceSelections] = useState<NamespaceSelections>(() => loadStoredNamespaceSelections());
  const [tabs, setTabs] = useState<ViewTab[]>(() => loadStoredTabs());
  const [activeTabId, setActiveTabId] = useState<string>(() => loadStoredActiveTabId(loadStoredTabs()));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('k8sExplorer.sidebarCollapsed') === 'true';
  });
  const [sidebarWidthVw, setSidebarWidthVw] = useState<number>(() => {
    const rawVw = Number(localStorage.getItem('k8sExplorer.sidebarWidthVw'));
    if (Number.isFinite(rawVw)) {
      return Math.min(SIDEBAR_MAX_WIDTH_VW, Math.max(SIDEBAR_MIN_WIDTH_VW, rawVw));
    }

    // Migrate old px-based preference to vw.
    const rawPx = Number(localStorage.getItem('k8sExplorer.sidebarWidth'));
    if (Number.isFinite(rawPx) && typeof window !== 'undefined' && window.innerWidth > 0) {
      const vw = (rawPx / window.innerWidth) * 100;
      return Math.min(SIDEBAR_MAX_WIDTH_VW, Math.max(SIDEBAR_MIN_WIDTH_VW, vw));
    }

    return SIDEBAR_DEFAULT_WIDTH_VW;
  });
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [createResourceOpen, setCreateResourceOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const [terminalHeightPx, setTerminalHeightPx] = useState<number>(() => {
    const raw = Number(localStorage.getItem('k8sExplorer.terminalHeightPx'));
    if (Number.isFinite(raw)) return Math.min(520, Math.max(180, raw));
    return 280;
  });
  const [terminalMinimized, setTerminalMinimized] = useState<boolean>(() => localStorage.getItem('k8sExplorer.terminalMinimized') === 'true');
  const terminalSessionCounterRef = useRef(1);
  const [terminalSessions, setTerminalSessions] = useState<DockSession[]>(() => []);
  const [activeTerminalSessionId, setActiveTerminalSessionId] = useState('');

  const navigateToRoute = (nextRoute: UiRoute, replace = false) => {
    const nextPath = pathForRoute(nextRoute);
    if (replace) {
      window.history.replaceState({}, '', nextPath);
    } else {
      window.history.pushState({}, '', nextPath);
    }
    setRoute(nextRoute);
  };

  const authQuery = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: async () => {
      try {
        const response = await api.authMe();
        if (response.user?.email) {
          setDesktopEmail(response.user.email);
        }
        return response.user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          return null;
        }
        throw err;
      }
    },
    retry: false,
  });

  const user = authQuery.data ?? null;

  const updateContextsCache = (updater: (current?: ContextsResponse) => ContextsResponse | undefined) => {
    queryClient.setQueryData<ContextsResponse>(['contexts'], (current) => updater(current));
  };

  const contextsQuery = useQuery({
    queryKey: ['contexts'],
    queryFn: api.getContexts,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: !!user,
  });

  const [azureCloudAccount, setAzureCloudAccount] = useState<AzureAccount | null>(null);
  const [awsIdentity, setAwsIdentity] = useState<AwsIdentity | null>(null);
  const [azureAuthSource, setAzureAuthSource] = useState<AzureScope | null>(null);

  const resolveScopeSource = async (contextName?: string): Promise<ContextScope | null> => {
    if (!contextName) return null;

    const sourceFromContext = (ctx?: KubeContext): ContextScope | null => {
      if (!ctx?.source?.provider) return null;
      if (ctx.source.provider === 'local') return 'local';
      if (ctx.source.provider === 'aks') return 'azure';
      if (ctx.source.provider === 'eks') return 'aws';
      return null;
    };

    const resolveFrom = (payload?: ContextsResponse): ContextScope | null => {
      if (!payload) return null;
      const ctx = payload.contexts.find((entry) => entry.name === contextName);
      return sourceFromContext(ctx);
    };

    const fromCache = resolveFrom(contextsQuery.data);
    if (fromCache) return fromCache;

    try {
      const fresh = await api.getContexts();
      queryClient.setQueryData(['contexts'], fresh);
      return resolveFrom(fresh);
    } catch {
      return null;
    }
  };

  const activeContextSource = useMemo<ContextScope | null>(() => {
    if (!context) return null;
    const ctx = contextsQuery.data?.contexts.find((entry) => entry.name === context);
    if (!ctx?.source?.provider) return null;
    if (ctx.source.provider === 'local') return 'local';
    if (ctx.source.provider === 'aks') return 'azure';
    if (ctx.source.provider === 'eks') return 'aws';
    return null;
  }, [contextsQuery.data, context]);

  // Azure-specific queries never understand an 'aws' scope — fall back to 'cloud' for them.
  const effectiveAzureScope: AzureScope = azureAuthSource ?? (activeContextSource === 'local' ? 'local' : 'cloud');

  const awsSignedIn = !!awsIdentity;

  // Bumped whenever an Azure account is added/removed so the sidebar re-pulls its tree.
  const [azureTreeRefresh, setAzureTreeRefresh] = useState(0);
  // Bumped whenever the AWS account is added/removed so the sidebar re-pulls its tree.
  const [awsTreeRefresh, setAwsTreeRefresh] = useState(0);
  // Bumped after successful Azure sign-in so already-open resource tabs refetch.
  const [azureAuthRecoveryRefresh, setAzureAuthRecoveryRefresh] = useState(0);

  const namespacesQuery = useQuery({
    queryKey: ['namespaces', context],
    queryFn: () => api.listResource('namespaces', { context, attributes: 'name' }),
    enabled: !!context,
  });

  useEffect(() => {
    if (contextInitialized || !contextsQuery.data) return;
    if (contextsQuery.data.active) {
      setContext(contextsQuery.data.active);
    } else if ((contextsQuery.data.contexts?.length ?? 0) > 0) {
      setContext(contextsQuery.data.contexts[0].name);
    }
    setContextInitialized(true);
  }, [contextsQuery.data, contextInitialized]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.sidebarWidthVw', String(sidebarWidthVw));
  }, [sidebarWidthVw]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.terminalHeightPx', String(terminalHeightPx));
  }, [terminalHeightPx]);

  useEffect(() => {
    localStorage.setItem('k8sExplorer.terminalMinimized', String(terminalMinimized));
  }, [terminalMinimized]);

  const openGeneralTerminal = () => {
    setTerminalMinimized(false);
    const index = terminalSessionCounterRef.current++;
    const session: TerminalSession = {
      id: `terminal:${index}`,
      kind: 'general',
      title: `Terminal ${index}`,
    };
    setTerminalSessions((current) => [...current, session]);
    setActiveTerminalSessionId(session.id);
  };

  const openPodTerminal = (request: OpenPodTerminalRequest) => {
    setTerminalMinimized(false);
    const index = terminalSessionCounterRef.current++;
    const session: TerminalSession = {
      id: `terminal:${index}`,
      kind: 'pod',
      title: `${request.podName} · ${request.container}`,
      context: request.context,
      namespace: request.namespace,
      podName: request.podName,
      container: request.container,
      shell: request.shell,
    };
    setTerminalSessions((current) => [...current, session]);
    setActiveTerminalSessionId(session.id);
  };

  const openPodLogsTerminal = (request: OpenPodLogsTerminalRequest) => {
    setTerminalMinimized(false);
    const index = terminalSessionCounterRef.current++;
    const podName = request.pod.metadata?.name ?? 'Pod';
    const namespace = request.pod.metadata?.namespace;
    const session: DockSession = {
      id: `terminal:${index}`,
      kind: 'logs',
      source: 'pod',
      title: namespace ? `${namespace} / ${podName} logs` : `${podName} logs`,
      pod: request.pod,
      context: request.context,
      follow: request.follow,
    };
    setTerminalSessions((current) => [...current, session]);
    setActiveTerminalSessionId(session.id);
  };

  const closeTerminalSession = (id: string) => {
    setTerminalSessions((current) => {
      const next = current.filter((session) => session.id !== id);
      if (next.length === 0) {
        setActiveTerminalSessionId('');
        terminalSessionCounterRef.current = 1;
        return next;
      }

      if (id === activeTerminalSessionId) {
        const index = current.findIndex((session) => session.id === id);
        const fallback = next[Math.max(0, index - 1)] ?? next[0];
        setActiveTerminalSessionId(fallback.id);
      }

      return next;
    });
  };

  useEffect(() => {
    const syncRouteFromLocation = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener('popstate', syncRouteFromLocation);
    return () => window.removeEventListener('popstate', syncRouteFromLocation);
  }, []);

  useEffect(() => {
    if (authQuery.isLoading) return;
    if (!user) {
      if (route !== 'login') {
        navigateToRoute('login', true);
      }
      return;
    }

    if (route === 'login') {
      activateExplorerRoute();
      return;
    }

    if (route !== 'k8-explorer') {
      activateExplorerRoute();
    }
  }, [authQuery.isLoading, route, user]);

  useEffect(() => {
    const root = document.documentElement;

    const applyAutoFit = () => {
      const widthScale = Math.min(1, Math.max(0.9, window.innerWidth / 1600));
      const heightScale = Math.min(1, Math.max(0.88, window.innerHeight / 1000));
      const scale = Math.min(widthScale, heightScale);
      const compact = scale < 0.97 || window.innerHeight < 860 ? '1' : '0';

      root.style.setProperty('--fit-scale', scale.toFixed(3));
      root.style.setProperty('--fit-compact', compact);
    };

    applyAutoFit();
    window.addEventListener('resize', applyAutoFit);
    return () => window.removeEventListener('resize', applyAutoFit);
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activeAzureTabId = activeTab?.view.type === 'azure' ? activeTab.id : undefined;
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  const contexts = contextsQuery.data?.contexts ?? [];
  const localKubeconfigs = contextsQuery.data?.localKubeconfigs ?? [];
  const activeContextEntry = activeTab?.originContext
    ? contextsQuery.data?.contexts.find((entry) => entry.name === activeTab.originContext)
    : context
      ? contextsQuery.data?.contexts.find((entry) => entry.name === context)
      : undefined;
  const requestScope = useMemo(
    () => ({ context, source: activeContextSource ?? undefined }),
    [context, activeContextSource],
  );
  const scope = requestScope;
  const namespaceSelectionKey = useMemo(
    () => namespaceSelectionKeyForContext(activeTab, activeContextEntry, context),
    [activeTab, activeContextEntry, context],
  );
  const selectedNamespaces = namespaceSelections[namespaceSelectionKey] ?? [];
  const namespace = selectedNamespaces.length === 1 ? selectedNamespaces[0] : undefined;
  const namespacesForTab = (tab?: ViewTab) => {
    const tabContext = tab?.originContext ?? context;
    const tabSource = tab?.originSource
      ? contextScopeFromOriginSource(tab.originSource)
      : tabContext
        ? resolveScopeFromContext(contextsQuery.data?.contexts.find((entry) => entry.name === tabContext))
        : activeContextSource ?? undefined;
    const tabContextEntry = tabContext
      ? contextsQuery.data?.contexts.find((entry) => entry.name === tabContext)
      : undefined;
    const tabSelectionKey = namespaceSelectionKeyForContext(tab, tabContextEntry, tabContext);
    return {
      context: tabContext,
      namespace: namespaceSelections[tabSelectionKey]?.length === 1 ? namespaceSelections[tabSelectionKey][0] : undefined,
      source: tabSource ?? undefined,
    };
  };
  const scopeForTab = (tab?: ViewTab) => {
    return namespacesForTab(tab);
  };
  const activeTabScope = useMemo(() => scopeForTab(activeTab), [activeTab, context, namespace, activeContextSource, contextsQuery.data]);
  const azureSignedIn = !!azureCloudAccount;
  const namespaces = useMemo(
    () => (namespacesQuery.data?.items ?? []).map((n) => n.name || n.metadata?.name).filter(Boolean) as string[],
    [namespacesQuery.data],
  );

  useEffect(() => {
    if (!namespaceSelectionKey) return;
    if (namespaceSelections[namespaceSelectionKey] !== undefined) return;

    const legacy = loadLegacyNamespaceSelection();
    if (legacy.length === 0) return;

    setNamespaceSelections((current) => {
      if (current[namespaceSelectionKey] !== undefined) return current;
      return { ...current, [namespaceSelectionKey]: legacy };
    });
  }, [namespaceSelectionKey, namespaceSelections]);

  useEffect(() => {
    localStorage.setItem(NAMESPACE_SELECTIONS_STORAGE_KEY, JSON.stringify(namespaceSelections));
  }, [namespaceSelections]);

  // Keep the active tab visible in the horizontal tab strip when it changes.
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  // Dismiss the tab context menu on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTabMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabMenu]);

  useEffect(() => {
    try {
      localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTabId);
    } catch {
      // ignore storage write failures (e.g. private mode quota)
    }
  }, [tabs, activeTabId]);

  // Keep global active context aligned with the active context-scoped tab.
  useEffect(() => {
    const tabContext = activeTab?.originContext;
    if (!tabContext || tabContext === context) return;
    void handleContextChange(tabContext);
  }, [activeTabId]);

  const openView = (
    view: View,
    originContext?: string,
    originSource?: 'aks' | 'eks' | 'local',
    originKubeconfigId?: string,
  ) => {
    const resolvedOriginSource = originSource ?? (originContext
      ? (contextsQuery.data?.contexts.find((ctx) => ctx.name === originContext)?.source?.provider as 'aks' | 'eks' | 'local' | undefined)
      : undefined);
    const id = viewId(view, originContext, resolvedOriginSource, originKubeconfigId);
    setTabs((current) => {
      if (current.some((tab) => tab.id === id)) {
        return current.map((tab) => {
          if (tab.id !== id) return tab;
          const nextOriginContext = originContext ?? tab.originContext;
          const nextOriginSource = resolvedOriginSource ?? tab.originSource;
          const nextOriginKubeconfigId = originKubeconfigId ?? tab.originKubeconfigId;
          return {
            ...tab,
            label: viewLabel(view, nextOriginContext, nextOriginSource),
            originContext: nextOriginContext,
            originSource: nextOriginSource,
            originKubeconfigId: nextOriginKubeconfigId,
          };
        });
      }
      return [
        ...current,
        {
          id,
          label: viewLabel(view, originContext, resolvedOriginSource),
          view,
          originContext,
          originSource: resolvedOriginSource,
          originKubeconfigId,
        },
      ];
    });
    setActiveTabId(id);
  };

  const closeTabsByOriginSource = (originSource: 'aks' | 'eks' | 'local') => {
    setTabs((current) => {
      const next = current.filter((tab) => {
        if (!tab.originSource) return true;
        return tab.originSource !== originSource;
      });
      if (!next.some((tab) => tab.id === activeTabId)) {
        setActiveTabId(next[0]?.id ?? '');
      }
      return next;
    });
  };

  const closeTabsByLocalConfig = (kubeconfigId: string, contextNames: string[] = []) => {
    const contextSet = new Set(contextNames);
    setTabs((current) => {
      const next = current.filter((tab) => {
        if (tab.originKubeconfigId === kubeconfigId) return false;
        if (tab.originSource === 'local' && tab.originContext && contextSet.has(tab.originContext)) return false;
        return true;
      });
      if (!next.some((tab) => tab.id === activeTabId)) {
        setActiveTabId(next[0]?.id ?? '');
      }
      return next;
    });
  };

  const closeTab = (id: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (id === activeTabId) {
        const fallback = next[Math.max(0, index - 1)] ?? next[0];
        setActiveTabId(fallback?.id ?? '');
      }
      return next;
    });
  };

  const closeOtherTabs = (id: string) => {
    setTabs((current) => current.filter((tab) => tab.id === id));
    setActiveTabId(id);
  };

  const closeAllTabs = () => {
    setTabs([]);
    setActiveTabId('');
  };

  const activateExplorerRoute = () => {
    setTabMenu(null);
    navigateToRoute('k8-explorer');
  };

  const openAzureAuthPanel = (source?: 'local' | 'cloud') => {
    setTabMenu(null);
    if (source === 'local' || source === 'cloud') {
      setAzureAuthSource(source);
    }
    if (source === 'local') {
      const localContext = context ?? contexts.find((ctx) => ctx.source?.provider === 'local')?.name;
      if (localContext && localContext !== context) {
        void handleContextChange(localContext);
      }
    }
    openView({ type: 'azure' });
  };

  const openCloudAzureView = () => {
    setTabMenu(null);
    setAzureAuthSource('cloud');
    openView({ type: 'azure' });
  };

  const openCloudAwsView = () => {
    setTabMenu(null);
    openView({ type: 'aws' });
  };

  const openResourceView = (
    plural: string,
    originContext?: string,
    originSource?: 'aks' | 'eks' | 'local',
    originKubeconfigId?: string,
  ) => {
    openView(
      {
        type: 'resource',
        plural,
        focusContext: originContext ?? context,
        focusName: originContext ?? context,
      },
      originContext,
      originSource,
      originKubeconfigId,
    );
  };

  const pushToast = (tone: ToastMessage['tone'], text: string, durationMs = 3200) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setToasts((current) => [...current, { id, tone, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, durationMs);
  };

  const handleContextChange = async (name?: string) => {
    if (!name) {
      setContext(undefined);
      await api.clearActiveContext();
      updateContextsCache((current) =>
        current
          ? {
              ...current,
              active: undefined,
              contexts: current.contexts.map((ctx) => ({ ...ctx, active: false })),
            }
          : current,
      );
      return;
    }

    const source = await resolveScopeSource(name);
    if (!source) {
      pushToast('error', `Unable to resolve source for context ${name}. Refresh contexts and retry.`);
      return;
    }
    await api.setActiveContext(name, source);
    setContext(name);
    updateContextsCache((current) =>
      current
        ? {
            ...current,
            active: name,
            contexts: current.contexts.map((ctx) => ({ ...ctx, active: ctx.name === name })),
          }
        : current,
    );
  };

  const handleSelectedNamespacesChange = (next: string[]) => {
    setNamespaceSelections((current) => {
      if (namespacesEqual(current[namespaceSelectionKey] ?? [], next)) return current;
      return {
        ...current,
        [namespaceSelectionKey]: next,
      };
    });
  };

  const handleSignOut = async () => {
    await api.authSignOut();
    localStorage.removeItem('k8sExplorer.desktopEmail');
    setContext(undefined);
    setContextInitialized(false);
    queryClient.setQueryData(['auth', 'me'], null);
    queryClient.removeQueries({ queryKey: ['contexts'] });
    await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
    navigateToRoute('login', true);
  };

  const handleAzureSignOut = async () => {
    closeTabsByOriginSource('aks');
    await api.azureLogout(undefined, effectiveAzureScope);
    setAzureCloudAccount(null);
    setAzureAuthSource(null);
    queryClient.setQueryData(['azure', 'account', 'local'], { account: null });
    queryClient.setQueryData(['azure', 'account', 'cloud'], { account: null });
    await queryClient.invalidateQueries({ queryKey: ['azure', 'account'] });
    await queryClient.invalidateQueries({ queryKey: ['azure', 'subscriptions'] });
  };

  const handleAwsSignOut = async () => {
    closeTabsByOriginSource('eks');
    await api.awsLogout();
    setAwsIdentity(null);
    queryClient.setQueryData(['aws', 'account'], { account: null });
    await queryClient.invalidateQueries({ queryKey: ['aws', 'account'] });
    await queryClient.invalidateQueries({ queryKey: ['aws', 'eks'] });
  };

  const handleUploadLocalKubeconfig = async (name: string, content: string) => {
    const updated = await api.uploadLocalKubeconfig(name, content);
    queryClient.setQueryData(['contexts'], updated);
    pushToast('success', `Uploaded ${name}`);
  };

  const handleConnectLocalKubeconfig = async (id: string, preferredContext?: string) => {
    const updated = await api.connectLocalKubeconfig(id, preferredContext);
    queryClient.setQueryData(['contexts'], updated);
    if (updated.active) {
      setContext(updated.active);
      pushToast('success', `Connected ${updated.active}`);
      return;
    }
    setContext(undefined);
    pushToast('info', 'Kubeconfig loaded, but no usable context was found.');
  };

  const handleDeleteLocalKubeconfig = async (id: string) => {
    const localConfig = contextsQuery.data?.localKubeconfigs?.find((item) => item.id === id);
    closeTabsByLocalConfig(id, localConfig?.contexts ?? []);
    const updated = await api.deleteLocalKubeconfig(id);
    queryClient.setQueryData(['contexts'], updated);
    setContext(updated.active);
    pushToast('success', 'Removed local kubeconfig');
  };

  const handleDeleteLocalKubeconfigContext = async (id: string, contextName: string) => {
    closeTabsByLocalConfig(id, [contextName]);
    const updated = await api.deleteLocalKubeconfigContext(id, contextName);
    queryClient.setQueryData(['contexts'], updated);
    if (!updated.active) setContext(undefined);
    pushToast('success', `Removed context ${contextName}`);
  };

  const startSidebarResize = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidthVw = sidebarWidthVw;

    const onMove = (moveEvent: MouseEvent) => {
      const viewportWidth = Math.max(window.innerWidth, 1);
      const deltaVw = ((moveEvent.clientX - startX) / viewportWidth) * 100;
      const nextWidthVw = startWidthVw + deltaVw;
      setSidebarWidthVw(Math.min(SIDEBAR_MAX_WIDTH_VW, Math.max(SIDEBAR_MIN_WIDTH_VW, nextWidthVw)));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (authQuery.isLoading) {
    return <div className="auth-loading">Loading...</div>;
  }

  if (!user) {
    return <AuthGate onSignedIn={activateExplorerRoute} />;
  }

  const permissions = capabilitiesFor(user.role);

  return (
    <PermissionsProvider value={permissions}>
    <div className="app">
      <TopBar
        user={user}
        onContextsRefetch={() => contextsQuery.refetch()}
        onSignOut={handleSignOut}
      />
      <div
        className={`body ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
        style={{ ['--sidebar-width' as any]: `${sidebarWidthVw}vw` }}
      >
        <Sidebar
          view={activeTab?.view}
          activeTabOriginContext={activeTab?.originContext}
          activeTabOriginSource={activeTab?.originSource}
          activeTabOriginKubeconfigId={activeTab?.originKubeconfigId}
          onSelect={openView}
          onOpenExplorer={activateExplorerRoute}
          scope={scope}
          contexts={contexts}
          localKubeconfigs={localKubeconfigs}
          azureSignedIn={azureSignedIn}
          azureRefreshToken={azureTreeRefresh}
          awsSignedIn={awsSignedIn}
          awsRefreshToken={awsTreeRefresh}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
          onContextChange={handleContextChange}
          onUploadLocalKubeconfig={handleUploadLocalKubeconfig}
          onConnectLocalKubeconfig={handleConnectLocalKubeconfig}
          onDeleteLocalKubeconfig={handleDeleteLocalKubeconfig}
          onDeleteLocalKubeconfigContext={handleDeleteLocalKubeconfigContext}
          onAzureSignOut={handleAzureSignOut}
          onOpenCloudAzureView={openCloudAzureView}
          onAwsSignOut={handleAwsSignOut}
          onOpenCloudAwsView={openCloudAwsView}
        />
        <div
          className="sidebar-resizer"
          onMouseDown={startSidebarResize}
          title="Drag to resize sidebar"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
        />
        <div className={`main ${tabs.length === 0 ? 'main-empty' : ''}`}>
            <div className="main-workspace">
              <div className="main-content">
                {tabs.length > 0 && (
                  <div className="main-tabs">
                    <div className="main-tabs-list">
                      {tabs.map((tab) => (
                        <div
                          key={tab.id}
                          ref={tab.id === activeTabId ? activeTabRef : undefined}
                          className={`main-tab ${tab.id === activeTabId ? 'active' : ''}`}
                          onClick={() => {
                            setActiveTabId(tab.id);
                            if (tab.originContext && tab.originContext !== context) {
                              void handleContextChange(tab.originContext);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setTabMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
                          }}
                          title={tab.originSource ? `${tab.label} • ${tab.originSource.toUpperCase()}` : tab.label}
                        >
                          <span className="main-tab-label">{tab.label}</span>
                          <button
                            className="main-tab-close"
                            title={`Close ${tab.label}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              closeTab(tab.id);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="main-content-body">
                  {tabs.length === 0 && (
                    <div className="main-empty-state" aria-label="empty workspace">
                      <div className="main-empty-brand">K8S Explorer</div>
                    </div>
                  )}

                  {tabs.map((tab) => (
                    tab.view.type === 'resource' ? (
                      (() => {
                        const tabScope = scopeForTab(tab);
                        return (
                      <div
                        key={`resource-panel:${tab.id}`}
                        style={{ display: tab.id === activeTabId ? 'block' : 'none', height: '100%' }}
                      >
                        <ResourceTable
                          watchKey={`tab:${tab.id}`}
                          plural={tab.view.plural}
                          scope={tabScope}
                          focusContext={tab.view.focusContext}
                          focusName={tab.view.focusName}
                          authRecoveryRefreshToken={azureAuthRecoveryRefresh}
                          namespaces={namespaces}
                          selectedNamespaces={selectedNamespaces}
                          onSelectedNamespacesChange={handleSelectedNamespacesChange}
                          onAddResource={() => setCreateResourceOpen(true)}
                          onToast={pushToast}
                          onAzureAuthRequired={openAzureAuthPanel}
                          onOpenPodTerminal={openPodTerminal}
                          onOpenPodLogsTerminal={openPodLogsTerminal}
                        />
                      </div>
                        );
                      })()
                    ) : null
                  ))}
                  {activeTab?.view.type === 'applications' && (
                    <ApplicationsPanel
                      scope={activeTabScope}
                      authRecoveryRefreshToken={azureAuthRecoveryRefresh}
                      namespaces={namespaces}
                      selectedNamespaces={selectedNamespaces}
                      onSelectedNamespacesChange={handleSelectedNamespacesChange}
                      onAzureAuthRequired={openAzureAuthPanel}
                    />
                  )}
                  {activeTab?.view.type === 'helm' && (
                    <HelmPanel
                      scope={activeTabScope}
                      mode={activeTab.view.mode}
                      authRecoveryRefreshToken={azureAuthRecoveryRefresh}
                      namespaces={namespaces}
                      selectedNamespaces={selectedNamespaces}
                      onSelectedNamespacesChange={handleSelectedNamespacesChange}
                      onAzureAuthRequired={openAzureAuthPanel}
                      onToast={pushToast}
                    />
                  )}
                  {activeTab?.view.type === 'portForwarding' && (
                    <PortForwardingPanel
                      scope={activeTabScope}
                      authRecoveryRefreshToken={azureAuthRecoveryRefresh}
                      onAzureAuthRequired={openAzureAuthPanel}
                    />
                  )}
                  {activeTab?.view.type === 'azure' && (
                    <AzurePanel
                      onContextsChanged={async () => {
                        const refreshed = await api.getContexts();
                        queryClient.setQueryData(['contexts'], refreshed);
                      }}
                      onPickContext={(name) => {
                        void handleContextChange(name);
                      }}
                      azureSource={activeTab.originSource === 'local' ? 'local' : azureAuthSource ?? (activeContextSource === 'local' ? 'local' : 'cloud')}
                      onAccountsChanged={(account, scope) => {
                        setAzureAuthSource(null);
                        queryClient.setQueryData(['azure', 'account'], account);
                        // Cache account in the scope-specific query key
                        if (scope) {
                          queryClient.setQueryData(['azure', 'account', scope], { account });
                        }
                        if (scope === 'cloud') {
                          setAzureCloudAccount(account);
                        }
                        queryClient.invalidateQueries({ queryKey: ['azure', 'subscriptions'] });
                        queryClient.invalidateQueries({ queryKey: ['azure', 'aks'] });
                        if (!account) {
                          closeTabsByOriginSource('aks');
                          return;
                        }
                        setAzureTreeRefresh((n) => n + 1);
                        setAzureAuthRecoveryRefresh((n) => n + 1);
                        pushToast('success', 'Sign in successful. Load context now.', 4000);
                        void queryClient.invalidateQueries({ queryKey: ['contexts'] });
                      }}
                    />
                  )}
                  {activeTab?.view.type === 'aws' && (
                    <AwsPanel
                      onContextsChanged={async () => {
                        const refreshed = await api.getContexts();
                        queryClient.setQueryData(['contexts'], refreshed);
                      }}
                      onPickContext={(name) => {
                        void handleContextChange(name);
                      }}
                      onAwsAccountsChanged={(identity) => {
                        setAwsIdentity(identity);
                        queryClient.setQueryData(['aws', 'account'], { account: identity });
                        queryClient.invalidateQueries({ queryKey: ['aws', 'eks'] });
                        if (!identity) {
                          closeTabsByOriginSource('eks');
                          return;
                        }
                        setAwsTreeRefresh((n) => n + 1);
                        setAzureAuthRecoveryRefresh((n) => n + 1);
                        pushToast('success', 'Sign in successful. Load context now.', 4000);
                        void queryClient.invalidateQueries({ queryKey: ['contexts'] });
                      }}
                    />
                  )}
                  {activeTab?.view.type === 'observability' && (
                    <ObservabilityPanel
                      scope={scope}
                      namespaces={namespaces}
                      selectedNamespaces={selectedNamespaces}
                      onToast={pushToast}
                    />
                  )}
                </div>
              </div>

              <TerminalDock
                scope={scope}
                heightPx={terminalHeightPx}
                onHeightChange={setTerminalHeightPx}
                minimized={terminalMinimized}
                onMinimizedChange={setTerminalMinimized}
                sessions={terminalSessions}
                activeSessionId={activeTerminalSessionId}
                onActivateSession={setActiveTerminalSessionId}
                onNewSession={openGeneralTerminal}
                onCloseSession={closeTerminalSession}
              />
            </div>
        </div>
      </div>
      <footer className="app-footer">
        <a
          className="footer-support-button"
          href={SUPPORT_URL}
          target="_blank"
          rel="noreferrer"
          title="Get support"
        >
          <span aria-hidden="true">🛟</span>
          <span>Support</span>
        </a>
      </footer>
      {createResourceOpen && (
        <CreateResourceModal
          scope={scope}
          resourceType={activeTab?.view.type === 'resource' ? activeTab.view.plural : undefined}
          onClose={() => setCreateResourceOpen(false)}
          onToast={pushToast}
        />
      )}
      {tabMenu && (
        <div
          className="action-menu tab-context-menu"
          style={{ top: tabMenu.y, left: tabMenu.x }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            className="action-menu-item"
            onClick={() => {
              closeTab(tabMenu.tabId);
              setTabMenu(null);
            }}
          >
            Close tab
          </button>
          <button
            className="action-menu-item"
            disabled={tabs.length <= 1}
            onClick={() => {
              closeOtherTabs(tabMenu.tabId);
              setTabMenu(null);
            }}
          >
            Close other tabs
          </button>
          <button
            className="action-menu-item"
            onClick={() => {
              closeAllTabs();
              setTabMenu(null);
            }}
          >
            Close all tabs
          </button>
        </div>
      )}
      <ToastViewport toasts={toasts} />
    </div>
    </PermissionsProvider>
  );
}
