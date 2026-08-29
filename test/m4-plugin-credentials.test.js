import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PluginCredentialStore } from '../packages/dsh-hub-plugin/src/credential-store.js';
import { PluginRuntime } from '../packages/dsh-hub-plugin/src/runtime.js';
import { createPluginStatus } from '../packages/dsh-hub-plugin/src/index.js';
import { createPluginTunnelAdapter } from '../packages/dsh-hub-plugin/src/tunnel-adapter.js';

function tempConfigDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-hub-plugin-'));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function createRunner(calls, { waitForAbort = false } = {}) {
  return async (...args) => {
    calls.push(args);
    const hooks = args[2];
    if (waitForAbort) {
      await new Promise((resolve) => hooks.signal.addEventListener('abort', resolve, { once: true }));
    }
    return { ok: true };
  };
}

test('M4D-3 plugin join uses registry key once, stores only instance credentials, and starts plugin tunnel when enabled', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  const runnerCalls = [];
  const registerCalls = [];
  const runtime = new PluginRuntime({
    config: {
      enabled: true,
      endpoint: 'https://hub.example/',
      instanceName: 'devbox',
      configDir: dir,
    },
    webServer: { host: '127.0.0.1', port: 38130 },
    store,
    adapterFactory: (options) => createPluginTunnelAdapter({ ...options, runner: createRunner(runnerCalls) }),
    register: async (input) => {
      registerCalls.push(input);
      return {
        instanceId: 'inst-plugin',
        instanceToken: 'dht_plugin_secret',
        instanceTokenExpiresAt: '2026-09-20T00:00:00.000Z',
        instanceTokenRenewalUntil: '2026-09-27T00:00:00.000Z',
      };
    },
  });

  const result = await runtime.join({ registryKey: 'dhk_join_secret' });

  assert.equal(registerCalls.length, 1);
  assert.equal(registerCalls[0].registryKey, 'dhk_join_secret');
  assert.equal(registerCalls[0].replacementGrant, null);
  assert.equal(registerCalls[0].delivery, 'plugin');
  assert.match(registerCalls[0].installationId, /^insl_[A-Za-z0-9_-]{22}$/);
  assert.equal(result.tunnelStarted, true);
  assert.equal(JSON.stringify(result).includes('dhk_join_secret'), false);
  assert.equal(JSON.stringify(result).includes('dht_plugin_secret'), false);

  const saved = readJson(join(dir, 'credentials.json'));
  assert.equal(saved.endpoint, 'https://hub.example');
  assert.equal(saved.instanceId, 'inst-plugin');
  assert.equal(saved.instanceToken, 'dht_plugin_secret');
  assert.equal(saved.delivery, 'plugin');
  assert.equal(saved.target, '127.0.0.1:38130');
  assert.equal('registryKey' in saved, false);
  assert.equal('replacementGrant' in saved, false);
  assert.equal((statSync(join(dir, 'credentials.json')).mode & 0o777), 0o600);

  const [tunnelConfig, tunnelCreds, hooks] = runnerCalls[0];
  assert.equal(tunnelConfig.endpoint, 'https://hub.example');
  assert.equal(tunnelConfig.delivery, 'plugin');
  assert.equal(tunnelCreds.delivery, 'plugin');
  assert.equal(tunnelCreds.instanceToken, 'dht_plugin_secret');
  assert.equal(hooks.installSignalHandlers, false);
});

test('M4D-3 replacement grant join reuses installation ID and does not persist the grant', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  const installationId = await store.ensureInstallationId();
  const registerCalls = [];
  const runtime = new PluginRuntime({
    config: { enabled: false, endpoint: 'https://hub.example', configDir: dir },
    webServer: { host: '127.0.0.1', port: 38131 },
    store,
    register: async (input) => {
      registerCalls.push(input);
      return {
        instanceId: 'inst-restored',
        instanceToken: 'dht_restored_secret',
      };
    },
  });

  const result = await runtime.join({ replacementGrant: 'dhr_restore_secret' });

  assert.equal(registerCalls[0].registryKey, null);
  assert.equal(registerCalls[0].replacementGrant, 'dhr_restore_secret');
  assert.equal(registerCalls[0].delivery, 'plugin');
  assert.equal(registerCalls[0].installationId, installationId);
  assert.equal(result.credentialKind, 'replacement');
  assert.equal(JSON.stringify(result).includes('dhr_restore_secret'), false);

  const saved = readJson(join(dir, 'credentials.json'));
  assert.equal(saved.instanceId, 'inst-restored');
  assert.equal(saved.installationId, installationId);
  assert.equal('replacementGrant' in saved, false);
});

test('M4D-3 join refuses unavailable plugin loopback target before calling register', async () => {
  const dir = tempConfigDir();
  let registerCalled = false;
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example', configDir: dir },
    webServer: { host: '0.0.0.0', port: 38131 },
    store: new PluginCredentialStore(dir),
    register: async () => {
      registerCalled = true;
      return { instanceId: 'inst-never', instanceToken: 'dht_never' };
    },
  });

  await assert.rejects(
    runtime.join({ registryKey: 'dhk_join_secret' }),
    /plugin tunnel target unavailable/,
  );
  assert.equal(registerCalled, false);
});

test('M4D-3 join rejects registry key rejoin when instance credentials already exist', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-existing',
    instanceToken: 'dht_existing_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  let registerCalled = false;
  const runtime = new PluginRuntime({
    config: { enabled: false, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38135 },
    store,
    register: async () => {
      registerCalled = true;
      return { instanceId: 'inst-never', instanceToken: 'dht_never' };
    },
  });
  await runtime.initialize();

  await assert.rejects(
    runtime.join({ registryKey: 'dhk_join_secret' }),
    /already has instance credentials/,
  );
  assert.equal(registerCalled, false);
});

test('M4D-3 replacement grant recovery stops old tunnel before registering replacement credentials', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-existing',
    instanceToken: 'dht_existing_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runnerCalls = [];
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38136 },
    store,
    adapterFactory: (options) => createPluginTunnelAdapter({
      ...options,
      runner: createRunner(runnerCalls, { waitForAbort: true }),
    }),
    register: async (input) => {
      assert.equal(input.registryKey, null);
      assert.equal(input.replacementGrant, 'dhr_restore_secret');
      return { instanceId: 'inst-existing', instanceToken: 'dht_restored_secret' };
    },
  });
  await runtime.initialize();
  assert.equal(runnerCalls.length, 1);

  const result = await runtime.join({ replacementGrant: 'dhr_restore_secret' });

  assert.equal(result.credentialKind, 'replacement');
  assert.equal(readJson(join(dir, 'credentials.json')).instanceToken, 'dht_restored_secret');
  assert.equal(runnerCalls.length, 2);
});

test('M4D-3 enabled route change stops old tunnel and refuses old-endpoint credentials', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://old.example',
    instanceId: 'inst-existing',
    instanceToken: 'dht_existing_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runnerCalls = [];
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://old.example' },
    webServer: { host: '127.0.0.1', port: 38137 },
    store,
    adapterFactory: (options) => createPluginTunnelAdapter({
      ...options,
      runner: createRunner(runnerCalls, { waitForAbort: true }),
    }),
  });
  await runtime.initialize();
  assert.equal(runnerCalls.length, 1);

  runtime.updateConfig({ enabled: true, endpoint: 'https://new.example' });
  const restarted = await runtime.startIfReady();

  assert.equal(restarted.started, false);
  assert.equal(restarted.reason, 'credentials-endpoint-mismatch');
  assert.equal(runnerCalls.length, 1);
  assert.equal(runtime.status().credentialsConfigured, false);
});

test('M4D-3 join rejects missing endpoint before register', async () => {
  const dir = tempConfigDir();
  let registerCalled = false;
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: '' },
    webServer: { host: '127.0.0.1', port: 38138 },
    store: new PluginCredentialStore(dir),
    register: async () => {
      registerCalled = true;
      return { instanceId: 'inst-never', instanceToken: 'dht_never' };
    },
  });

  await assert.rejects(
    runtime.join({ registryKey: 'dhk_join_secret' }),
    /endpoint required/,
  );
  assert.equal(registerCalled, false);
});

test('M4D-3 runtime auto-starts when enabled credentials already exist', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-existing',
    instanceToken: 'dht_existing_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runnerCalls = [];
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example', configDir: dir },
    webServer: { host: '127.0.0.1', port: 38132 },
    store,
    adapterFactory: (options) => createPluginTunnelAdapter({ ...options, runner: createRunner(runnerCalls) }),
  });

  const status = await runtime.initialize();

  assert.equal(status.tunnelAdapter.credentialsConfigured, true);
  assert.equal(runnerCalls.length, 1);
  assert.equal(runnerCalls[0][1].instanceId, 'inst-existing');
});

test('M4D-3 rotate and leave update stored instance credentials without registry key fallback', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-token',
    instanceToken: 'dht_old_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runnerCalls = [];
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example', configDir: dir },
    webServer: { host: '127.0.0.1', port: 38133 },
    store,
    adapterFactory: (options) => createPluginTunnelAdapter({
      ...options,
      runner: createRunner(runnerCalls, { waitForAbort: true }),
    }),
    rotateToken: async ({ creds, store: tokenStore }) => {
      assert.equal(creds.instanceToken, 'dht_old_secret');
      const next = { ...creds, instanceToken: 'dht_new_secret' };
      await tokenStore.save(next);
      return { body: { instanceToken: 'dht_new_secret' }, creds: next };
    },
    revokeSelf: async ({ creds, store: revokeStore }) => {
      assert.equal(creds.instanceToken, 'dht_new_secret');
      await revokeStore.clear();
      return { cleared: true, alreadyRevoked: false };
    },
  });
  await runtime.initialize();

  const rotated = await runtime.rotate();
  assert.equal(JSON.stringify(rotated).includes('dht_new_secret'), false);
  assert.equal(readJson(join(dir, 'credentials.json')).instanceToken, 'dht_new_secret');
  assert.equal(runnerCalls.length, 2);

  const leave = await runtime.leave();
  assert.equal(leave.cleared, true);
  assert.equal(await store.load(), null);
  assert.equal(runtime.status().credentialsConfigured, false);
});

test('M4D-3 status reports credential readiness without exposing instance token', () => {
  const status = createPluginStatus({
    enabled: true,
    endpoint: 'https://hub.example',
    namespace: 'team',
    instanceName: 'devbox',
  }, { host: '127.0.0.1', port: 38134 }, {
    credentialsConfigured: true,
    instanceId: 'inst-safe',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    tokenExpiresAt: '2026-09-20T00:00:00.000Z',
    tokenRenewalUntil: '2026-09-27T00:00:00.000Z',
  });

  assert.equal(status.connectionState, 'ready');
  assert.equal(status.capabilities.pluginJoin, true);
  assert.equal(status.capabilities.pluginCredentialStore, true);
  assert.equal(status.credentials.instanceId, 'inst-safe');
  assert.equal(JSON.stringify(status).includes('dht_'), false);
});

test('M4D-3 public status redacts secrets from runtime errors and status messages', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-redact',
    instanceToken: 'dht_saved_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38139 },
    store,
    adapterFactory: () => ({
      target: { ok: true, authority: '127.0.0.1:38139' },
      start({ onStatus }) {
        onStatus('disconnected', 'lost dht_status_secret and dit_legacy_secret in /workspace/example');
        return {
          promise: Promise.reject(new Error('register failed with dhk_join_secret and dhr_restore_secret at C:\\Workspace\\example')),
          stop() {},
        };
      },
    }),
  });
  await runtime.initialize();
  await new Promise((resolve) => setImmediate(resolve));

  const runtimeStatus = runtime.status();
  const runtimeDescription = runtime.describe();
  const pluginStatus = createPluginStatus({
    enabled: true,
    endpoint: 'https://hub.example',
    namespace: 'team',
    instanceName: 'devbox',
  }, { host: '127.0.0.1', port: 38139 }, runtimeStatus);

  for (const payload of [runtimeStatus, runtimeDescription, pluginStatus]) {
    const text = JSON.stringify(payload);
    assert.equal(text.includes('dht_status_secret'), false);
    assert.equal(text.includes('dit_legacy_secret'), false);
    assert.equal(text.includes('dhk_join_secret'), false);
    assert.equal(text.includes('dhr_restore_secret'), false);
    assert.equal(text.includes('/workspace/example'), false);
    assert.equal(text.includes('C:\\Users\\alice'), false);
    assert.match(text, /\[redacted-secret\]/);
    assert.match(text, /\[redacted-path\]/);
  }
});

test('G1-4 plugin runtime exposes only recent count-only history diagnostics', async () => {
  const dir = tempConfigDir();
  const store = new PluginCredentialStore(dir);
  await store.save({
    endpoint: 'https://hub.example',
    instanceId: 'inst-history',
    instanceToken: 'dht_saved_secret',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    delivery: 'plugin',
  });
  const runtime = new PluginRuntime({
    config: { enabled: true, endpoint: 'https://hub.example' },
    webServer: { host: '127.0.0.1', port: 38140 },
    store,
    adapterFactory: () => ({
      target: { ok: true, authority: '127.0.0.1:38140' },
      start({ onHistoryEvent }) {
        for (let index = 0; index < 21; index += 1) {
          onHistoryEvent({
            requestId: `hist-${index}`,
            method: 'session.history',
            path: index === 20 ? '/Users/alice/private' : '/api/session.history',
            status: 200,
            requestBytes: 10 + index,
            rawResponseBytes: 100 + index,
            normalizedBytes: 50 + index,
            elapsedMs: index,
            errorCode: index === 20 ? 'HISTORY_UNSUPPORTED_ENCODING' : null,
            terminalState: index === 20 ? 'error' : 'ok',
            contentEncoding: index === 20 ? 'gzip dht_secret' : 'identity',
            normalized: index !== 20,
          });
        }
        return {
          promise: new Promise(() => {}),
          stop() {},
        };
      },
    }),
  });
  await runtime.initialize();

  const status = runtime.status();
  assert.equal(status.historyDiagnostics.retained, 20);
  assert.equal(status.historyDiagnostics.limit, 20);
  assert.equal(status.historyDiagnostics.recent[0].requestId, 'hist-1');
  assert.equal(status.historyDiagnostics.recent[19].requestId, 'hist-20');
  assert.equal(status.historyDiagnostics.recent[19].path, null);
  assert.equal(status.historyDiagnostics.recent[19].contentEncoding, 'redacted');
  const pluginStatus = createPluginStatus({
    enabled: true,
    endpoint: 'https://hub.example',
    namespace: 'team',
  }, { host: '127.0.0.1', port: 38140 }, status);
  assert.equal(pluginStatus.statusView.diagnostics.historyRelay.recent.length, 20);
  const text = JSON.stringify(pluginStatus);
  assert.equal(text.includes('dht_secret'), false);
  assert.equal(text.includes('/Users/alice/private'), false);
});
