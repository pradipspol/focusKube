import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AzureScope } from '../api/client';
import type { AksCluster, AzureAccount, AzureAccountGroup } from '../api/types';
import { uiText } from '../text';

interface Props {
  azureSource?: AzureScope;
  onContextsChanged: () => Promise<void> | void;
  onPickContext: (name: string) => Promise<void> | void;
  /** Called when the set of signed-in Azure accounts changes (login/logout). */
  onAccountsChanged?: (account: AzureAccount | null, scope?: AzureScope) => void;
  /**
   * Called whenever the sidebar's own Azure account tree needs to catch up with this panel -
   * after signing one account out (so its sidebar entry disappears) or on an explicit refresh
   * (so an account this panel already sees, but the sidebar's own probe missed, appears there).
   */
  onAzureAccountsRefresh?: (scope: AzureScope) => void;
  /** One account signed out; `removedContexts` are the imported contexts removed with it. */
  onAzureAccountSignedOut?: (email: string, removedContexts: string[]) => void;
}

export function AzurePanel({
  azureSource = 'cloud',
  onContextsChanged,
  onPickContext,
  onAccountsChanged,
  onAzureAccountsRefresh,
  onAzureAccountSignedOut,
}: Props) {
  const qc = useQueryClient();
  const [subscription, setSubscription] = useState<string>('');
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [polling, setPolling] = useState(false);
  const [watchLoginStatus, setWatchLoginStatus] = useState(true);
  const [awaitingAzureAccount, setAwaitingAzureAccount] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  const account = useQuery({
    queryKey: ['azure', 'account', azureSource],
    queryFn: () => api.azureAccount(azureSource),
    enabled: true,
    refetchInterval: awaitingAzureAccount ? 1500 : false,
  });
  const accounts = useQuery({
    queryKey: ['azure', 'accounts', azureSource],
    queryFn: () => api.azureAccounts(azureSource),
    enabled: true,
    refetchInterval: awaitingAzureAccount ? 1500 : false,
  });
  // `account` (GET /azure/account) is a single-account probe - in a multi-account world it
  // can only ever report one arbitrarily-picked signed-in identity. `accounts` (GET
  // /azure/accounts) is the authoritative multi-account source and already covers the
  // legacy pre-registration fallback too, so prefer it; `account` stays as a secondary
  // signal only to avoid narrowing `loggedIn` while `accounts` is still loading.
  const loggedIn = !!account.data?.account || (accounts.data?.accounts?.length ?? 0) > 0;

  const login = useMutation({
    mutationFn: () => api.azureLogin(azureSource),
    onMutate: () => {
      setMessage('');
      setMessageIsError(false);
      setAwaitingAzureAccount(false);
      setWatchLoginStatus(true);
      setPolling(true);
      qc.removeQueries({ queryKey: ['azure-login-status'] });
      // Deliberately does NOT invalidate ['azure','account']/['azure','accounts'] here.
      // Starting a new device-code login (whether "Add Azure account" or reconnecting) never
      // changes any ALREADY-registered account's data until it actually succeeds - the
      // 'succeeded' effect below already refetches both at that point. Invalidating this early
      // used to force an immediate real `az account list`/`az account show` refetch for the
      // existing account(s) at the exact moment the backend also spawns `az login
      // --use-device-code` for the new attempt; under real CLI process load that refetch could
      // time out and silently fall back to empty, making an already-signed-in account flash
      // "0 subscriptions, no sign out button" for no reason connected to its actual state.
    },
    onSuccess: () => setPolling(true),
    onError: (e) => {
      setPolling(false);
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  // Lets the user back out of a device-code prompt they don't want to finish, instead of it
  // sitting there (or the backend continuing to poll `az login`) until it times out on its own.
  const cancelLogin = useMutation({
    mutationFn: () => api.azureLoginCancel(azureSource),
    onSuccess: () => {
      setPolling(false);
      setWatchLoginStatus(false);
      setAwaitingAzureAccount(false);
      setMessage('');
      setMessageIsError(false);
      qc.removeQueries({ queryKey: ['azure-login-status'] });
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  // Signs out one specific account (email) - or, with no email, every account
  // registered for this scope. The backend only tears down the config dir(s) for
  // whatever was targeted, so signing one account out never touches the others.
  // Which row is mid-sign-out, so only that row's button shows busy/disabled state.
  const [signingOutEmail, setSigningOutEmail] = useState<string | undefined>();

  // Explicit re-sync from Azure (as opposed to the polled read the `accounts` query does).
  const refreshAccounts = useMutation({
    mutationFn: () => api.azureAccounts(azureSource, true),
    onSuccess: (data) => qc.setQueryData(['azure', 'accounts', azureSource], data),
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const logout = useMutation({
    mutationFn: (email?: string) => {
      setSigningOutEmail(email);
      return api.azureLogout(email, azureSource);
    },
    onSettled: () => setSigningOutEmail(undefined),
    onSuccess: () => {
      setMessage(uiText.azure.signedOut);
      setMessageIsError(false);
      setSubscription('');
      setPolling(false);
      setAwaitingAzureAccount(false);
      qc.removeQueries({ queryKey: ['azure-login-status'] });
      qc.invalidateQueries({ queryKey: ['azure', 'account'] });
      qc.invalidateQueries({ queryKey: ['azure', 'accounts'] });
      qc.invalidateQueries({ queryKey: ['azure', 'subscriptions'] });
      qc.invalidateQueries({ queryKey: ['azure', 'aks'] });
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const loginStatus = useQuery({
    queryKey: ['azure-login-status', azureSource],
    queryFn: () => api.azureLoginStatus(azureSource),
    enabled: polling || watchLoginStatus,
    refetchInterval: polling || watchLoginStatus ? 2500 : false,
  });

  const subs = useQuery({
    queryKey: ['azure', 'subscriptions', azureSource],
    queryFn: () => api.azureSubscriptions(azureSource),
    enabled: loggedIn,
  });

  useEffect(() => {
    const state = loginStatus.data?.state;
    if (state === 'succeeded') {
      setPolling(false);
      setWatchLoginStatus(false);
      setAwaitingAzureAccount(true);
      setMessage('Azure sign-in complete. Loading account...');
      setMessageIsError(false);
      void qc.refetchQueries({ queryKey: ['azure', 'account'] });
      void qc.refetchQueries({ queryKey: ['azure', 'accounts'] });
    } else if (state === 'failed') {
      setPolling(false);
      setWatchLoginStatus(false);
      setAwaitingAzureAccount(false);
      setMessage(loginStatus.data?.message || 'Azure login failed.');
      setMessageIsError(true);
    } else if (state === 'idle') {
      setWatchLoginStatus(false);
    } else if (state === 'pending' && loginStatus.data?.deviceInfo) {
      // Clear stale errors once a new device-code challenge is active.
      setMessage('');
      setMessageIsError(false);
    }
  }, [loginStatus.data?.state]);

  useEffect(() => {
    if (!awaitingAzureAccount || !loggedIn) return;
    if (account.isFetching || subs.isFetching) return;
    setAwaitingAzureAccount(false);
    onAccountsChanged?.(account.data?.account ?? null, azureSource);
    if (onAccountsChanged) return;
    setMessage('Signed in to Azure.');
    setMessageIsError(false);
    void qc.refetchQueries({ queryKey: ['azure', 'subscriptions'] });
    void qc.refetchQueries({ queryKey: ['azure', 'aks'] });
    void qc.refetchQueries({ queryKey: ['azure', 'accounts'] });
  }, [account.data?.account, account.isFetching, awaitingAzureAccount, loggedIn, onAccountsChanged, qc, subs.isFetching, azureSource]);

  const accountGroups = accounts.data?.accounts ?? [];
  const selectedAccount = useMemo<AzureAccountGroup | undefined>(() => {
    if (accountGroups.length === 0) return undefined;
    return accountGroups.find((group) => group.id === selectedAccountId) ?? accountGroups[0];
  }, [accountGroups, selectedAccountId]);

  useEffect(() => {
    if (accountGroups.length === 0) {
      if (selectedAccountId) setSelectedAccountId('');
      return;
    }
    const nextId = selectedAccount?.id ?? accountGroups[0].id;
    if (nextId !== selectedAccountId) setSelectedAccountId(nextId);
  }, [accountGroups, selectedAccount, selectedAccountId]);

  useEffect(() => {
    if (!loggedIn) return;
    const selectedSubscriptionIds = new Set(selectedAccount?.subscriptions.map((sub) => sub.id) ?? []);
    const visibleSubscriptions = selectedAccount
      ? (subs.data?.subscriptions ?? []).filter((sub) => selectedSubscriptionIds.has(sub.id))
      : subs.data?.subscriptions ?? [];
    const def = visibleSubscriptions.find((s) => s.isDefault) ?? visibleSubscriptions[0];
    if (def && def.id !== subscription) setSubscription(def.id);
  }, [loggedIn, selectedAccount, subs.data, subscription]);

  const setSub = useMutation({
    mutationFn: (id: string) => api.azureSetSubscription(id, azureSource, selectedAccount?.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['azure', 'aks'] }),
  });

  const aks = useQuery({
    queryKey: ['azure', 'aks', azureSource, subscription, selectedAccount?.id],
    queryFn: () => api.azureAks(subscription, azureSource, selectedAccount?.id),
    enabled: loggedIn && !!subscription,
  });

  const getCreds = useMutation({
    mutationFn: (c: AksCluster) =>
      api.azureAksCredentials({ resourceGroup: c.resourceGroup, name: c.name, subscription, accountId: selectedAccount?.id }),
    onSuccess: async (_res, c) => {
      setMessage(`${uiText.azure.importCredsPrefix} ${c.name}.`);
      setMessageIsError(false);
      await onContextsChanged();
      await onPickContext(c.name);
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const device = loginStatus.data?.deviceInfo;
  const lastAzCandidate = loginStatus.data?.diagnostics?.lastAzCandidate;
  const loginState = loginStatus.data?.state;
  const loginPending = polling && loginState !== 'failed' && loginState !== 'succeeded';
  const pendingMessage = loginStatus.data?.message || uiText.azure.waitingForDeviceCode;
  const userName = account.data?.account?.user?.name;
  const userType = account.data?.account?.user?.type;
  const accountLabel =
    userName && userType ? `${userName} (${userType})` : userName || account.data?.account?.name || '';
  const azureScopeLabel = azureSource === 'local' ? 'Local' : 'Cloud';
  const currentSubscription = subs.data?.subscriptions.find((sub) => sub.id === subscription);
  const visibleSubscriptions = selectedAccount
    ? (subs.data?.subscriptions ?? []).filter((sub) => selectedAccount.subscriptions.some((accountSub) => accountSub.id === sub.id))
    : subs.data?.subscriptions ?? [];
  const fallbackAccountLabel = account.data?.account?.user?.name || account.data?.account?.name || 'Azure user';
  const totalSubscriptionCount = subs.data?.subscriptions.length ?? 0;
  const signInButtonLabel = loggedIn ? 'Add Azure account' : uiText.azure.signIn;

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 style={{ margin: 0 }}>{uiText.azure.connectionsTitle}</h2>
        <button className="primary" onClick={() => login.mutate()} disabled={login.isPending || polling}>
          {signInButtonLabel}
        </button>
      </div>
      {message && (
        <div className={`notice ${messageIsError ? 'error' : ''}`}>
          <div>{message}</div>
          {messageIsError && lastAzCandidate && (
            <div className="dim" style={{ marginTop: 6 }}>
              CLI candidate tried: <code className="inline">{lastAzCandidate}</code>
            </div>
          )}
        </div>
      )}

      {loginPending && (
        <div className="notice azure-login-pending" style={{ marginTop: 10 }}>
          <span className="azure-login-spinner" aria-label="Azure sign-in in progress" />
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
              <span>{uiText.azure.signInProgress}</span>
              <button onClick={() => cancelLogin.mutate()} disabled={cancelLogin.isPending}>
                {cancelLogin.isPending ? uiText.azure.cancellingSignIn : uiText.azure.cancelSignIn}
              </button>
            </div>
            {device ? (
              <div style={{ marginTop: 6 }}>
                Open{' '}
                <a href={device.verificationUrl} target="_blank" rel="noreferrer">
                  {device.verificationUrl ?? 'the device login page'}
                </a>{' '}
                and enter code <code className="inline">{device.userCode}</code>
              </div>
            ) : (
              <div className="dim" style={{ marginTop: 6 }}>{pendingMessage}</div>
            )}
            <div className="dim" style={{ marginTop: 6 }}>{uiText.azure.waitingForSignIn}</div>
          </div>
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h3>{uiText.azure.accountTitle}</h3>
        {/* <div className="dim" style={{ marginBottom: 8 }}>
          Scope: <b>{azureScopeLabel}</b>
        </div> */}
        {(account.isLoading || awaitingAzureAccount) && <div className="dim">{uiText.azure.checking}</div>}
        {loggedIn ? (
          <div className="notice">
            <div style={{ marginTop: 14 }}>
              {(accounts.isLoading || accounts.isFetching) && <div className="dim">Loading Azure accounts...</div>}
              {accounts.isError && <div className="notice error">{(accounts.error as Error).message}</div>}
              {!accounts.isLoading && !accounts.isError && accountGroups.length === 0 && totalSubscriptionCount === 0 ? (
                <div className="notice" style={{ padding: '10px 12px' }}>
                  <div>
                    <b>{fallbackAccountLabel}</b>
                    {userType ? <span className="dim"> ({userType})</span> : null}
                  </div>
                  <div className="dim" style={{ marginTop: 4 }}>
                    0 subscriptions
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {accountGroups.length === 0 && totalSubscriptionCount > 0 && (
                    <div className="notice" style={{ padding: '10px 12px' }}>
                      <div>
                        <b>{fallbackAccountLabel}</b>
                        {userType ? <span className="dim"> ({userType})</span> : null}
                      </div>
                      <div className="dim" style={{ marginTop: 4 }}>
                        {totalSubscriptionCount} subscription{totalSubscriptionCount === 1 ? '' : 's'}
                      </div>
                    </div>
                  )}
                  {accountGroups.map((group) => (
                    <div
                      key={group.id}
                      className="notice"
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 12px' }}
                    >
                      <div>
                        <div>
                          <b>{group.email}</b>
                          {group.userType ? <span className="dim"> ({group.userType})</span> : null}
                        </div>
                        <div className="dim" style={{ marginTop: 4 }}>
                          {group.subscriptions.length} subscription{group.subscriptions.length === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
                        <button
                          title="Re-sync from Azure and reload this account into the sidebar"
                          onClick={() => {
                            void qc.invalidateQueries({ queryKey: ['azure', 'accounts'] });
                            void qc.invalidateQueries({ queryKey: ['azure', 'account'] });
                            // Explicit user action, so pay for a real --refresh round trip to
                            // pick up subscriptions granted since this account signed in.
                            void refreshAccounts.mutateAsync();
                            onAzureAccountsRefresh?.(azureSource);
                          }}
                          disabled={refreshAccounts.isPending}
                        >
                          {refreshAccounts.isPending ? 'Refreshing...' : 'Refresh'}
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            const wasLastAccount = accountGroups.length <= 1;
                            logout.mutate(group.email, {
                              onSuccess: (result) => {
                                if (wasLastAccount) onAccountsChanged?.(null, azureSource);
                                // Only this account's contexts went away, so close just their
                                // tabs rather than every AKS tab.
                                onAzureAccountSignedOut?.(group.email, result.removed ?? []);
                                onAzureAccountsRefresh?.(azureSource);
                              },
                            });
                          }}
                          // Only the row being signed out is disabled, so a slow sign-out
                          // doesn't lock the other accounts' buttons.
                          disabled={logout.isPending && signingOutEmail === group.email}
                        >
                          {logout.isPending && signingOutEmail === group.email ? 'Signing out...' : uiText.azure.signOut}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <></>
        )}
      </section>

      {/* {loggedIn && (
        <>
          <section style={{ marginBottom: 24 }}>
            <h3>Subscription</h3>
            <div className="dim" style={{ marginBottom: 8 }}>
              {subs.data?.subscriptions.length ?? 0} subscriptions available
            </div>
            <select
              value={subscription}
              onChange={(e) => {
                setSubscription(e.target.value);
                setSub.mutate(e.target.value);
              }}
            >
              {(subs.data?.subscriptions ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </section>

          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h3 style={{ margin: 0 }}>AKS Clusters</h3>
                <button onClick={() => aks.refetch()}>{uiText.azure.refresh}</button>
            </div>
              {aks.isLoading && <div className="dim">{uiText.azure.loadingClusters}</div>}
            {aks.isError && <div className="notice error">{(aks.error as Error).message}</div>}
              {aks.data && aks.data.clusters.length === 0 && <div className="empty">{uiText.azure.noClusters}</div>}
            {aks.data && aks.data.clusters.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Resource Group</th>
                    <th>Location</th>
                    <th>Version</th>
                    <th>State</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {aks.data.clusters.map((c) => (
                    <tr key={`${c.resourceGroup}/${c.name}`}>
                      <td className="mono">{c.name}</td>
                      <td className="dim">{c.resourceGroup}</td>
                      <td className="dim">{c.location}</td>
                      <td>{c.kubernetesVersion}</td>
                      <td>
                        <span className={`badge ${c.powerState?.code === 'Running' ? 'ok' : 'warn'}`}>
                          {c.powerState?.code ?? '-'}
                        </span>
                      </td>
                      <td>
                        <button
                          className="primary"
                          onClick={() => getCreds.mutate(c)}
                          disabled={getCreds.isPending}
                        >
                          Connect
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )} */}
    </div>
  );
}
