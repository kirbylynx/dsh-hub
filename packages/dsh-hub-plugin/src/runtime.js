import { registerWithHub } from 'dsh-hub-client/src/register.js';
import { rotateTokenWithHub, revokeSelfWithHub } from 'dsh-hub-client/src/lifecycle.js';
import { publicDeploymentMode } from 'dsh-hub-client/src/deployment-mode.js';
import { PluginCredentialStore, resolvePluginConfigDir } from './credential-store.js';
import { createPluginTunnelAdapter, describePluginTunnelAdapter, PLUGIN_TUNNEL_DELIVERY } from './tunnel-adapter.js';

const DEFAULT_CLIENT_VERSION = '0.1.4';
const SECRET_TOKEN_PATTERN = /\b(?:dhk|dhr|dht|dit)_[A-Za-z0-9_-]+\b/g;
const POSIX_PATH_PATTERN = /(^|[\s"'(=,:;])\/(?:Users|home|root|var|tmp|private\/var|Volumes|mnt|opt|srv|workspace)\/[^\s"',)<>\]]+/g;
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"',)<>\]]+/g;
const UNC_PATH_PATTERN = /\\\\[^\\\s"',)<>\]]+\\[^\s"',)<>\]]+/g;
const HISTORY_EVENT_RING_SIZE = 20;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function redactPluginSecrets(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(SECRET_TOKEN_PATTERN, '[redacted-secret]')
    .replace(POSIX_PATH_PATTERN, '$1[redacted-path]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(UNC_PATH_PATTERN, '[redacted-path]');
}

function publicStatus(status) {
  if (!status) return null;
  return Object.freeze({
    ...status,
    message: redactPluginSecrets(status.message),
  });
}

function publicError(error) {
  if (!error) return null;
  return redactPluginSecrets(error.message ?? error);
}

function publicHistoryEvent(event = {}) {
  return Object.freeze({
    requestId: cleanPublicToken(event.requestId),
    method: event.method === 'session.history' || event.method === 'subagent.history' ? event.method : null,
    path: event.path === '/api/session.history' || event.path === '/api/subagent.history' ? event.path : null,
    status: Number.isSafeInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : null,
    requestBytes: safeCount(event.requestBytes),
    rawResponseBytes: safeCount(event.rawResponseBytes),
    normalizedBytes: safeCount(event.normalizedBytes),
    elapsedMs: safeCount(event.elapsedMs),
    errorCode: cleanPublicToken(event.errorCode),
    terminalState: ['ok', 'error', 'cancel'].includes(event.terminalState) ? event.terminalState : 'error',
    contentEncoding: cleanPublicEncoding(event.contentEncoding),
    normalized: event.normalized === true,
  });
}

function publicHistoryDiagnostics(events = []) {
  const recent = events.slice(-HISTORY_EVENT_RING_SIZE).map(publicHistoryEvent);
  return Object.freeze({
    recent: Object.freeze(recent),
    retained: recent.length,
    limit: HISTORY_EVENT_RING_SIZE,
  });
}

function cleanPublicToken(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : null;
}

function cleanPublicEncoding(value) {
  const text = String(value ?? 'identity').trim().toLowerCase();
  if (text.length < 1 || text.length > 80) return 'redacted';
  return /^[a-z0-9.-]+(?:\s*,\s*[a-z0-9.-]+)*$/.test(text) ? text : 'redacted';
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeEndpoint(value) {
  const endpoint = cleanText(value).replace(/\/+$/, '');
  if (!endpoint) return '';
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error('endpoint must start with http:// or https://');
  }
  return endpoint;
}

function safeNormalizeEndpoint(value) {
  try {
    return normalizeEndpoint(value);
  } catch {
    return '';
  }
}

function publicCredentialSummary(creds) {
  if (!creds) return null;
  return Object.freeze({
    endpoint: creds.endpoint,
    instanceId: creds.instanceId,
    installationId: creds.installationId,
    instanceTokenExpiresAt: creds.instanceTokenExpiresAt ?? null,
    instanceTokenRenewalUntil: creds.instanceTokenRenewalUntil ?? null,
    delivery: PLUGIN_TUNNEL_DELIVERY,
    target: creds.target ?? null,
    hostname: creds.hostname ?? null,
    clientVersion: creds.clientVersion ?? DEFAULT_CLIENT_VERSION,
    dshVersion: creds.dshVersion ?? null,
    deploymentMode: publicDeploymentMode(creds.deploymentMode),
  });
}

function joinCredentialKind({ registryKey, replacementGrant }) {
  if (!!registryKey === !!replacementGrant) {
    throw new Error('exactly one of registryKey or replacementGrant is required');
  }
  return registryKey ? 'registry' : 'replacement';
}

function tunnelFingerprint(config = {}, webServer) {
  const endpoint = safeNormalizeEndpoint(config.endpoint);
  const host = cleanText(webServer?.host);
  const port = Number.isInteger(webServer?.port) ? webServer.port : null;
  return JSON.stringify({ endpoint, host, port });
}

function credentialsMatchConfig(credentials, config) {
  if (!credentials) return false;
  const configuredEndpoint = safeNormalizeEndpoint(config.endpoint);
  if (!configuredEndpoint) return false;
  return safeNormalizeEndpoint(credentials.endpoint) === configuredEndpoint;
}

export function createPluginRuntimeStatus({
  config = {},
  webServer,
  credentials = null,
  active = false,
  lastStatus = null,
  lastError = null,
  historyEvents = [],
} = {}) {
  const adapter = describePluginTunnelAdapter({
    config,
    webServer,
    runtime: {
      credentialsConfigured: credentialsMatchConfig(credentials, config),
      active,
      state: active ? 'tunnel-running' : null,
    },
  });
  return Object.freeze({
    tunnelAdapter: adapter,
    connectionState: config.enabled === true ? adapter.state : 'disabled',
    credentials: publicCredentialSummary(credentials),
    lastStatus: publicStatus(lastStatus),
    lastError: publicError(lastError),
    historyDiagnostics: publicHistoryDiagnostics(historyEvents),
  });
}

export class PluginRuntime {
  constructor({
    config = {},
    webServer,
    store = new PluginCredentialStore(resolvePluginConfigDir(config)),
    adapterFactory = createPluginTunnelAdapter,
    register = registerWithHub,
    rotateToken = rotateTokenWithHub,
    revokeSelf = revokeSelfWithHub,
  } = {}) {
    this.config = config;
    this.webServer = webServer;
    this.store = store;
    this.adapterFactory = adapterFactory;
    this.register = register;
    this.rotateToken = rotateToken;
    this.revokeSelf = revokeSelf;
    this.adapter = this.adapterFactory({ config, webServer });
    this.fingerprint = tunnelFingerprint(config, webServer);
    this.credentials = null;
    this.tunnelHandle = null;
    this.lastStatus = null;
    this.lastError = null;
    this.historyEvents = [];
  }

  describe() {
    return createPluginRuntimeStatus({
      config: this.config,
      webServer: this.webServer,
      credentials: this.credentials,
      active: !!this.tunnelHandle,
      lastStatus: this.lastStatus,
      lastError: this.lastError,
      historyEvents: this.historyEvents,
    });
  }

  status() {
    return Object.freeze({
      credentialsConfigured: credentialsMatchConfig(this.credentials, this.config),
      instanceId: this.credentials?.instanceId ?? null,
      installationId: this.credentials?.installationId ?? null,
      tokenExpiresAt: this.credentials?.instanceTokenExpiresAt ?? null,
      tokenRenewalUntil: this.credentials?.instanceTokenRenewalUntil ?? null,
      active: !!this.tunnelHandle,
      state: this.tunnelHandle ? 'tunnel-running' : null,
      lastStatus: publicStatus(this.lastStatus),
      lastError: publicError(this.lastError),
      historyDiagnostics: publicHistoryDiagnostics(this.historyEvents),
    });
  }

  async initialize({ autoStart = true } = {}) {
    this.credentials = await this.store.load();
    if (autoStart) await this.startIfReady();
    return this.describe();
  }

  updateConfig(config = this.config, webServer = this.webServer) {
    const previousFingerprint = this.fingerprint;
    this.config = config;
    this.webServer = webServer;
    this.adapter = this.adapterFactory({ config, webServer });
    this.fingerprint = tunnelFingerprint(config, webServer);
    const changedRoute = previousFingerprint !== this.fingerprint;
    if (config.enabled !== true || changedRoute) this.stopTunnel();
    return this.describe();
  }

  async join({
    endpoint = this.config.endpoint,
    registryKey,
    replacementGrant,
    hostname = this.config.instanceName,
    dshVersion = this.config.dshVersion ?? null,
    clientVersion = DEFAULT_CLIENT_VERSION,
    deploymentMode = this.config.deploymentMode,
    start = true,
  } = {}) {
    const cleanRegistryKey = cleanText(registryKey) || null;
    const cleanReplacementGrant = cleanText(replacementGrant) || null;
    const credentialKind = joinCredentialKind({ registryKey: cleanRegistryKey, replacementGrant: cleanReplacementGrant });
    if (!this.credentials) this.credentials = await this.store.load();
    if (this.credentials && credentialKind === 'registry') {
      throw new Error('plugin already has instance credentials; use rotate-token or owner replacement grant instead of registry key');
    }
    const normalizedEndpoint = normalizeEndpoint(endpoint);
    if (!normalizedEndpoint) throw new Error('endpoint required');
    if (!this.adapter.target?.ok) {
      throw new Error(`plugin tunnel target unavailable: ${this.adapter.target?.error ?? 'unknown'}`);
    }
    const oldHandle = this.tunnelHandle;
    if (this.credentials && credentialKind === 'replacement') {
      this.stopTunnel();
      await oldHandle?.promise.catch(() => null);
    }
    const installationId = this.credentials?.installationId ?? await this.store.ensureInstallationId();
    if (this.credentials?.installationId) this.store.saveState({ installationId });
    const body = await this.register({
      endpoint: normalizedEndpoint,
      registryKey: cleanRegistryKey,
      replacementGrant: cleanReplacementGrant,
      delivery: PLUGIN_TUNNEL_DELIVERY,
      deploymentMode,
      hostname: cleanText(hostname) || null,
      dshVersion,
      installationId,
      clientVersion,
      store: this.store,
    });
    const target = this.adapter.target?.ok ? this.adapter.target.authority : null;
    this.credentials = {
      endpoint: normalizedEndpoint,
      instanceId: body.instanceId,
      installationId,
      instanceToken: body.instanceToken,
      instanceTokenExpiresAt: body.instanceTokenExpiresAt ?? null,
      instanceTokenRenewalUntil: body.instanceTokenRenewalUntil ?? null,
      delivery: PLUGIN_TUNNEL_DELIVERY,
      deploymentMode: publicDeploymentMode(deploymentMode),
      target,
      hostname: cleanText(hostname) || null,
      clientVersion,
      dshVersion,
    };
    await this.store.save(this.credentials);
    this.lastError = null;
    let tunnel = null;
    if (start) tunnel = await this.startIfReady();
    return Object.freeze({
      credentialKind,
      credentials: publicCredentialSummary(this.credentials),
      tunnelStarted: tunnel?.started === true,
    });
  }

  async startIfReady() {
    if (this.config.enabled !== true) return Object.freeze({ started: false, reason: 'disabled' });
    if (!this.credentials) this.credentials = await this.store.load();
    if (!this.credentials) return Object.freeze({ started: false, reason: 'credentials-required' });
    if (!credentialsMatchConfig(this.credentials, this.config)) {
      return Object.freeze({ started: false, reason: 'credentials-endpoint-mismatch' });
    }
    if (this.tunnelHandle) return Object.freeze({ started: false, reason: 'already-running' });
    return this.startTunnel();
  }

  startTunnel() {
    if (!this.credentials) throw new Error('plugin tunnel credentials required');
    if (this.tunnelHandle) return Object.freeze({ started: false, reason: 'already-running', handle: this.tunnelHandle });
    const handle = this.adapter.start({
      credentials: this.credentials,
      onStatus: (level, message) => {
        this.lastStatus = { level, message, observedAt: new Date().toISOString() };
      },
      onHistoryEvent: (event) => this.#recordHistoryEvent(event),
    });
    this.tunnelHandle = handle;
    handle.promise.catch((error) => {
      this.lastError = error;
    }).finally(() => {
      if (this.tunnelHandle === handle) this.tunnelHandle = null;
    });
    return Object.freeze({ started: true, handle });
  }

  stopTunnel() {
    const handle = this.tunnelHandle;
    if (!handle) return Object.freeze({ stopped: false, reason: 'not-running' });
    this.tunnelHandle = null;
    handle.stop();
    return Object.freeze({ stopped: true });
  }

  stop() {
    return this.stopTunnel();
  }

  async rotateInstanceToken({ restart = true } = {}) {
    if (!this.credentials) this.credentials = await this.store.load();
    if (!this.credentials) throw new Error('plugin credentials required');
    const wasRunning = !!this.tunnelHandle;
    const oldHandle = this.tunnelHandle;
    if (wasRunning) {
      this.stopTunnel();
      await oldHandle.promise.catch(() => null);
    }
    const result = await this.rotateToken({ creds: this.credentials, store: this.store });
    this.credentials = result.creds;
    this.lastError = null;
    if (restart && wasRunning && this.config.enabled === true) await this.startIfReady();
    return Object.freeze({
      credentials: publicCredentialSummary(this.credentials),
      tokenExpiresAt: result.body?.instanceTokenExpiresAt ?? null,
      tokenRenewalUntil: result.body?.instanceTokenRenewalUntil ?? null,
      overlapUntil: result.body?.overlapUntil ?? null,
    });
  }

  async rotate() {
    return this.rotateInstanceToken();
  }

  async leave() {
    if (!this.credentials) this.credentials = await this.store.load();
    if (!this.credentials) throw new Error('plugin credentials required');
    const oldHandle = this.tunnelHandle;
    this.stopTunnel();
    await oldHandle?.promise.catch(() => null);
    const result = await this.revokeSelf({ creds: this.credentials, store: this.store });
    this.credentials = null;
    this.lastStatus = null;
    this.lastError = null;
    this.historyEvents = [];
    return Object.freeze(result);
  }

  #recordHistoryEvent(event) {
    this.historyEvents.push(publicHistoryEvent(event));
    if (this.historyEvents.length > HISTORY_EVENT_RING_SIZE) {
      this.historyEvents.splice(0, this.historyEvents.length - HISTORY_EVENT_RING_SIZE);
    }
  }
}
