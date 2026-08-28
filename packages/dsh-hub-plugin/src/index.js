import { Service } from '@deepseek-ai/cordis';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import z from '@deepseek-ai/schemastery';
import { createPluginTunnelAdapter, describePluginTunnelAdapter } from './tunnel-adapter.js';
import { PluginCredentialStore, resolvePluginConfigDir } from './credential-store.js';
import { PluginRuntime, redactPluginSecrets } from './runtime.js';
import { diagnosePluginLocalDsh } from './diagnostics.js';
import { createPluginStatusView } from './status-view.js';

export const name = 'dsh-hub-plugin';
export const DSH_HUB_PLUGIN_VERSION = '0.1.0';
export const DSH_HUB_SETTINGS_NAMESPACE = settingsNamespace('dsh-hub');
export const DSH_HUB_SERVICE_NAME = 'dshHubPlugin';
export const DSH_HUB_REMOTE_CAPABILITIES_PATCH = 'dsh-hub-plugin/remote-capabilities.patch.yml';
export const DSH_HUB_HOSTED_CAPABILITIES_PATCH = 'dsh-hub-plugin/hosted-capabilities.patch.yml';
export const DSH_HUB_BROWSER_STATUS_ENDPOINT = '/plugins/dsh-hub-plugin/status.json';

export const Config = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default(''),
  namespace: z.string().default(''),
  instanceName: z.string().default(''),
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

export function createPluginStatus(config, webServer, runtime = {}, diagnostics = null) {
  const endpoint = cleanText(config.endpoint);
  const namespace = cleanText(config.namespace);
  const enabled = config.enabled === true;
  const configured = endpoint.length > 0 && namespace.length > 0;
  const tunnelAdapter = describePluginTunnelAdapter({ config, webServer, runtime });
  const status = {
    version: DSH_HUB_PLUGIN_VERSION,
    delivery: 'plugin',
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
      browserSettingsCard: true,
      directoryPickerAdapter: false,
      hostedRestrictedDirectoryPicker: true,
      openPathAdapter: false,
      openPathCanOpenPathOverlay: true,
      sessionWorkspaceDiagnostics: true,
    }),
    browserSurface: Object.freeze({
      state: 'status-card-available',
      defaultActive: true,
      settingsKey: 'dsh-hub',
      note: 'M4D-4 renders connection and diagnostics summaries when the settings host provides a plugin status view; the browser bundle still does not collect or store secrets.',
    }),
    tunnelAdapter,
    credentials: Object.freeze({
      configured: runtime.credentialsConfigured === true,
      instanceId: runtime.instanceId ?? null,
      installationId: runtime.installationId ?? null,
      tokenExpiresAt: runtime.tokenExpiresAt ?? null,
      tokenRenewalUntil: runtime.tokenRenewalUntil ?? null,
    }),
    lastStatus: publicRuntimeStatus(runtime.lastStatus),
    lastError: redactPluginSecrets(runtime.lastError) ?? null,
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

  constructor(ctx, config = {}) {
    super(ctx, DSH_HUB_SERVICE_NAME);
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
    this.#status = createPluginStatus(this.#source(), this.webServer, this.#runtime.status(), this.#diagnostics);
    return this.#status;
  }

  ready() {
    return this.#ready;
  }

  status() {
    return this.#refreshStatus();
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
