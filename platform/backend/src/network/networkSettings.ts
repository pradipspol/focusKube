import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { badRequest } from '../util/httpError.js';
import { logInfo, logWarn } from '../util/logger.js';
import type { NetworkSettings } from '../runtime/appSettingsStore.js';

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'] as const;

// Captured at startup so "Use environment variables" can always fall back to what the app was launched with.
const launchEnv: Record<string, string | undefined> = Object.fromEntries(
  [...PROXY_ENV_KEYS, 'NODE_EXTRA_CA_CERTS'].map((key) => [key, process.env[key]]),
);

let activeProxyEnv: Record<string, string> = {};
let restoreGlobalProxy: (() => void) | null = null;
let launchCaCertificates: string[] | null = null;

type ProxyAwareHttp = typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void };
type CaAwareTls = typeof tls & {
  getCACertificates?: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

function normalizeNoProxy(value: string): string {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join(',');
}

function resolveProxyEnv(settings: NetworkSettings): Record<string, string> {
  if (settings.proxyMode === 'none') return {};
  if (settings.proxyMode === 'environment') {
    const env: Record<string, string> = {};
    for (const key of PROXY_ENV_KEYS) {
      const value = launchEnv[key];
      if (value) env[key] = value;
    }
    return env;
  }
  const httpProxy = settings.httpProxy.trim();
  const httpsProxy = settings.httpsProxy.trim() || httpProxy;
  const noProxy = normalizeNoProxy(settings.noProxy);
  const env: Record<string, string> = {};
  if (httpProxy) env.HTTP_PROXY = env.http_proxy = httpProxy;
  if (httpsProxy) env.HTTPS_PROXY = env.https_proxy = httpsProxy;
  if (noProxy) env.NO_PROXY = env.no_proxy = noProxy;
  return env;
}

function hasProxy(env: Record<string, string>): boolean {
  return Boolean(env.HTTP_PROXY || env.HTTPS_PROXY || env.http_proxy || env.https_proxy);
}

/** Reads a PEM bundle and returns its individual certificates; throws a 400 if none are found. */
export function readCaBundle(filePath: string): string[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw badRequest(`Unable to read CA certificate file: ${err instanceof Error ? err.message : String(err)}`);
  }
  const certs = content.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (certs.length === 0) {
    throw badRequest('The CA certificate file does not contain any PEM-encoded certificates.');
  }
  return certs;
}

export function validateNetworkSettings(settings: NetworkSettings): void {
  if (settings.proxyMode === 'manual' && !settings.httpProxy && !settings.httpsProxy) {
    throw badRequest('Manual proxy mode requires an HTTP or HTTPS proxy URL.');
  }
  if (settings.caCertPath) readCaBundle(settings.caCertPath);
}

function applyProxy(settings: NetworkSettings): void {
  const proxyEnv = resolveProxyEnv(settings);
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, proxyEnv);
  activeProxyEnv = proxyEnv;

  // In-process fetch()/http(s).request() — child CLIs (az, aws, kubectl, helm) pick up process.env on spawn.
  const setGlobalProxyFromEnv = (http as ProxyAwareHttp).setGlobalProxyFromEnv;
  if (typeof setGlobalProxyFromEnv !== 'function') {
    if (hasProxy(proxyEnv)) logWarn('network.proxy.runtime_unsupported', { nodeVersion: process.version });
    return;
  }
  try {
    restoreGlobalProxy?.();
    restoreGlobalProxy = hasProxy(proxyEnv) ? setGlobalProxyFromEnv(proxyEnv) : null;
  } catch (err) {
    logWarn('network.proxy.apply_failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

function applyCertificateTrust(settings: NetworkSettings): void {
  if (settings.caCertPath) process.env.NODE_EXTRA_CA_CERTS = settings.caCertPath;
  else if (launchEnv.NODE_EXTRA_CA_CERTS) process.env.NODE_EXTRA_CA_CERTS = launchEnv.NODE_EXTRA_CA_CERTS;
  else delete process.env.NODE_EXTRA_CA_CERTS;

  const tlsApi = tls as CaAwareTls;
  if (typeof tlsApi.getCACertificates !== 'function' || typeof tlsApi.setDefaultCACertificates !== 'function') {
    if (settings.caCertPath || settings.useSystemCa) logWarn('network.ca.runtime_unsupported', { nodeVersion: process.version });
    return;
  }
  if (!launchCaCertificates) {
    if (!settings.caCertPath && !settings.useSystemCa) return;
    launchCaCertificates = tlsApi.getCACertificates('default');
  }

  const certs = new Set(launchCaCertificates);
  if (settings.useSystemCa) {
    try {
      for (const cert of tlsApi.getCACertificates('system')) certs.add(cert);
    } catch (err) {
      logWarn('network.ca.system_store_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (settings.caCertPath) {
    try {
      for (const cert of readCaBundle(settings.caCertPath)) certs.add(cert);
    } catch (err) {
      logWarn('network.ca.custom_bundle_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  tlsApi.setDefaultCACertificates([...certs]);
}

export function applyNetworkSettings(settings: NetworkSettings): void {
  applyProxy(settings);
  applyCertificateTrust(settings);
  logInfo('network.settings.applied', {
    proxyMode: settings.proxyMode,
    proxyActive: hasProxy(activeProxyEnv),
    customCa: Boolean(settings.caCertPath),
    systemCa: settings.useSystemCa,
  });
}

/** AWS SDK clients build their own agents, so they need an explicitly proxy-aware one. */
export function awsClientNetworkConfig(): { requestHandler?: { httpsAgent: https.Agent } } {
  if (!hasProxy(activeProxyEnv)) return {};
  const options = { keepAlive: true, proxyEnv: { ...activeProxyEnv } } as https.AgentOptions;
  return { requestHandler: { httpsAgent: new https.Agent(options) } };
}
