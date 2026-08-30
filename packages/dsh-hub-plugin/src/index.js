import { Service } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { publicDeploymentMode } from 'dsh-hub-client/src/deployment-mode.js';
import { createPluginTunnelAdapter, describePluginTunnelAdapter } from './tunnel-adapter.js';
import { PluginCredentialStore, resolvePluginConfigDir } from './credential-store.js';
import { PluginRuntime, redactPluginSecrets } from './runtime.js';
import { diagnosePluginLocalDsh } from './diagnostics.js';
import { createPluginStatusView } from './status-view.js';
import {
  DSH_HUB_MODEL_SETTINGS_ENDPOINT,
  DSH_HUB_MODEL_SETTINGS_TEST_ENDPOINT,
  hostedModelSettingsPreflight,
  readHostedModelSettings,
  readJsonBody,
  sameOrigin,
  saveHostedModelSettings,
  testHostedModelSettings,
  publicHostedModelSettingsPreflight,
} from './model-settings.js';

export const name = 'dsh-hub-plugin';
export const DSH_HUB_PLUGIN_VERSION = '0.1.3';
export const DSH_HUB_SETTINGS_NAMESPACE = settingsNamespace('dsh-hub');
export const DSH_HUB_SERVICE_NAME = 'dshHubPlugin';
export const DSH_HUB_REMOTE_CAPABILITIES_PATCH = 'dsh-hub-plugin/remote-capabilities.patch.yml';
export const DSH_HUB_HOSTED_CAPABILITIES_PATCH = 'dsh-hub-plugin/hosted-capabilities.patch.yml';
export const DSH_HUB_BROWSER_STATUS_ENDPOINT = '/plugins/dsh-hub-plugin/status.json';
const DISABLE_FLAG_VALUES = new Set(['0', 'false', 'off', 'no', 'disabled']);

export const Config = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(''),
  namespace: z.string().default(''),
  instanceName: z.string().default(''),
  deploymentMode: z.string().default('remote'),
  historyAutoLoad: z.boolean().default(true),
});

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function webServerSnapshot(webServer) {
  return {
    host: typeof webServer?.host === 'string' ? webServer.host : null,
    port: Number.isInteger(webServer?.port) ? webServer.port : null,
  };
}

function publicRuntimeStatus(status) {
  if (!status) return null;
  return Object.freeze({
    ...status,
    message: redactPluginSecrets(status.message),
  });
}

function publicHistoryDiagnostics(value) {
  const recent = Array.isArray(value?.recent)
    ? value.recent.slice(-20).map(publicHistoryEvent)
    : [];
  return Object.freeze({
    recent: Object.freeze(recent),
    retained: recent.length,
    limit: 20,
  });
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

export function pluginHistoryAutoLoadEnabled(config = {}, env = process.env) {
  const raw = cleanText(env?.DSH_HUB_HISTORY_AUTOLOAD).toLowerCase();
  if (DISABLE_FLAG_VALUES.has(raw)) return false;
  return config.historyAutoLoad !== false;
}

export function createPluginBrowserStatusPayload(status) {
  return Object.freeze({
    ok: true,
    plugin: name,
    version: DSH_HUB_PLUGIN_VERSION,
    checkedAt: new Date().toISOString(),
    statusView: status?.statusView ?? null,
    capabilities: Object.freeze({
      liveStatusEndpoint: true,
      refreshDiagnostics: true,
      secretsInBrowserPayload: false,
      sessionHistoryAutoLoad: status?.statusView?.capabilities?.sessionHistoryAutoLoad === true,
      sessionHistoryDiagnostics: status?.statusView?.capabilities?.sessionHistoryDiagnostics === true,
      hostedModelSettings: status?.statusView?.capabilities?.hostedModelSettings === true,
    }),
  });
}

function jsonHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra,
  };
}

function writeJson(res, statusCode, body, { head = false, headers = {} } = {}) {
  const text = JSON.stringify(body);
  res.writeHead(statusCode, jsonHeaders({
    'content-length': Buffer.byteLength(text),
    ...headers,
  }));
  if (head) {
    res.end();
    return;
  }
  res.end(text);
}

function wantsDiagnosticsRefresh(req) {
  const url = new URL(req.url ?? DSH_HUB_BROWSER_STATUS_ENDPOINT, 'http://dsh-hub-plugin.local');
  const value = url.searchParams.get('refresh');
  return value === '1' || value === 'true';
}

export function registerPluginBrowserStatusEndpoint(ctx, plugin) {
  return ctx.webServer.register({
    kind: 'exact',
    path: DSH_HUB_BROWSER_STATUS_ENDPOINT,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, {
          ok: false,
          error: 'METHOD_NOT_ALLOWED',
        }, {
          head: req.method === 'HEAD',
          headers: { allow: 'GET, HEAD' },
        });
        return;
      }
      if (wantsDiagnosticsRefresh(req)) {
        await plugin.diagnostics({ refresh: true, timeoutMs: 3000 });
      }
      writeJson(res, 200, createPluginBrowserStatusPayload(plugin.status()), {
        head: req.method === 'HEAD',
      });
    },
  });
}

function modelSettingsErrorBody(error) {
  return {
    ok: false,
    error: {
      code: error.code ?? 'MODEL_SETTINGS_ERROR',
      message: redactPluginSecrets(error.message),
      preflight: publicHostedModelSettingsPreflight(error.preflight),
    },
  };
}

export function registerPluginModelSettingsEndpoints(ctx, plugin) {
  const modelSettingsHandler = async (req, res) => {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'origin mismatch' } });
      return;
    }
    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const body = await readHostedModelSettings({
          ctx,
          config: plugin.configSnapshot(),
        });
        writeJson(res, 200, body, { head: req.method === 'HEAD' });
        return;
      }
      if (req.method === 'POST') {
        const input = await readJsonBody(req);
        const body = await saveHostedModelSettings({
          ctx,
          config: plugin.configSnapshot(),
          input,
        });
        writeJson(res, 200, body);
        return;
      }
      writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, {
        headers: { allow: 'GET, HEAD, POST' },
        head: req.method === 'HEAD',
      });
    } catch (error) {
      writeJson(res, error.code === 'HOSTED_PREFLIGHT_FAILED' ? 403 : 400, modelSettingsErrorBody(error));
    }
  };

  const testHandler = async (req, res) => {
    if (!sameOrigin(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'origin mismatch' } });
      return;
    }
    try {
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }, {
          headers: { allow: 'POST' },
          head: req.method === 'HEAD',
        });
        return;
      }
      const input = await readJsonBody(req);
      const body = await testHostedModelSettings({
        ctx,
        config: plugin.configSnapshot(),
        input,
      });
      writeJson(res, 200, body);
    } catch (error) {
      writeJson(res, error.code === 'HOSTED_PREFLIGHT_FAILED' ? 403 : 400, modelSettingsErrorBody(error));
    }
  };

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: DSH_HUB_MODEL_SETTINGS_ENDPOINT, handler: modelSettingsHandler }),
    ctx.webServer.register({ kind: 'exact', path: DSH_HUB_MODEL_SETTINGS_TEST_ENDPOINT, handler: testHandler }),
  ];
  return () => disposers.forEach((dispose) => dispose?.());
}

export function createPluginStatus(config, webServer, runtime = {}, diagnostics = null) {
  const endpoint = cleanText(config.endpoint);
  const namespace = cleanText(config.namespace);
  const enabled = config.enabled === true;
  const configured = endpoint.length > 0 && namespace.length > 0;
  const deploymentMode = publicDeploymentMode(config.deploymentMode);
  const tunnelAdapter = describePluginTunnelAdapter({ config, webServer, runtime });
  const sessionHistoryAutoLoad = pluginHistoryAutoLoadEnabled(config);
  const status = {
    version: DSH_HUB_PLUGIN_VERSION,
    delivery: 'plugin',
    deploymentMode,
    enabled,
    configured,
    connectionState: enabled ? tunnelAdapter.state : 'disabled',
    settingsNamespace: String(DSH_HUB_SETTINGS_NAMESPACE),
    endpointConfigured: endpoint.length > 0,
    namespaceConfigured: namespace.length > 0,
    instanceNameConfigured: cleanText(config.instanceName).length > 0,
    webServer: webServerSnapshot(webServer),
    capabilities: Object.freeze({
      settingsNamespace: true,
      readOnlyStatus: true,
      tunnel: true,
      tunnelAdapter: true,
      pluginJoin: true,
      pluginCredentialStore: true,
      tokenLifecycle: true,
      deploymentModeMetadata: true,
      browserSettingsCard: true,
      directoryPickerAdapter: false,
      hostedRestrictedDirectoryPicker: true,
      openPathAdapter: false,
      openPathCanOpenPathOverlay: true,
      sessionWorkspaceDiagnostics: true,
      sessionHistoryDiagnostics: true,
      sessionHistoryAutoLoad,
      hostedModelSettings: runtime.modelSettingsPreflight?.ok === true,
    }),
    browserSurface: Object.freeze({
      state: 'status-card-available',
      defaultActive: true,
      settingsKey: 'dsh-hub',
      note: 'M4D-4 renders connection and diagnostics summaries when the settings host provides a plugin status view; G1-3 adds remote-origin-gated history autoload; the browser bundle still does not collect or store secrets.',
    }),
    tunnelAdapter,
    credentials: Object.freeze({
      configured: runtime.credentialsConfigured === true,
      deploymentMode,
      instanceId: runtime.instanceId ?? null,
      installationId: runtime.installationId ?? null,
      tokenExpiresAt: runtime.tokenExpiresAt ?? null,
      tokenRenewalUntil: runtime.tokenRenewalUntil ?? null,
    }),
    lastStatus: publicRuntimeStatus(runtime.lastStatus),
    lastError: redactPluginSecrets(runtime.lastError) ?? null,
    historyDiagnostics: publicHistoryDiagnostics(runtime.historyDiagnostics),
    modelSettings: Object.freeze({
      endpoint: DSH_HUB_MODEL_SETTINGS_ENDPOINT,
      testEndpoint: DSH_HUB_MODEL_SETTINGS_TEST_ENDPOINT,
      preflight: runtime.modelSettingsPreflight ?? null,
    }),
    diagnostics,
    hostCapabilities: Object.freeze({
      directoryPicker: Object.freeze({
        state: 'overlay-available',
        defaultActive: false,
        overlay: DSH_HUB_REMOTE_CAPABILITIES_PATCH,
        hostedOverlay: DSH_HUB_HOSTED_CAPABILITIES_PATCH,
        hostedRoot: '/workspace',
        remoteBehavior: 'browse-picker',
        hostedBehavior: 'restricted-browse-picker',
        note: 'Apply the explicit M4C remote capabilities overlay for general remote browse picker. Hosted DSH should apply the G11 hosted overlay to restrict directory selection to /workspace.',
      }),
      openPath: Object.freeze({
        state: 'can-open-path-overlay-available',
        defaultActive: false,
        overlay: DSH_HUB_REMOTE_CAPABILITIES_PATCH,
        nativeIntercept: false,
        directRpcIntercept: false,
        canOpenPathDisableOverlayAvailable: true,
        remoteBehavior: 'ui-gated-local-only',
        note: 'Apply the explicit M4D-6 remote capabilities overlay to set api-gateway.config.nativeOpen=false. This makes DSH host.describe.canOpenPath=false for UI gating; it does not intercept direct host.openPath RPC or provide a remote openPath replacement.',
      }),
    }),
    message: enabled
      ? 'M4D-4 plugin status and session/workspace diagnostics summaries are available; registry key and replacement grant remain one-shot in-memory inputs.'
      : 'dsh-hub plugin is disabled by default and has no runtime side effects.',
  };
  status.statusView = createPluginStatusView({ config, status });
  return Object.freeze(status);
}

export default class DshHubPlugin extends Service {
  static Config = Config;
  static inject = ['webServer'];

  #source;
  #status;
  #tunnelAdapter;
  #runtime;
  #diagnostics;
  #ready;
  #ctx;

  constructor(ctx, config = {}) {
    super(ctx, DSH_HUB_SERVICE_NAME);
    this.#ctx = ctx;
    this.webServer = ctx.webServer;
    this.#source = () => config;
    this.#tunnelAdapter = createPluginTunnelAdapter({ config, webServer: this.webServer });
    this.#runtime = new PluginRuntime({
      config,
      webServer: this.webServer,
      store: new PluginCredentialStore(resolvePluginConfigDir(config)),
    });
    this.#diagnostics = null;
    this.#status = createPluginStatus(config, this.webServer, this.#runtime.status(), this.#diagnostics);
    this.#ready = this.#runtime.initialize().then(() => this.#refreshStatus()).catch((error) => {
      this.#status = createPluginStatus(config, this.webServer, {
        ...this.#runtime.status(),
        lastError: redactPluginSecrets(error?.message ?? String(error)),
      }, this.#diagnostics);
    });
    ctx.effect(() => registerPluginBrowserStatusEndpoint(ctx, this), 'dsh-hub-plugin: browser status endpoint');
    ctx.effect(() => registerPluginModelSettingsEndpoints(ctx, this), 'dsh-hub-plugin: hosted model settings endpoint');
    installSettingsSection(ctx, DSH_HUB_SETTINGS_NAMESPACE, Config, config, {
      setSource: (source) => {
        this.#source = source;
      },
      onChange: () => {
        const source = this.#source();
        this.#tunnelAdapter = createPluginTunnelAdapter({ config: source, webServer: this.webServer });
        this.#runtime.updateConfig(source);
        this.#diagnostics = null;
        this.#refreshStatus();
        if (source.enabled === true) {
          void this.#runtime.startIfReady().finally(() => this.#refreshStatus());
        }
      },
    });
    ctx.effect(() => () => {
      this.#runtime.stop('plugin unloaded');
    }, 'dsh-hub-plugin runtime cleanup');
  }

  #refreshStatus() {
    const source = this.#source();
    this.#status = createPluginStatus(source, this.webServer, {
      ...this.#runtime.status(),
      modelSettingsPreflight: hostedModelSettingsPreflight({
        ctx: this.#ctx,
        config: source,
      }),
    }, this.#diagnostics);
    return this.#status;
  }

  ready() {
    return this.#ready;
  }

  status() {
    return this.#refreshStatus();
  }

  configSnapshot() {
    return this.#source();
  }

  describe() {
    return this.status();
  }

  async diagnostics({ refresh = true, timeoutMs = 3000 } = {}) {
    await this.#ready;
    if (refresh || !this.#diagnostics) {
      this.#diagnostics = await diagnosePluginLocalDsh({ webServer: this.webServer, timeoutMs });
    }
    this.#refreshStatus();
    return this.#diagnostics;
  }

  tunnelAdapter() {
    return this.#tunnelAdapter;
  }

  async join(input = {}) {
    await this.#ready;
    const result = await this.#runtime.join(input);
    this.#refreshStatus();
    return result;
  }

  async startTunnel() {
    await this.#ready;
    const result = await this.#runtime.startIfReady();
    this.#refreshStatus();
    return result;
  }

  stopTunnel(reason) {
    const result = this.#runtime.stop(reason);
    this.#refreshStatus();
    return result;
  }

  async rotateToken() {
    await this.#ready;
    const result = await this.#runtime.rotate();
    this.#refreshStatus();
    return result;
  }

  async leave() {
    await this.#ready;
    const result = await this.#runtime.leave();
    this.#refreshStatus();
    return result;
  }
}
