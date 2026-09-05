import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AwsAuthConfig, AwsIdentity, EksCluster } from '../api/types';
import { uiText } from '../text';
import { LoadingOverlay } from './LoadingOverlay';

interface Props {
  onContextsChanged: () => Promise<void> | void;
  onPickContext: (name: string) => void;
  onAwsAccountsChanged?: (identity: AwsIdentity | null) => void;
}

export function AwsPanel({ onContextsChanged, onPickContext, onAwsAccountsChanged }: Props) {
  const qc = useQueryClient();
  const [awsProfileName, setAwsProfileName] = useState('default');
  const [awsSsoSessionName, setAwsSsoSessionName] = useState('focusKube');
  const [awsSsoStartUrl, setAwsSsoStartUrl] = useState('');
  const [awsSsoRegion, setAwsSsoRegion] = useState('us-east-1');
  const [awsAccountId, setAwsAccountId] = useState('');
  const [awsRoleName, setAwsRoleName] = useState('');
  const [awsRegion, setAwsRegion] = useState('us-east-1');
  const [awsAuthMode, setAwsAuthMode] = useState<'sso' | 'static' | 'role'>('sso');
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('');
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
  const [awsSessionToken, setAwsSessionToken] = useState('');
  const [awsRoleArn, setAwsRoleArn] = useState('');
  const [awsSourceProfileName, setAwsSourceProfileName] = useState('');
  const [awsCredentialSource, setAwsCredentialSource] = useState<'Environment' | 'Ec2InstanceMetadata' | 'EcsContainer'>('Ec2InstanceMetadata');
  const [awsRoleSessionName, setAwsRoleSessionName] = useState('focusKube');
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const [awsPolling, setAwsPolling] = useState(false);
  const [watchAwsLoginStatus, setWatchAwsLoginStatus] = useState(true);
  const [awaitingAwsAccount, setAwaitingAwsAccount] = useState(false);

  const awsAccount = useQuery({
    queryKey: ['aws', 'account'],
    queryFn: api.awsAccount,
    refetchInterval: awaitingAwsAccount ? 1500 : false,
  });
  const awsLoggedIn = !!awsAccount.data?.account;

  const awsLogin = useMutation({
    mutationFn: () => api.awsLogin(),
    onMutate: () => {
      setMessage('');
      setMessageIsError(false);
      setAwaitingAwsAccount(false);
      setWatchAwsLoginStatus(true);
      setAwsPolling(true);
      qc.removeQueries({ queryKey: ['aws-login-status'] });
      qc.invalidateQueries({ queryKey: ['aws', 'account'] });
    },
    onSuccess: () => setAwsPolling(true),
    onError: (e) => {
      setAwsPolling(false);
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const awsLogout = useMutation({
    mutationFn: () => api.awsLogout(),
    onSuccess: () => {
      setMessage(uiText.aws.signedOut);
      setMessageIsError(false);
      setAwsPolling(false);
      setAwaitingAwsAccount(false);
      qc.removeQueries({ queryKey: ['aws-login-status'] });
      qc.invalidateQueries({ queryKey: ['aws', 'account'] });
      qc.invalidateQueries({ queryKey: ['aws', 'eks'] });
      onAwsAccountsChanged?.(null);
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const awsConfigureAuth = useMutation({
    mutationFn: (body: AwsAuthConfig) => api.awsConfigureAuth(body),
    onSuccess: async (_res, body) => {
      setMessage(
        body.mode === 'sso'
          ? `Saved AWS SSO profile ${body.profileName}.`
          : body.mode === 'static'
            ? `Saved AWS access key profile ${body.profileName}.`
            : `Saved AWS role profile ${body.profileName}.`,
      );
      setMessageIsError(false);
      qc.removeQueries({ queryKey: ['aws-login-status'] });
      qc.invalidateQueries({ queryKey: ['aws', 'account'] });
      setAwaitingAwsAccount(true);
      await qc.refetchQueries({ queryKey: ['aws', 'account'] });
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  const awsLoginStatus = useQuery({
    queryKey: ['aws-login-status'],
    queryFn: api.awsLoginStatus,
    enabled: awsPolling || watchAwsLoginStatus,
    refetchInterval: awsPolling || watchAwsLoginStatus ? 2500 : false,
  });

  useEffect(() => {
    const state = awsLoginStatus.data?.state;
    if (state === 'succeeded') {
      setAwsPolling(false);
      setWatchAwsLoginStatus(false);
      setAwaitingAwsAccount(true);
      setMessage('AWS sign-in complete. Loading account...');
      setMessageIsError(false);
      void qc.refetchQueries({ queryKey: ['aws', 'account'] });
    } else if (state === 'failed') {
      setAwsPolling(false);
      setWatchAwsLoginStatus(false);
      setAwaitingAwsAccount(false);
      setMessage(awsLoginStatus.data?.message || 'AWS login failed.');
      setMessageIsError(true);
    } else if (state === 'idle') {
      setWatchAwsLoginStatus(false);
    } else if (state === 'pending' && awsLoginStatus.data?.deviceInfo) {
      setMessage('');
      setMessageIsError(false);
    }
  }, [awsLoginStatus.data?.state]);

  const eks = useQuery({
    queryKey: ['aws', 'eks'],
    queryFn: api.awsEks,
    enabled: awsLoggedIn,
  });

  const getEksCreds = useMutation({
    mutationFn: (cluster: EksCluster) =>
      api.awsEksCredentials({ region: cluster.region, name: cluster.name }),
    onSuccess: async (_res, cluster) => {
      setMessage(`${uiText.aws.importCredsPrefix} ${cluster.name}.`);
      setMessageIsError(false);
      await onContextsChanged();
      onPickContext(cluster.name);
    },
    onError: (e) => {
      setMessage((e as Error).message);
      setMessageIsError(true);
    },
  });

  useEffect(() => {
    if (!awaitingAwsAccount || !awsLoggedIn) return;
    if (awsAccount.isFetching || eks.isFetching) return;
    setAwaitingAwsAccount(false);
    onAwsAccountsChanged?.((awsAccount.data?.account as AwsIdentity | null) ?? null);
    if (onAwsAccountsChanged) return;
    setMessage(uiText.aws.signedIn);
    setMessageIsError(false);
    void qc.refetchQueries({ queryKey: ['aws', 'eks'] });
  }, [awaitingAwsAccount, awsLoggedIn, awsAccount.data, awsAccount.isFetching, eks.isFetching, onAwsAccountsChanged, qc]);

  const awsDevice = awsLoginStatus.data?.deviceInfo;
  const awsLastCandidate = awsLoginStatus.data?.diagnostics?.lastAwsCandidate;
  const awsLoginState = awsLoginStatus.data?.state;
  const awsLoginPending = awsPolling && awsLoginState !== 'failed' && awsLoginState !== 'succeeded';
  const awsPendingMessage = awsLoginStatus.data?.message || uiText.aws.waitingForDeviceCode;
  const awsIdentity = awsAccount.data?.account as AwsIdentity | null | undefined;

  return (
    <div style={{ padding: 16, maxWidth: 900 }}>
      {(awsAccount.isLoading || (awsLoggedIn && eks.isLoading)) && (
        <LoadingOverlay message={awsAccount.isLoading ? uiText.aws.checking : uiText.aws.loadingClusters} />
      )}
      <h2>{uiText.aws.connectionsTitle}</h2>
      {message && (
        <div className={`notice ${messageIsError ? 'error' : ''}`}>
          <div>{message}</div>
          {messageIsError && awsLastCandidate && (
            <div className="dim" style={{ marginTop: 6 }}>
              CLI candidate tried: <code className="inline">{awsLastCandidate}</code>
            </div>
          )}
        </div>
      )}

      <section style={{ marginBottom: 24 }}>
        <h3>{uiText.aws.accountTitle}</h3>
        {awaitingAwsAccount && <div className="dim">{uiText.aws.checking}</div>}
        {awsLoggedIn ? (
          <div className="notice">
            <div>
              Signed in as <b>{awsIdentity?.arn ?? 'AWS identity'}</b>
            </div>
            <div className="dim" style={{ marginTop: 6 }}>
              Account ID: {awsIdentity?.account ?? '-'}
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="danger" onClick={() => awsLogout.mutate()} disabled={awsLogout.isPending}>
                {uiText.aws.signOut}
              </button>
            </div>
          </div>
        ) : (
          <>
            {!awsLoggedIn && (
              <div className="notice" style={{ marginBottom: 12 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{uiText.aws.configureConnection}</div>
                <div className="dim" style={{ marginBottom: 12 }}>{uiText.aws.configureDescription}</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <select value={awsAuthMode} onChange={(e) => setAwsAuthMode(e.target.value as 'sso' | 'static' | 'role')}>
                    <option value="sso">{uiText.aws.sso}</option>
                    <option value="static">{uiText.aws.accessKeySecret}</option>
                    <option value="role">{uiText.aws.iamRole}</option>
                  </select>
                  <input value={awsProfileName} onChange={(e) => setAwsProfileName(e.target.value)} placeholder={uiText.aws.profileName} />
                  {awsAuthMode === 'sso' && (
                    <>
                      <input value={awsSsoSessionName} onChange={(e) => setAwsSsoSessionName(e.target.value)} placeholder={uiText.aws.ssoSessionName} />
                      <input value={awsSsoStartUrl} onChange={(e) => setAwsSsoStartUrl(e.target.value)} placeholder={uiText.aws.ssoStartUrl} />
                      <input value={awsSsoRegion} onChange={(e) => setAwsSsoRegion(e.target.value)} placeholder={uiText.aws.ssoRegion} />
                      <input value={awsAccountId} onChange={(e) => setAwsAccountId(e.target.value)} placeholder={uiText.aws.accountId} />
                      <input value={awsRoleName} onChange={(e) => setAwsRoleName(e.target.value)} placeholder={uiText.aws.roleName} />
                    </>
                  )}
                  {awsAuthMode === 'static' && (
                    <>
                      <input value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} placeholder={uiText.aws.accessKeyId} />
                      <input value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} placeholder={uiText.aws.secretAccessKey} type="password" />
                      <input value={awsSessionToken} onChange={(e) => setAwsSessionToken(e.target.value)} placeholder={uiText.aws.sessionTokenOptional} />
                    </>
                  )}
                  {awsAuthMode === 'role' && (
                    <>
                      <input value={awsRoleArn} onChange={(e) => setAwsRoleArn(e.target.value)} placeholder={uiText.aws.roleArn} />
                      <input value={awsSourceProfileName} onChange={(e) => setAwsSourceProfileName(e.target.value)} placeholder={uiText.aws.sourceProfileOptional} />
                      <select value={awsCredentialSource} onChange={(e) => setAwsCredentialSource(e.target.value as 'Environment' | 'Ec2InstanceMetadata' | 'EcsContainer')}>
                        <option value="Ec2InstanceMetadata">Ec2InstanceMetadata</option>
                        <option value="Environment">Environment</option>
                        <option value="EcsContainer">EcsContainer</option>
                      </select>
                      <input value={awsRoleSessionName} onChange={(e) => setAwsRoleSessionName(e.target.value)} placeholder={uiText.aws.roleSessionName} />
                    </>
                  )}
                  <input value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} placeholder={uiText.aws.defaultRegion} />
                  <div>
                    <button
                      className="primary"
                      disabled={awsConfigureAuth.isPending}
                      onClick={() =>
                        awsConfigureAuth.mutate(
                          awsAuthMode === 'sso'
                            ? {
                                mode: 'sso',
                                profileName: awsProfileName.trim(),
                                ssoSessionName: awsSsoSessionName.trim() || undefined,
                                ssoStartUrl: awsSsoStartUrl.trim(),
                                ssoRegion: awsSsoRegion.trim(),
                                accountId: awsAccountId.trim(),
                                roleName: awsRoleName.trim(),
                                region: awsRegion.trim(),
                              }
                            : awsAuthMode === 'static'
                              ? {
                                  mode: 'static',
                                  profileName: awsProfileName.trim(),
                                  accessKeyId: awsAccessKeyId.trim(),
                                  secretAccessKey: awsSecretAccessKey.trim(),
                                  sessionToken: awsSessionToken.trim() || undefined,
                                  region: awsRegion.trim(),
                                }
                              : {
                                  mode: 'role',
                                  profileName: awsProfileName.trim(),
                                  roleArn: awsRoleArn.trim(),
                                  region: awsRegion.trim(),
                                  sourceProfileName: awsSourceProfileName.trim() || undefined,
                                  credentialSource: awsCredentialSource,
                                  roleSessionName: awsRoleSessionName.trim() || undefined,
                                },
                        )
                      }
                    >
                      {awsConfigureAuth.isPending ? uiText.aws.saving : uiText.aws.saveConnection}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {awsAuthMode === 'sso' ? (
              <>
                <button className="primary" onClick={() => awsLogin.mutate()} disabled={awsLogin.isPending || awsPolling}>
                  {uiText.aws.signIn}
                </button>
                {awsLoginPending && (
                  <div className="notice azure-login-pending" style={{ marginTop: 10 }}>
                    <span className="azure-login-spinner" aria-label={uiText.aws.signInProgressLabel} />
                    <div>
                      <div>{uiText.aws.signInProgress}</div>
                      {awsDevice ? (
                        <div style={{ marginTop: 6 }}>
                          {uiText.aws.open}{' '}
                          <a href={awsDevice.verificationUrl} target="_blank" rel="noreferrer">
                            {awsDevice.verificationUrl ?? 'the device login page'}
                          </a>{' '}
                          {uiText.aws.enterCode} <code className="inline">{awsDevice.userCode}</code>
                        </div>
                      ) : (
                        <div className="dim" style={{ marginTop: 6 }}>{awsPendingMessage}</div>
                      )}
                      <div className="dim" style={{ marginTop: 6 }}>{uiText.aws.waitingForSignIn}</div>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="notice" style={{ marginTop: 10 }}>
                {uiText.aws.profileSaved}
              </div>
            )}
          </>
        )}
      </section>

      {awsLoggedIn && (
        <section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h3 style={{ margin: 0 }}>{uiText.aws.eksClusters}</h3>
            <button onClick={() => eks.refetch()}>{uiText.aws.refresh}</button>
          </div>
          {eks.isLoading && <div className="dim">{uiText.aws.loadingClusters}</div>}
          {eks.isError && <div className="notice error">{(eks.error as Error).message}</div>}
          {eks.data?.error && <div className="notice error">{eks.data.error}</div>}
          {eks.data && eks.data.clusters.length === 0 && <div className="empty">{uiText.aws.noClusters}</div>}
          {eks.data && eks.data.clusters.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>{uiText.aws.name}</th>
                  <th>{uiText.aws.region}</th>
                  <th>{uiText.aws.version}</th>
                  <th>{uiText.aws.status}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {eks.data.clusters.map((cluster) => (
                  <tr key={`${cluster.region}/${cluster.name}`}>
                    <td className="mono">{cluster.name}</td>
                    <td className="dim">{cluster.region}</td>
                    <td>{cluster.version ?? '-'}</td>
                    <td>
                      <span className={`badge ${cluster.status === 'ACTIVE' ? 'ok' : 'warn'}`}>
                        {cluster.status ?? '-'}
                      </span>
                    </td>
                    <td>
                      <button
                        className="primary"
                        onClick={() => getEksCreds.mutate(cluster)}
                        disabled={getEksCreds.isPending}
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
      )}
    </div>
  );
}