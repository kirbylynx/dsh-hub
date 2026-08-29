import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DSH_HUB_BROWSER_STATUS_ENDPOINT,
  createPluginBrowserStatusPayload,
  createPluginStatus,
  pluginHistoryAutoLoadEnabled,
  registerPluginBrowserStatusEndpoint,
} from '../packages/dsh-hub-plugin/src/index.js';
import { diagnosePluginLocalDsh, summarizePluginDiagnostics } from '../packages/dsh-hub-plugin/src/diagnostics.js';
import { inferPluginInstanceUrl } from '../packages/dsh-hub-plugin/src/status-view.js';

test('M4D-4 status view exposes connection, instance URL hint, protocol, and diagnostics summary', () => {
  const status = createPluginStatus({
    enabled: true,
    endpoint: 'https://control.hub.example.com',
    namespace: 'team',
    instanceName: 'devbox',
  }, { host: '127.0.0.1', port: 38140 }, {
    credentialsConfigured: true,
    active: true,
    state: 'tunnel-running',
    instanceId: 'inst-abcdefghijklmnopqrstuvwxyz',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    tokenExpiresAt: '2026-09-20T00:00:00.000Z',
    tokenRenewalUntil: '2026-09-27T00:00:00.000Z',
    lastStatus: { level: 'connected', message: 'connected with dht_status_secret' },
    lastError: 'failed at /Volumes/workspace/team dhr_runtime_secret',
    historyDiagnostics: {
      retained: 1,
      limit: 20,
      recent: [{
        requestId: 'hist-1',
        method: 'session.history',
        path: '/api/session.history',
        status: 200,
        requestBytes: 120,
        rawResponseBytes: 7_000_000,
        normalizedBytes: 0,
        elapsedMs: 2400,
        errorCode: 'HISTORY_UNSUPPORTED_ENCODING',
        terminalState: 'error',
        contentEncoding: 'gzip',
        normalized: false,
      }],
    },
  }, {
    state: 'ok',
    checkedAt: '2026-08-22T00:00:00.000Z',
    dshApi: {
      sessionList: { ok: true, status: 200, itemCount: 37, error: null },
      workspaceList: { ok: true, status: 200, itemCount: 5, error: null },
    },
    websocket: {
      eventsMux: { opened: true, idle: false, messages: 1, firstBytes: 32, error: null },
      eventsHost: { opened: true, idle: true, messages: 0, firstBytes: 0, error: null },
    },
    workspaceMapping: {
      sessionCount: 37,
      workspaceCount: 5,
      linkedSessionCount: 13,
      unlinkedSessionCount: 24,
      staleWorkspaceSessionCount: 1,
    },
    recommendations: [{ code: 'UNLINKED_SESSIONS', severity: 'info', message: 'Some sessions are not linked.' }],
  });

  assert.equal(status.connectionState, 'tunnel-running');
  assert.equal(status.capabilities.sessionWorkspaceDiagnostics, true);
  assert.equal(status.capabilities.sessionHistoryAutoLoad, true);
  assert.equal(status.statusView.capabilities.sessionHistoryAutoLoad, true);
  assert.equal(status.capabilities.hostedRestrictedDirectoryPicker, true);
  assert.equal(status.statusView.connection.protocol, 'v1.1');
  assert.equal(status.statusView.connection.instanceUrl, 'https://inst-abcdefghijklmnopqrstuvwxyz.instances.hub.example.com/');
  assert.equal(status.statusView.diagnostics.workspaceMapping.unlinkedSessionCount, 24);
  assert.equal(status.capabilities.sessionHistoryDiagnostics, true);
  assert.equal(status.statusView.capabilities.sessionHistoryDiagnostics, true);
  assert.equal(status.statusView.diagnostics.historyRelay.recent[0].errorCode, 'HISTORY_UNSUPPORTED_ENCODING');
  assert.equal(status.statusView.diagnostics.historyRelay.recent[0].rawResponseBytes, 7_000_000);
  assert.equal(status.capabilities.openPathAdapter, false);
  assert.equal(status.capabilities.openPathCanOpenPathOverlay, true);
  assert.equal(status.hostCapabilities.openPath.state, 'can-open-path-overlay-available');
  assert.equal(status.hostCapabilities.openPath.canOpenPathDisableOverlayAvailable, true);
  assert.equal(status.hostCapabilities.openPath.directRpcIntercept, false);
  assert.equal(status.hostCapabilities.directoryPicker.hostedOverlay, 'dsh-hub-plugin/hosted-capabilities.patch.yml');
  assert.equal(status.hostCapabilities.directoryPicker.hostedRoot, '/workspace');
  assert.equal(JSON.stringify(status).includes('dht_status_secret'), false);
  assert.equal(JSON.stringify(status).includes('dhr_runtime_secret'), false);
  assert.equal(JSON.stringify(status).includes('/Volumes/workspace'), false);
});

test('M4D-4 diagnostics summary is count-only and redacts paths and secrets', () => {
  const summary = summarizePluginDiagnostics({
    target: '/Volumes/Project/dsh 127.0.0.1:38141',
    checkedAt: '2026-08-22T00:00:00.000Z',
    root: { online: true, status: 200 },
    api: {
      sessionList: {
        ok: false,
        status: 200,
        itemCount: null,
        error: { code: 'RPC_ERROR', message: 'failed at /workspace/example dht_local_secret' },
      },
      workspaceList: { ok: true, status: 200, itemCount: 2, error: null },
    },
    websocket: {
      eventsMux: { opened: true, idle: false, messages: 1, firstBytes: 10, error: null },
      eventsHost: { opened: true, idle: true, messages: 0, firstBytes: 0, error: 'C:\\Workspace\\example dhr_restore_secret' },
    },
    workspaceMapping: {
      sessionCount: 3,
      workspaceCount: 2,
      linkedSessionCount: 2,
      unlinkedSessionCount: 1,
      unlinkedSessionIds: ['sess-secret'],
      staleWorkspaceSessionCount: 1,
      staleWorkspaceSessionIds: ['sess-stale'],
    },
    hostCapabilities: { inferredDirectoryPicker: 'native', remoteLimited: true },
  });

  const text = JSON.stringify(summary);
  assert.equal(summary.state, 'attention');
  assert.equal(summary.workspaceMapping.unlinkedSessionCount, 1);
  assert.equal(Object.hasOwn(summary.workspaceMapping, 'unlinkedSessionIds'), false);
  assert.equal(text.includes('/workspace/example'), false);
  assert.equal(text.includes('/Volumes/Project'), false);
  assert.equal(text.includes('C:\\Users\\alice'), false);
  assert.equal(text.includes('dht_local_secret'), false);
  assert.equal(text.includes('dhr_restore_secret'), false);
  assert.ok(summary.recommendations.some((item) => item.code === 'OPEN_PATH_LOCAL_ONLY'));
  assert.equal(summary.hostCapabilities.openPath.state, 'can-open-path-overlay-available');
  assert.equal(summary.hostCapabilities.openPath.canOpenPathOverlay, true);
  assert.equal(summary.hostCapabilities.openPath.directRpcIntercept, false);
});

test('M4D-4 plugin local diagnostics uses in-process loopback target and rejects non-loopback target', async () => {
  const observedTargets = [];
  const ok = await diagnosePluginLocalDsh({
    webServer: { host: 'localhost', port: 38142 },
    probe: async (target, options) => {
      observedTargets.push({ target, options });
      return {
        target,
        checkedAt: '2026-08-22T00:00:00.000Z',
        root: { online: true, status: 200 },
        api: {
          sessionList: { ok: true, status: 200, itemCount: 1 },
          workspaceList: { ok: true, status: 200, itemCount: 1 },
        },
        websocket: {
          eventsMux: { opened: true, idle: false, messages: 1, firstBytes: 8 },
          eventsHost: { opened: true, idle: true, messages: 0, firstBytes: 0 },
        },
        workspaceMapping: {
          sessionCount: 1,
          workspaceCount: 1,
          linkedSessionCount: 1,
          unlinkedSessionCount: 0,
          staleWorkspaceSessionCount: 0,
        },
        hostCapabilities: { inferredDirectoryPicker: 'native', remoteLimited: true },
      };
    },
    timeoutMs: 1234,
  });
  assert.equal(observedTargets[0].target, '127.0.0.1:38142');
  assert.equal(observedTargets[0].options.timeoutMs, 1234);
  assert.equal(ok.state, 'ok');

  const unavailable = await diagnosePluginLocalDsh({
    webServer: { host: '0.0.0.0', port: 38142 },
    probe: async () => {
      throw new Error('probe should not be called');
    },
  });
  assert.equal(unavailable.state, 'unavailable');
  assert.ok(unavailable.recommendations.some((item) => item.code === 'TARGET_UNAVAILABLE'));
});

test('M4D-4 instance URL inference supports local and deployed control hosts', () => {
  assert.equal(
    inferPluginInstanceUrl('https://control.hub.example.com', 'inst-abcdefghijklmnopqrstuvwxyz'),
    'https://inst-abcdefghijklmnopqrstuvwxyz.instances.hub.example.com/',
  );
  assert.equal(
    inferPluginInstanceUrl('http://localhost:8081', 'inst-abcdefghijklmnopqrstuvwxyz'),
    'http://inst-abcdefghijklmnopqrstuvwxyz.localhost:8081/',
  );
  assert.equal(inferPluginInstanceUrl('not-a-url', 'inst-abcdefghijklmnopqrstuvwxyz'), null);
  assert.equal(inferPluginInstanceUrl('https://control.hub.example.com', 'inst-short'), null);
});

test('M4D-5 browser status payload is statusView-only and does not expose credentials', () => {
  const status = createPluginStatus({
    enabled: true,
    endpoint: 'https://control.hub.example.com',
    namespace: 'team',
  }, { host: '127.0.0.1', port: 38140 }, {
    credentialsConfigured: true,
    active: true,
    state: 'tunnel-running',
    instanceId: 'inst-abcdefghijklmnopqrstuvwxyz',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    tokenExpiresAt: '2026-09-20T00:00:00.000Z',
    tokenRenewalUntil: '2026-09-27T00:00:00.000Z',
    lastStatus: { level: 'connected', message: 'connected with dht_status_secret' },
  });

  const payload = createPluginBrowserStatusPayload(status);
  const text = JSON.stringify(payload);
  assert.equal(payload.ok, true);
  assert.equal(payload.statusView.connection.state, 'tunnel-running');
  assert.equal(payload.statusView.connection.instanceId, 'inst-abcdefghijklmnopqrstuvwxyz');
  assert.equal(payload.capabilities.liveStatusEndpoint, true);
  assert.equal(payload.capabilities.refreshDiagnostics, true);
  assert.equal(payload.capabilities.sessionHistoryAutoLoad, true);
  assert.equal(payload.capabilities.sessionHistoryDiagnostics, true);
  assert.equal(text.includes('insl_abcdefghijklmnopqrstuv'), false);
  assert.equal(text.includes('dht_status_secret'), false);
  assert.equal(text.includes('tokenExpiresAt'), true, 'token expiry metadata is allowed in the public status view');
  assert.equal(Object.hasOwn(payload, 'credentials'), false);
  assert.equal(Object.hasOwn(payload, 'tunnelAdapter'), false);
});

test('G1-3 history autoload capability can be disabled by config or environment', () => {
  assert.equal(pluginHistoryAutoLoadEnabled({ historyAutoLoad: true }, {}), true);
  assert.equal(pluginHistoryAutoLoadEnabled({ historyAutoLoad: false }, {}), false);
  assert.equal(pluginHistoryAutoLoadEnabled({ historyAutoLoad: true }, { DSH_HUB_HISTORY_AUTOLOAD: 'off' }), false);
  const status = createPluginStatus({
    enabled: true,
    endpoint: 'https://control.hub.example.com',
    namespace: 'team',
    historyAutoLoad: false,
  }, { host: '127.0.0.1', port: 38140 }, {
    credentialsConfigured: true,
    active: true,
    state: 'tunnel-running',
    instanceId: 'inst-abcdefghijklmnopqrstuvwxyz',
  });
  assert.equal(status.capabilities.sessionHistoryAutoLoad, false);
  assert.equal(status.statusView.capabilities.sessionHistoryAutoLoad, false);
  assert.equal(createPluginBrowserStatusPayload(status).capabilities.sessionHistoryAutoLoad, false);
});

test('M4D-5 browser status endpoint supports read and explicit diagnostics refresh', async () => {
  const calls = [];
  let route;
  const ctx = {
    webServer: {
      register(next) {
        route = next;
        return () => {
          route = null;
        };
      },
    },
  };
  const plugin = {
    status() {
      calls.push('status');
      return createPluginStatus({
        enabled: false,
        endpoint: '',
        namespace: '',
      }, { host: '127.0.0.1', port: 38140 }, {}, null);
    },
    async diagnostics(options) {
      calls.push(['diagnostics', options]);
      return { state: 'ok' };
    },
  };
  const dispose = registerPluginBrowserStatusEndpoint(ctx, plugin);
  assert.equal(route.kind, 'exact');
  assert.equal(route.path, DSH_HUB_BROWSER_STATUS_ENDPOINT);

  const read = await invokeRoute(route, 'GET', DSH_HUB_BROWSER_STATUS_ENDPOINT);
  assert.equal(read.statusCode, 200);
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(read.body).statusView.summary.state, 'disabled');
  assert.deepEqual(calls, ['status']);

  const refreshed = await invokeRoute(route, 'GET', `${DSH_HUB_BROWSER_STATUS_ENDPOINT}?refresh=1`);
  assert.equal(refreshed.statusCode, 200);
  assert.deepEqual(calls[1], ['diagnostics', { refresh: true, timeoutMs: 3000 }]);
  assert.equal(JSON.parse(refreshed.body).capabilities.refreshDiagnostics, true);

  const denied = await invokeRoute(route, 'POST', DSH_HUB_BROWSER_STATUS_ENDPOINT);
  assert.equal(denied.statusCode, 405);
  assert.equal(denied.headers.allow, 'GET, HEAD');

  dispose();
  assert.equal(route, null);
});

async function invokeRoute(route, method, url) {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  await route.handler({ method, url }, response);
  return response;
}
