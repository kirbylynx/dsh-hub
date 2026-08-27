import { PROTO_MINOR, PROTO_VERSION } from 'dsh-hub-client/src/protocol.js';

const PROTOCOL_LABEL = `v${PROTO_VERSION}.${PROTO_MINOR}`;
const INSTANCE_ID_PATTERN = /^inst-[a-z2-7]{26}$/;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function inferPluginInstanceUrl(endpoint, instanceId) {
  const cleanInstanceId = cleanText(instanceId);
  if (!INSTANCE_ID_PATTERN.test(cleanInstanceId)) return null;
  const url = safeUrl(cleanText(endpoint));
  if (!url) return null;
  let hostname = url.hostname;
  if (hostname === 'localhost') {
    hostname = `${cleanInstanceId}.localhost`;
  } else if (hostname.startsWith('control.')) {
    hostname = `${cleanInstanceId}.instances.${hostname.slice('control.'.length)}`;
  } else if (hostname.startsWith('portal.')) {
    hostname = `${cleanInstanceId}.instances.${hostname.slice('portal.'.length)}`;
  } else if (!hostname.startsWith(`${cleanInstanceId}.`)) {
    hostname = `${cleanInstanceId}.${hostname}`;
  }
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ''}/`;
}

function severityForConnection(state) {
  if (state === 'tunnel-running') return 'ok';
  if (state === 'disabled') return 'neutral';
  if (state === 'ready' || state === 'connecting') return 'warning';
  return 'attention';
}

function messageForConnection(state) {
  if (state === 'tunnel-running') return 'Plugin tunnel is connected.';
  if (state === 'ready') return 'Plugin credentials are ready; tunnel is not currently running.';
  if (state === 'credentials-required') return 'Plugin is enabled but instance credentials are missing.';
  if (state === 'endpoint-required') return 'Plugin is enabled but hub endpoint is not configured.';
  if (state === 'target-unavailable') return 'DSH webServer loopback target is unavailable.';
  if (state === 'disabled') return 'Plugin is disabled and has no runtime side effects.';
  return `Plugin connection state: ${state || 'unknown'}.`;
}

export function createPluginStatusView({ config = {}, status = {} } = {}) {
  const credentials = status.credentials ?? {};
  const diagnostics = status.diagnostics ?? null;
  const state = status.connectionState ?? 'unknown';
  const instanceUrl = credentials.instanceId
    ? inferPluginInstanceUrl(config.endpoint, credentials.instanceId)
    : null;

  return Object.freeze({
    summary: Object.freeze({
      state,
      severity: severityForConnection(state),
      message: messageForConnection(state),
    }),
    connection: Object.freeze({
      state,
      delivery: status.delivery ?? 'plugin',
      protocol: PROTOCOL_LABEL,
      pluginVersion: status.version ?? null,
      instanceId: credentials.instanceId ?? null,
      instanceUrl,
      instanceUrlConfidence: instanceUrl ? 'derived-from-endpoint' : null,
      target: status.tunnelAdapter?.target?.authority ?? null,
      active: status.tunnelAdapter?.active === true,
      credentialsConfigured: credentials.configured === true,
      tokenExpiresAt: credentials.tokenExpiresAt ?? null,
      tokenRenewalUntil: credentials.tokenRenewalUntil ?? null,
      lastStatus: status.lastStatus ?? null,
      lastError: status.lastError ?? null,
    }),
    diagnostics: diagnostics ? Object.freeze({
      state: diagnostics.state,
      checkedAt: diagnostics.checkedAt ?? null,
      dshApi: diagnostics.dshApi ?? null,
      websocket: diagnostics.websocket ?? null,
      workspaceMapping: diagnostics.workspaceMapping ?? null,
      recommendations: diagnostics.recommendations ?? [],
    }) : null,
    hostCapabilities: Object.freeze({
      directoryPicker: status.hostCapabilities?.directoryPicker ?? null,
      openPath: status.hostCapabilities?.openPath ?? null,
    }),
  });
}
