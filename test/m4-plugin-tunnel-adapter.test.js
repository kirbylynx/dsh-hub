import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

import { runTunnel } from '../packages/dsh-hub-client/src/tunnel.js';
import { createPluginStatus } from '../packages/dsh-hub-plugin/src/index.js';
import {
  PLUGIN_TUNNEL_DELIVERY,
  createPluginTunnelAdapter,
  createPluginTunnelTarget,
  describePluginTunnelAdapter,
} from '../packages/dsh-hub-plugin/src/tunnel-adapter.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PLUGIN_ROOT = join(ROOT, 'packages/dsh-hub-plugin');
const CLIENT_ROOT = join(ROOT, 'packages/dsh-hub-client');

function readText(path) {
  return readFileSync(path, 'utf8');
}

test('M4D-2 plugin tunnel target is fixed to in-process loopback webServer', () => {
  assert.deepEqual(createPluginTunnelTarget({ host: '127.0.0.1', port: 3080 }), {
    ok: true,
    host: '127.0.0.1',
    port: 3080,
    authority: '127.0.0.1:3080',
  });
  assert.deepEqual(createPluginTunnelTarget({ host: 'localhost', port: 4096 }), {
    ok: true,
    host: '127.0.0.1',
    port: 4096,
    authority: '127.0.0.1:4096',
  });
  assert.deepEqual(createPluginTunnelTarget({ host: '::1', port: 4097 }), {
    ok: true,
    host: '::1',
    port: 4097,
    authority: '[::1]:4097',
  });
  assert.equal(createPluginTunnelTarget({ host: '0.0.0.0', port: 3080 }).ok, false);
  assert.equal(createPluginTunnelTarget({ host: '192.0.2.10', port: 3080 }).ok, false);
  assert.equal(createPluginTunnelTarget({ host: '127.0.0.1', port: 0 }).ok, false);
});

test('M4D status exposes adapter readiness and waits for credentials before startup', () => {
  const disabled = createPluginStatus({
    enabled: false,
    endpoint: '',
    namespace: '',
    instanceName: '',
  }, { host: '127.0.0.1', port: 3080 });
  assert.equal(disabled.connectionState, 'disabled');
  assert.equal(disabled.capabilities.tunnel, true);
  assert.equal(disabled.capabilities.tunnelAdapter, true);
  assert.equal(disabled.tunnelAdapter.active, false);
  assert.equal(disabled.tunnelAdapter.state, 'disabled');

  const enabled = createPluginStatus({
    enabled: true,
    endpoint: 'https://hub.example',
    namespace: 'team',
    instanceName: 'devbox',
  }, { host: '127.0.0.1', port: 3080 });
  assert.equal(enabled.connectionState, 'credentials-required');
  assert.equal(enabled.tunnelAdapter.active, false);
  assert.equal(enabled.tunnelAdapter.delivery, PLUGIN_TUNNEL_DELIVERY);
  assert.equal(enabled.tunnelAdapter.target.authority, '127.0.0.1:3080');
  assert.deepEqual(enabled.tunnelAdapter.requiredCredentials, [
    'endpoint',
    'instanceId',
    'instanceToken',
    'installationId',
  ]);

  const unsupported = describePluginTunnelAdapter({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '0.0.0.0', port: 3080 },
  });
  assert.equal(unsupported.state, 'target-unavailable');
});

test('M4D-2 adapter starts shared runner with plugin delivery and ephemeral credentials only', async () => {
  const calls = [];
  const onHistoryEvent = () => {};
  const adapter = createPluginTunnelAdapter({
    config: {
      enabled: true,
      endpoint: 'https://hub.example/',
      namespace: 'team',
      instanceName: 'devbox',
    },
    webServer: { host: '127.0.0.1', port: 38123 },
    runner: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  });
  const handle = adapter.start({
    credentials: {
      instanceId: 'inst-test',
      instanceToken: 'dit_test',
      installationId: 'insl_test',
      dshVersion: '0.1.0-rc.7',
    },
    onHistoryEvent,
  });
  await handle.promise;
  assert.equal(calls.length, 1);
  const [config, creds, hooks] = calls[0];
  assert.equal(config.endpoint, 'https://hub.example');
  assert.equal(config.delivery, 'plugin');
  assert.equal(creds.delivery, 'plugin');
  assert.equal(creds.target, '127.0.0.1:38123');
  assert.equal(creds.instanceId, 'inst-test');
  assert.equal(creds.instanceToken, 'dit_test');
  assert.equal(hooks.delivery, 'plugin');
  assert.equal(hooks.installSignalHandlers, false);
  assert.equal(hooks.onHistoryEvent, onHistoryEvent);
  assert.ok(hooks.signal instanceof AbortSignal);
  assert.equal(typeof handle.stop, 'function');
});

test('M4D-2 adapter handle.stop aborts internal signal even when external signal is supplied', async () => {
  let capturedHooks;
  const external = new AbortController();
  const adapter = createPluginTunnelAdapter({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38124 },
    runner: async (_config, _creds, hooks) => {
      capturedHooks = hooks;
      await new Promise((resolve) => hooks.signal.addEventListener('abort', resolve, { once: true }));
      return { ok: true };
    },
  });
  const handle = adapter.start({
    signal: external.signal,
    credentials: {
      instanceId: 'inst-test',
      instanceToken: 'dit_test',
      installationId: 'insl_test',
    },
  });
  assert.equal(capturedHooks.signal.aborted, false);
  handle.stop();
  await handle.promise;
  assert.equal(capturedHooks.signal.aborted, true);

  const second = createPluginTunnelAdapter({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38125 },
    runner: async (_config, _creds, hooks) => {
      capturedHooks = hooks;
      return { ok: true };
    },
  });
  const secondExternal = new AbortController();
  secondExternal.abort();
  await second.start({
    signal: secondExternal.signal,
    credentials: {
      instanceId: 'inst-test',
      instanceToken: 'dit_test',
      installationId: 'insl_test',
    },
  }).promise;
  assert.equal(capturedHooks.signal.aborted, true);
});

test('M4D-2 adapter refuses to start without in-memory instance credentials', () => {
  const adapter = createPluginTunnelAdapter({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 3080 },
    runner: async () => {
      throw new Error('runner should not be called');
    },
  });
  assert.throws(() => adapter.start({ credentials: {} }), /instanceId, instanceToken, installationId/);
});

test('M4D-2 shared runner aborts plugin handshake before welcome without connected status', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, 'listening');
  const sockets = [];
  wss.on('connection', (socket) => {
    sockets.push(socket);
  });
  const endpoint = `http://127.0.0.1:${wss.address().port}`;
  const controller = new AbortController();
  const statuses = [];
  const started = runTunnel({
    endpoint,
    heartbeatMs: 1000,
    healthMs: 1000,
  }, {
    instanceId: 'inst-test',
    instanceToken: 'dit_test',
    installationId: 'insl_test',
    delivery: 'plugin',
    target: '127.0.0.1:3080',
  }, {
    delivery: 'plugin',
    installSignalHandlers: false,
    signal: controller.signal,
    onStatus: (level, message) => statuses.push({ level, message }),
  });
  await once(wss, 'connection');
  controller.abort();
  const result = await withTimeout(started, 1500, 'plugin runTunnel should stop during handshake abort');
  assert.deepEqual(result, { ok: true, stopped: true });
  assert.equal(statuses.some((item) => item.level === 'connected'), false);
  await waitFor(() => sockets.every((socket) => socket.readyState === socket.CLOSED), 1000);
  await closeWss(wss);
});

test('M4D-2 plugin mode does not install process signal handlers, agent default cleans them up', async () => {
  const beforeSigint = process.listenerCount('SIGINT');
  const beforeSigterm = process.listenerCount('SIGTERM');
  const pluginController = new AbortController();
  pluginController.abort();
  await runTunnel({
    endpoint: 'http://127.0.0.1:9',
    heartbeatMs: 1000,
    healthMs: 1000,
  }, {
    instanceId: 'inst-test',
    instanceToken: 'dit_test',
    installationId: 'insl_test',
    delivery: 'plugin',
    target: '127.0.0.1:3080',
  }, {
    delivery: 'plugin',
    installSignalHandlers: false,
    signal: pluginController.signal,
  });
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);

  const agentController = new AbortController();
  agentController.abort();
  await runTunnel({
    endpoint: 'http://127.0.0.1:9',
    heartbeatMs: 1000,
    healthMs: 1000,
  }, {
    instanceId: 'inst-test',
    instanceToken: 'dit_test',
    installationId: 'insl_test',
    delivery: 'agent',
    target: '127.0.0.1:3080',
  }, {
    signal: agentController.signal,
  });
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
});

test('M4D-2 shared runner aborts reconnect backoff promptly after connection failure', async () => {
  const controller = new AbortController();
  const statuses = [];
  const started = runTunnel({
    endpoint: 'http://127.0.0.1:9',
    heartbeatMs: 1000,
    healthMs: 1000,
  }, {
    instanceId: 'inst-test',
    instanceToken: 'dit_test',
    installationId: 'insl_test',
    delivery: 'plugin',
    target: '127.0.0.1:3080',
  }, {
    delivery: 'plugin',
    installSignalHandlers: false,
    signal: controller.signal,
    onStatus: (level, message) => {
      statuses.push({ level, message });
      if (level === 'disconnected') controller.abort();
    },
  });
  const result = await withTimeout(started, 500, 'plugin runTunnel should stop promptly during reconnect backoff abort');
  assert.deepEqual(result, { ok: true, stopped: true });
  assert.equal(statuses.some((item) => item.level === 'connected'), false);
});

test('M4D-2 adapter reuses client tunnel state without join-secret persistence code', () => {
  const adapterSource = readText(join(PLUGIN_ROOT, 'src/tunnel-adapter.js'));
  const pluginSource = readText(join(PLUGIN_ROOT, 'src/index.js'));
  const storeSource = readText(join(PLUGIN_ROOT, 'src/credential-store.js'));
  const clientTunnelSource = readText(join(CLIENT_ROOT, 'src/tunnel.js'));

  assert.match(adapterSource, /dsh-hub-client\/src\/tunnel\.js/);
  assert.match(adapterSource, /runTunnel/);
  assert.match(adapterSource, /installSignalHandlers: false/);
  assert.match(clientTunnelSource, /delivery: options\.delivery/);
  assert.match(clientTunnelSource, /hooks\.signal/);
  assert.doesNotMatch(adapterSource, /CredentialStore|@napi-rs\/keyring|registryKey|replacementGrant|writeFile|appendFile/);
  assert.doesNotMatch(pluginSource, /@napi-rs\/keyring|registryKey|replacementGrant|writeFile|appendFile/);
  assert.doesNotMatch(storeSource, /@napi-rs\/keyring|registryKey|replacementGrant/);
});

async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fn(), 'condition did not become true before timeout');
}

async function closeWss(wss) {
  for (const client of wss.clients) {
    try { client.close(); } catch { /* noop */ }
  }
  await new Promise((resolve, reject) => {
    wss.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
