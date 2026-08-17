import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AzureScope } from '../api/client';
import type { AksCluster, AzureAccount } from '../api/types';

interface Props {
  azureSource?: AzureScope;
  onContextsChanged: () => Promise<void> | void;
  onPickContext: (name: string) => void;
  /** Called when the set of signed-in Azure accounts changes (login/logout). */
  onAccountsChanged?: (account: AzureAccount | null, scope?: AzureScope) => void;
}

export function AzurePanel({
  azureSource = 'cloud',
  onContextsChanged,
  onPickContext,
  onAccountsChanged,
}: Props) {
  const qc = useQueryClient();
  const [subscription, setSubscription] = useState<string>('');
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
  const loggedIn = !!account.data?.account;

  const login = useMutation({
    mutationFn: () => api.azureLogin(azureSource),
    onMutate: () => {
      setMessage('');
      setMessageIsError(false);
      setAwaitingAzureAccount(false);
      setWatchLoginStatus(true);
      setPolling(true);
      qc.removeQueries({ queryKey: ['azure-login-status'] });
      qc.invalidateQueries({ queryKey: ['azure', 'account'] });
    },
    onSuccess: () => setPolling(true),
    onError: (e) => {
      setPolling(false);
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const logout = useMutation({
    mutationFn: () => api.azureLogout(undefined, azureSource),
    onSuccess: () => {
      setMessage('Signed out from Azure CLI session.');
      setMessageIsError(false);
      setSubscription('');
      setPolling(false);
      setAwaitingAzureAccount(false);
      qc.removeQueries({ queryKey: ['azure-login-status'] });
      qc.invalidateQueries({ queryKey: ['azure', 'account'] });
      qc.invalidateQueries({ queryKey: ['azure', 'subscriptions'] });
      qc.invalidateQueries({ queryKey: ['azure', 'aks'] });
      onAccountsChanged?.(null, azureSource);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  }, [account.data?.account, account.isFetching, awaitingAzureAccount, loggedIn, onAccountsChanged, qc, subs.isFetching, azureSource]);

  useEffect(() => {
    const def = subs.data?.subscriptions.find((s) => s.isDefault) ?? subs.data?.subscriptions[0];
    if (def && !subscription) setSubscription(def.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs.data]);

  const setSub = useMutation({
    mutationFn: (id: string) => api.azureSetSubscription(id, azureSource),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['azure', 'aks'] }),
  });

  const aks = useQuery({
    queryKey: ['azure', 'aks', azureSource, subscription],
    queryFn: () => api.azureAks(subscription, azureSource),
    enabled: loggedIn && !!subscription,
  });

  const getCreds = useMutation({
    mutationFn: (c: AksCluster) =>
      api.azureAksCredentials({ resourceGroup: c.resourceGroup, name: c.name, subscription }),
    onSuccess: async (_res, c) => {
      setMessage(`Imported credentials for ${c.name}.`);
      setMessageIsError(false);
      await onContextsChanged();
      onPickContext(c.name);
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
  const pendingMessage = loginStatus.data?.message || 'Waiting for Azure device code…';
  const userName = account.data?.account?.user?.name;
  const userType = account.data?.account?.user?.type;
  const accountLabel =
    userName && userType ? `${userName} (${userType})` : userName || account.data?.account?.name || '';
  const azureScopeLabel = azureSource === 'local' ? 'Local' : 'Cloud';

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      <h2>Azure / AKS Connections</h2>
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

      <section style={{ marginBottom: 24 }}>
        <h3>Account</h3>
        <div className="dim" style={{ marginBottom: 8 }}>
          Scope: <b>{azureScopeLabel}</b>
        </div>
        {(account.isLoading || awaitingAzureAccount) && <div className="dim">Checking…</div>}
        {loggedIn ? (
          <div className="notice">
            <div>
              Signed in as <b>{accountLabel}</b>
            </div>
            <div className="dim" style={{ marginTop: 6 }}>
              Active subscription: {account.data?.account?.name}
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="danger" onClick={() => logout.mutate()} disabled={logout.isPending}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <>
            <button className="primary" onClick={() => login.mutate()} disabled={login.isPending || polling}>
              Sign in to Azure (device code)
            </button>
            {loginPending && (
              <div className="notice azure-login-pending" style={{ marginTop: 10 }}>
                <span className="azure-login-spinner" aria-label="Azure sign-in in progress" />
                <div>
                  <div>Azure sign-in in progress…</div>
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
                  <div className="dim" style={{ marginTop: 6 }}>Waiting for sign-in…</div>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {loggedIn && (
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
              <button onClick={() => aks.refetch()}>⟳ Refresh</button>
            </div>
            {aks.isLoading && <div className="dim">Loading clusters…</div>}
            {aks.isError && <div className="notice error">{(aks.error as Error).message}</div>}
            {aks.data && aks.data.clusters.length === 0 && <div className="empty">No AKS clusters.</div>}
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
      )}
    </div>
  );
}
