import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { hostedModeMarkerText } from '../packages/dsh-hub-client/src/deployment-mode.js';
import {
  DEEPSEEK_OFFICIAL_API_KEY_REF,
  DSH_HUB_MODEL_SETTINGS_ENDPOINT,
  AGENT_DEFAULT_MODEL_NAMESPACE,
  LLM_DEEPSEEK_NAMESPACE,
  LLM_PI_AI_NAMESPACE,
  hostedModelSettingsPreflight,
  readHostedModelSettings,
  readJsonBody,
  publicHostedModelSettingsPreflight,
  sameOrigin,
  saveHostedModelSettings,
  testHostedModelSettings,
} from '../packages/dsh-hub-plugin/src/model-settings.js';
import {
  createPluginStatus,
  createPluginBrowserStatusPayload,
  registerPluginModelSettingsEndpoints,
} from '../packages/dsh-hub-plugin/src/index.js';

function tempHostedRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-g13-'));
  const configDir = path.join(root, 'plugin');
  const workspaceRoot = path.join(root, 'workspace');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'hosted-mode.json'),
    hostedModeMarkerText({ workspaceRoot }),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const values = {
    [AGENT_DEFAULT_MODEL_NAMESPACE]: {},
    [LLM_DEEPSEEK_NAMESPACE]: {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
    [LLM_PI_AI_NAMESPACE]: {
      providers: {},
    },
  };
  const secrets = new Map();
  let selection = { provider: 'deepseek-official', model: 'deepseek-chat' };
  const ctx = {
    get(name) {
      return this[name];
    },
    settings: {
      writable: true,
      documentPath: path.join(root, 'settings.yaml'),
      describe: () => Object.entries(values).map(([ns, value]) => ({ ns, value })),
      update: async (ns, patch) => {
        values[ns] = { ...(values[ns] ?? {}), ...patch };
      },
    },
    credentials: {
      describe: async (ref) => ({
        configured: secrets.has(ref),
        source: 'local',
        writable: true,
      }),
      set: async (ref, value) => {
        secrets.set(ref, value);
      },
      resolve: async (ref) => ({
        value: secrets.get(ref) ?? null,
        source: secrets.has(ref) ? 'local' : null,
      }),
    },
    agentDefaultModel: {
      currentSelection: () => selection,
      saveSelection: async (next) => {
        selection = next;
      },
    },
    llm: {
      listModels: () => [],
    },
  };

  return {
    ctx,
    values,
    secrets,
    config: {
      deploymentMode: 'hosted',
      configDir,
      hostedWorkspaceRoot: workspaceRoot,
    },
  };
}

test('G13 hosted model settings preflight requires hosted mode and local writable seams', (t) => {
  const runtime = tempHostedRuntime(t);
  const ok = hostedModelSettingsPreflight(runtime);
  assert.equal(ok.ok, true);
  assert.equal(ok.deploymentMode, 'hosted');
  assert.deepEqual(ok.missing, []);
  const publicPreflight = publicHostedModelSettingsPreflight(ok);
  assert.equal(Object.hasOwn(publicPreflight, 'paths'), false);
  assert.equal(JSON.stringify(publicPreflight).includes(runtime.config.hostedWorkspaceRoot), false);

  const remote = hostedModelSettingsPreflight({
    ...runtime,
    config: { ...runtime.config, deploymentMode: 'remote' },
  });
  assert.equal(remote.ok, false);
  assert.ok(remote.missing.includes('deploymentMode'));

  const missingResolve = hostedModelSettingsPreflight({
    ...runtime,
    ctx: {
      ...runtime.ctx,
      credentials: {
        describe: async () => ({ configured: false, source: null, writable: true }),
        set: async () => {},
      },
    },
  });
  assert.equal(missingResolve.ok, false);
  assert.ok(missingResolve.missing.includes('credentialsService'));
});

test('G13 deepseek official settings write fixed page-managed credential ref without exposing API key', async (t) => {
  const runtime = tempHostedRuntime(t);
  const saved = await saveHostedModelSettings({
    ...runtime,
    input: {
      providerKind: 'deepseek-official',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: 'sk-test-secret',
    },
  });

  assert.equal(runtime.values[LLM_DEEPSEEK_NAMESPACE].apiKeyEnv, DEEPSEEK_OFFICIAL_API_KEY_REF);
  assert.equal(runtime.secrets.get(DEEPSEEK_OFFICIAL_API_KEY_REF), 'sk-test-secret');
  assert.equal(saved.defaultModel.provider, 'deepseek-official');
  assert.equal(saved.defaultModel.model, 'deepseek-chat');
  assert.equal(JSON.stringify(saved).includes('sk-test-secret'), false);
  assert.equal(saved.providers[0].credential.configured, true);
  assert.equal(saved.providers[0].credential.managed, true);
  assert.equal(Object.hasOwn(saved.providers[0], 'apiKeyRef'), false);
  assert.equal(JSON.stringify(saved).includes(DEEPSEEK_OFFICIAL_API_KEY_REF), false);
});

test('G13 deepseek official settings preserve an existing credential ref when API key is blank', async (t) => {
  const runtime = tempHostedRuntime(t);
  runtime.secrets.set('DEEPSEEK_API_KEY', 'existing-secret');
  const saved = await saveHostedModelSettings({
    ...runtime,
    input: {
      providerKind: 'deepseek-official',
      baseURL: 'https://api.deepseek.com',
      model: 'deepseek-chat',
    },
  });

  assert.equal(runtime.values[LLM_DEEPSEEK_NAMESPACE].apiKeyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(runtime.secrets.get(DEEPSEEK_OFFICIAL_API_KEY_REF), undefined);
  assert.equal(saved.providers[0].credential.configured, true);
  assert.equal(saved.providers[0].credential.managed, false);
  assert.equal(Object.hasOwn(saved.providers[0], 'apiKeyRef'), false);
  assert.equal(JSON.stringify(saved).includes('existing-secret'), false);
  assert.equal(JSON.stringify(saved).includes('DEEPSEEK_API_KEY'), false);
});

test('G13 deepseek official connection test resolves the existing credential ref when API key is blank', async (t) => {
  const runtime = tempHostedRuntime(t);
  runtime.secrets.set('DEEPSEEK_API_KEY', 'existing-secret');
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer existing-secret');
    return { ok: true, status: 200 };
  };

  const result = await testHostedModelSettings({
    ...runtime,
    input: {
      providerKind: 'deepseek-official',
      baseURL: 'https://api.deepseek.com',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'reachable');
});

test('G13 openai-compatible settings support custom baseURL and responses API', async (t) => {
  const runtime = tempHostedRuntime(t);
  const saved = await saveHostedModelSettings({
    ...runtime,
    input: {
      providerKind: 'openai-compatible',
      providerId: 'openai-custom',
      displayName: 'Custom OpenAI',
      api: 'openai-responses',
      baseURL: 'https://api.example.com/v1',
      model: 'gpt-test',
      models: [{ id: 'gpt-test', name: 'GPT Test' }],
      apiKey: 'custom-secret',
    },
  });

  const provider = runtime.values[LLM_PI_AI_NAMESPACE].providers['openai-custom'];
  assert.equal(provider.api, 'openai-responses');
  assert.equal(provider.baseURL, 'https://api.example.com/v1');
  assert.equal(provider.apiKeyEnv, 'DSH_HUB_PROVIDER_OPENAI_CUSTOM_API_KEY');
  assert.equal(runtime.secrets.get('DSH_HUB_PROVIDER_OPENAI_CUSTOM_API_KEY'), 'custom-secret');
  assert.equal(saved.defaultModel.provider, 'openai-custom');
  const savedProvider = saved.providers.find((next) => next.id === 'openai-custom');
  assert.equal(savedProvider.credential.configured, true);
  assert.equal(savedProvider.credential.managed, true);
  assert.equal(Object.hasOwn(savedProvider, 'apiKeyRef'), false);
  assert.equal(JSON.stringify(saved).includes('custom-secret'), false);
  assert.equal(JSON.stringify(saved).includes('DSH_HUB_PROVIDER_OPENAI_CUSTOM_API_KEY'), false);
});

test('G13 openai-compatible settings reject reserved provider id', async (t) => {
  const runtime = tempHostedRuntime(t);
  await assert.rejects(
    () => saveHostedModelSettings({
      ...runtime,
      input: {
        providerKind: 'openai-compatible',
        providerId: 'deepseek-official',
        api: 'openai-completions',
        baseURL: 'https://api.example.com/v1',
        model: 'gpt-test',
        models: [{ id: 'gpt-test' }],
      },
    }),
    /reserved/,
  );
});

test('G13 status view advertises hosted model settings only after preflight succeeds', (t) => {
  const runtime = tempHostedRuntime(t);
  const preflight = hostedModelSettingsPreflight(runtime);
  const status = createPluginStatus({
    enabled: true,
    endpoint: 'https://control.hub.example.com',
    namespace: 'team',
    deploymentMode: 'hosted',
  }, { host: '127.0.0.1', port: 38140 }, {
    modelSettingsPreflight: preflight,
  });
  const payload = createPluginBrowserStatusPayload(status);
  const text = JSON.stringify(payload);
  assert.equal(status.statusView.capabilities.hostedModelSettings, true);
  assert.equal(payload.capabilities.hostedModelSettings, true);
  assert.equal(status.statusView.modelSettings.endpoint, DSH_HUB_MODEL_SETTINGS_ENDPOINT);
  assert.equal(text.includes(runtime.config.configDir), false);
  assert.equal(text.includes(runtime.config.hostedWorkspaceRoot), false);
});

test('G13 model settings endpoint rejects cross-origin writes and omits credentials from reads', async (t) => {
  const runtime = tempHostedRuntime(t);
  const routes = new Map();
  const ctx = {
    ...runtime.ctx,
    webServer: {
      register(next) {
        routes.set(next.path, next);
        return () => {
          routes.delete(next.path);
        };
      },
    },
  };
  const dispose = registerPluginModelSettingsEndpoints(ctx, {
    configSnapshot: () => runtime.config,
  });
  const route = routes.get(DSH_HUB_MODEL_SETTINGS_ENDPOINT);
  assert.ok(route);
  const denied = await invokeRoute(route, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'https://evil.example',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(denied.statusCode, 403);

  const read = await invokeRoute(route, {
    method: 'GET',
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
    },
  });
  assert.equal(read.statusCode, 200);
  const parsed = JSON.parse(read.body);
  const text = JSON.stringify(parsed);
  assert.equal(parsed.providers[0].credential.configured, false);
  assert.equal(text.includes('sk-'), false);
  assert.equal(text.includes('DEEPSEEK_API_KEY'), false);
  assert.equal(text.includes(runtime.config.configDir), false);
  assert.equal(text.includes(runtime.config.hostedWorkspaceRoot), false);
  assert.equal(Object.hasOwn(parsed.preflight, 'paths'), false);
  dispose();
  assert.equal(routes.size, 0);
});

test('G13 same-origin and JSON body helpers reject unsafe inputs', async () => {
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }), true);
  assert.equal(sameOrigin({ headers: { host: '127.0.0.1:3080', origin: 'https://evil.example' } }), false);

  const request = new EventEmitter();
  const promise = readJsonBody(request);
  request.emit('data', Buffer.from('{"ok":true}'));
  request.emit('end');
  assert.deepEqual(await promise, { ok: true });
});

async function invokeRoute(route, {
  method,
  headers = {},
  body,
} = {}) {
  const response = {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, nextHeaders = {}) {
      this.statusCode = statusCode;
      this.headers = nextHeaders;
    },
    end(chunk = '') {
      this.body += chunk;
    },
  };
  const req = new EventEmitter();
  req.method = method;
  req.url = route.path;
  req.headers = headers;
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  await route.handler(req, response);
  return response;
}
