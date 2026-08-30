import { runTunnel } from 'dsh-hub-client/src/tunnel.js';
import { parseTarget } from 'dsh-hub-client/src/util.js';
import { publicDeploymentMode } from 'dsh-hub-client/src/deployment-mode.js';

export const PLUGIN_TUNNEL_DELIVERY = 'plugin';
export const PLUGIN_TUNNEL_REQUIRED_CREDENTIALS = Object.freeze([
  'endpoint',
  'instanceId',
  'instanceToken',
  'installationId',
]);

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEndpoint(value) {
  const endpoint = cleanText(value).replace(/\/+$/, '');
  if (!endpoint) return '';
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error('endpoint must start with http:// or https://');
  }
  return endpoint;
}

export function createPluginTunnelTarget(webServer) {
  const rawHost = cleanText(webServer?.host);
  const host = rawHost === 'localhost' ? '127.0.0.1' : rawHost;
  const port = webServer?.port;
  if (!host || !Number.isInteger(port)) {
    return Object.freeze({
      ok: false,
      error: 'webServer host/port unavailable',
      host: rawHost || null,
      port: Number.isInteger(port) ? port : null,
    });
  }
  try {
    const target = parseTarget(`${host.includes(':') ? `[${host}]` : host}:${port}`);
    return Object.freeze({
      ok: true,
      host: target.host,
      port: target.port,
      authority: target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`,
    });
  } catch (err) {
    return Object.freeze({
      ok: false,
      error: err.message,
      host,
      port,
    });
  }
}

export function describePluginTunnelAdapter({ config = {}, webServer, runtime = {} } = {}) {
  const target = createPluginTunnelTarget(webServer);
  const endpointConfigured = cleanText(config.endpoint).length > 0;
  const enabled = config.enabled === true;
  const credentialsConfigured = runtime.credentialsConfigured === true;
  const active = runtime.active === true;
  let state = 'disabled';
  if (enabled && !target.ok) state = 'target-unavailable';
  else if (enabled && !endpointConfigured) state = 'endpoint-required';
  else if (enabled && !credentialsConfigured) state = 'credentials-required';
  else if (enabled && runtime.state) state = runtime.state;
  else if (enabled) state = active ? 'connecting' : 'ready';

  return Object.freeze({
    available: true,
    active,
    delivery: PLUGIN_TUNNEL_DELIVERY,
    state,
    target,
    endpointConfigured,
    credentialsConfigured,
    startPolicy: 'auto-when-enabled-and-credentials-present',
    requiredCredentials: PLUGIN_TUNNEL_REQUIRED_CREDENTIALS,
    notes: Object.freeze([
      'M4D-3 reuses dsh-hub-client register/runTunnel/lifecycle helpers with plugin delivery.',
      'Target is fixed to the in-process DSH webServer loopback host/port.',
      'Registry key and replacement grant are one-shot in-memory join inputs; only instance credentials are persisted after successful join.',
    ]),
  });
}

export function createPluginTunnelAdapter({ config = {}, webServer, runner = runTunnel } = {}) {
  const target = createPluginTunnelTarget(webServer);
  return Object.freeze({
    delivery: PLUGIN_TUNNEL_DELIVERY,
    target,
    describe: () => describePluginTunnelAdapter({ config, webServer }),
    start({ credentials, onStatus = () => {}, onHistoryEvent = () => {}, signal } = {}) {
      if (!target.ok) throw new Error(`plugin tunnel target unavailable: ${target.error}`);
      const endpoint = normalizeEndpoint(credentials?.endpoint ?? config.endpoint);
      const missing = PLUGIN_TUNNEL_REQUIRED_CREDENTIALS
        .filter((key) => key !== 'endpoint')
        .filter((key) => !cleanText(credentials?.[key]));
      if (!endpoint) missing.unshift('endpoint');
      if (missing.length) throw new Error(`plugin tunnel credentials missing: ${missing.join(', ')}`);

      const controller = new AbortController();
      const externalAbort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      else signal?.addEventListener?.('abort', externalAbort, { once: true });
      const runtimeSignal = controller.signal;
      const runtimeConfig = {
        endpoint,
        heartbeatMs: 30_000,
        healthMs: 10_000,
        delivery: PLUGIN_TUNNEL_DELIVERY,
        deploymentMode: publicDeploymentMode(credentials?.deploymentMode ?? config.deploymentMode),
        dshVersion: credentials?.dshVersion ?? config.dshVersion ?? null,
      };
      const runtimeCreds = {
        endpoint,
        instanceId: cleanText(credentials.instanceId),
        instanceToken: cleanText(credentials.instanceToken),
        installationId: cleanText(credentials.installationId),
        delivery: PLUGIN_TUNNEL_DELIVERY,
        deploymentMode: publicDeploymentMode(credentials?.deploymentMode ?? config.deploymentMode),
        target: target.authority,
        hostname: cleanText(credentials.hostname ?? config.instanceName),
        clientVersion: credentials.clientVersion ?? '0.1.3',
        dshVersion: credentials.dshVersion ?? config.dshVersion ?? null,
      };
      const promise = Promise.resolve(runner(runtimeConfig, runtimeCreds, {
        delivery: PLUGIN_TUNNEL_DELIVERY,
        deploymentMode: publicDeploymentMode(credentials?.deploymentMode ?? config.deploymentMode),
        installSignalHandlers: false,
        signal: runtimeSignal,
        onStatus,
        onHistoryEvent,
      })).finally(() => {
        signal?.removeEventListener?.('abort', externalAbort);
      });
      return Object.freeze({
        delivery: PLUGIN_TUNNEL_DELIVERY,
        target,
        promise,
        stop: () => controller.abort(),
      });
    },
  });
}
