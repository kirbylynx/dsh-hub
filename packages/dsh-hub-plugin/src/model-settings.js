import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEPLOYMENT_MODE_HOSTED,
  DSH_HUB_HOSTED_MARKER_FILE,
  DSH_HUB_HOSTED_WORKSPACE_ROOT,
  normalizeDeploymentMode,
  publicDeploymentMode,
} from 'dsh-hub-client/src/deployment-mode.js';

export const DSH_HUB_MODEL_SETTINGS_ENDPOINT = '/plugins/dsh-hub-plugin/model-settings.json';
export const DSH_HUB_MODEL_SETTINGS_TEST_ENDPOINT = '/plugins/dsh-hub-plugin/model-settings/test.json';
export const DEEPSEEK_OFFICIAL_PROVIDER = 'deepseek-official';
export const DEEPSEEK_OFFICIAL_API_KEY_REF = 'DSH_HUB_PROVIDER_DEEPSEEK_OFFICIAL_API_KEY';
export const LLM_DEEPSEEK_NAMESPACE = 'llm-deepseek';
export const LLM_PI_AI_NAMESPACE = 'llm-pi-ai';
export const AGENT_DEFAULT_MODEL_NAMESPACE = 'agent-default-model';
export const OPENAI_COMPATIBLE_PROTOCOLS = Object.freeze(['openai-completions', 'openai-responses']);

const MAX_JSON_BODY_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanOptionalText(value) {
  const text = cleanText(value);
  return text || null;
}

function dshHome(env = process.env) {
  return path.resolve(cleanText(env.DSH_HOME) || path.join(os.homedir(), '.dsh'));
}

function service(ctx, name) {
  if (!ctx) return null;
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name) ?? null;
    } catch {
      return null;
    }
  }
  return ctx[name] ?? null;
}

function descriptorByNamespace(settings, namespace) {
  const descriptors = typeof settings?.describe === 'function'
    ? settings.describe({ redactSecrets: true })
    : [];
  return descriptors.find((item) => String(item?.ns) === namespace) ?? null;
}

function settingsNamespaces(settings) {
  const descriptors = typeof settings?.describe === 'function'
    ? settings.describe({ redactSecrets: true })
    : [];
  if (!Array.isArray(descriptors)) return new Set();
  return new Set(descriptors.map((item) => cleanText(item?.ns)).filter(Boolean));
}

function expectedHostedWorkspaceRoot(config = {}) {
  return path.resolve(cleanText(config.hostedWorkspaceRoot) || DSH_HUB_HOSTED_WORKSPACE_ROOT);
}

function safeHostedMarker(config = {}, env = process.env) {
  const configDir = cleanText(config.configDir)
    || cleanText(env.DSH_HUB_PLUGIN_CONFIG_DIR)
    || path.join(dshHome(env), 'dsh-hub-plugin');
  const markerPath = path.join(path.resolve(configDir), DSH_HUB_HOSTED_MARKER_FILE);
  const expectedWorkspaceRoot = expectedHostedWorkspaceRoot(config);
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const workspaceRoot = cleanText(marker.workspaceRoot) || DSH_HUB_HOSTED_WORKSPACE_ROOT;
    const valid = marker.kind === 'dsh-hub-hosted'
      && marker.version === 1
      && marker.deploymentMode === DEPLOYMENT_MODE_HOSTED
      && path.resolve(workspaceRoot) === expectedWorkspaceRoot;
    return Object.freeze({
      path: markerPath,
      present: true,
      valid,
      workspaceRoot,
    });
  } catch {
    return Object.freeze({
      path: markerPath,
      present: false,
      valid: false,
      workspaceRoot: expectedWorkspaceRoot,
    });
  }
}

function directoryWritable(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function fileOrParentWritable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return directoryWritable(path.dirname(filePath));
  }
}

export function hostedModelSettingsPreflight({ ctx, config = {}, env = process.env } = {}) {
  const settings = service(ctx, 'settings');
  const credentials = service(ctx, 'credentials');
  const agentDefaultModel = service(ctx, 'agentDefaultModel');
  const llm = service(ctx, 'llm');
  const marker = safeHostedMarker(config, env);
  const namespaces = settingsNamespaces(settings);
  const home = dshHome(env);
  const settingsPath = settings?.documentPath ?? path.join(home, 'settings.yaml');
  const credentialsPath = path.join(home, '.credentials.yaml');
  const workspaceRoot = marker.workspaceRoot;
  const checks = {
    deploymentMode: normalizeDeploymentMode(config.deploymentMode) === DEPLOYMENT_MODE_HOSTED,
    hostedMarker: marker.present && marker.valid,
    workspaceRoot: directoryWritable(workspaceRoot),
    settingsService: !!settings && settings.writable === true && typeof settings.update === 'function',
    settingsNamespaces: namespaces.has(AGENT_DEFAULT_MODEL_NAMESPACE)
      && namespaces.has(LLM_DEEPSEEK_NAMESPACE)
      && namespaces.has(LLM_PI_AI_NAMESPACE),
    credentialsService: !!credentials
      && typeof credentials.describe === 'function'
      && typeof credentials.set === 'function'
      && typeof credentials.resolve === 'function',
    agentDefaultModel: !!agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function' && typeof agentDefaultModel.saveSelection === 'function',
    llmDirectory: !!llm && (typeof llm.listModels === 'function' || typeof llm.listConfigurableProviders === 'function'),
    settingsDocumentWritable: fileOrParentWritable(settingsPath),
    credentialsDocumentWritable: fileOrParentWritable(credentialsPath),
  };
  const missing = Object.entries(checks)
    .filter(([, ok]) => ok !== true)
    .map(([name]) => name);
  return Object.freeze({
    ok: missing.length === 0,
    deploymentMode: publicDeploymentMode(config.deploymentMode),
    checks,
    missing,
    paths: Object.freeze({
      hostedMarker: marker.path,
      workspaceRoot,
      settingsDocument: settingsPath,
      credentialsDocument: credentialsPath,
    }),
    note: 'Hosted model settings require explicit hosted mode, a local hosted marker, the hosted workspace root, DSH model-provider namespaces, and writable DSH settings/credentials seams.',
  });
}

export function publicHostedModelSettingsPreflight(preflight) {
  if (!preflight) return null;
  return Object.freeze({
    ok: preflight.ok === true,
    deploymentMode: publicDeploymentMode(preflight.deploymentMode),
    checks: Object.freeze({ ...(preflight.checks ?? {}) }),
    missing: Object.freeze(Array.isArray(preflight.missing) ? [...preflight.missing] : []),
    note: cleanOptionalText(preflight.note),
  });
}

function isPageManagedCredentialRef(ref) {
  const text = cleanOptionalText(ref);
  return !!text && /^DSH_HUB_PROVIDER_[A-Z0-9_]+_API_KEY$/.test(text);
}

function safeCredentialInfo(info, ref = null) {
  return Object.freeze({
    configured: info?.configured === true,
    source: cleanOptionalText(info?.source),
    writable: info?.writable === true,
    managed: isPageManagedCredentialRef(ref),
  });
}

async function configuredProvidersFromPiAi(descriptor, credentials) {
  const providers = descriptor?.value?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Promise.all(Object.entries(providers).map(async ([id, profile]) => {
    const apiKeyRef = cleanOptionalText(profile?.apiKeyEnv);
    const credential = apiKeyRef && credentials?.describe
      ? await credentials.describe(apiKeyRef).catch(() => null)
      : null;
    return Object.freeze({
      id,
      kind: 'openai-compatible',
      displayName: cleanOptionalText(profile?.displayName) ?? id,
      api: cleanOptionalText(profile?.api),
      baseURL: cleanOptionalText(profile?.baseURL),
      credential: safeCredentialInfo(credential, apiKeyRef),
      models: Array.isArray(profile?.models)
        ? profile.models.map((model) => Object.freeze({
          id: cleanText(model?.id),
          name: cleanOptionalText(model?.name),
          contextWindow: Number.isSafeInteger(model?.contextWindow) ? model.contextWindow : null,
          maxTokens: Number.isSafeInteger(model?.maxTokens) ? model.maxTokens : null,
        })).filter((model) => model.id)
        : [],
    });
  }));
}

export async function readHostedModelSettings({ ctx, config = {}, env = process.env } = {}) {
  const settings = service(ctx, 'settings');
  const credentials = service(ctx, 'credentials');
  const agentDefaultModel = service(ctx, 'agentDefaultModel');
  const preflight = hostedModelSettingsPreflight({ ctx, config, env });
  const deepseek = descriptorByNamespace(settings, LLM_DEEPSEEK_NAMESPACE);
  const piAi = descriptorByNamespace(settings, LLM_PI_AI_NAMESPACE);
  const defaultModel = typeof agentDefaultModel?.currentSelection === 'function'
    ? agentDefaultModel.currentSelection()
    : null;
  const deepseekRef = cleanOptionalText(deepseek?.value?.apiKeyEnv) ?? DEEPSEEK_OFFICIAL_API_KEY_REF;
  const deepseekCredential = credentials?.describe
    ? await credentials.describe(deepseekRef).catch(() => null)
    : null;
  const openAiCompatibleProviders = await configuredProvidersFromPiAi(piAi, credentials);

  return Object.freeze({
    ok: true,
    hostedEligible: preflight.ok,
    preflight: publicHostedModelSettingsPreflight(preflight),
    defaultModel: defaultModel ? Object.freeze({
      provider: cleanOptionalText(defaultModel.provider),
      model: cleanOptionalText(defaultModel.model),
      reasoningEffort: cleanOptionalText(defaultModel.reasoningEffort),
    }) : null,
    providers: Object.freeze([
      Object.freeze({
        id: DEEPSEEK_OFFICIAL_PROVIDER,
        kind: 'deepseek-official',
        displayName: 'DeepSeek Official',
        settingsNamespace: LLM_DEEPSEEK_NAMESPACE,
        api: 'deepseek-chat-completions',
        baseURL: cleanOptionalText(deepseek?.value?.baseURL) ?? 'https://api.deepseek.com',
        credential: safeCredentialInfo(deepseekCredential, deepseekRef),
        models: Array.isArray(deepseek?.value?.models) ? deepseek.value.models.map((model) => ({
          id: cleanText(model?.id),
          name: cleanOptionalText(model?.name),
        })).filter((model) => model.id) : [],
      }),
      ...openAiCompatibleProviders,
    ]),
  });
}

function validateBaseUrl(value) {
  const text = cleanText(value);
  if (!text) throw new Error('baseURL is required');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('baseURL must be a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('baseURL must start with http:// or https://');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function validateProviderId(value) {
  const text = cleanText(value);
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(text)) {
    throw new Error('providerId must be lowercase kebab-case, 2..63 characters');
  }
  if (text === DEEPSEEK_OFFICIAL_PROVIDER) {
    throw new Error('providerId is reserved');
  }
  return text;
}

function apiKeyRefForProvider(providerId) {
  return `DSH_HUB_PROVIDER_${providerId.toUpperCase().replaceAll('-', '_')}_API_KEY`;
}

function deepseekApiKeyRef(settings, { usePageManagedRef = false } = {}) {
  if (usePageManagedRef) return DEEPSEEK_OFFICIAL_API_KEY_REF;
  const deepseek = descriptorByNamespace(settings, LLM_DEEPSEEK_NAMESPACE);
  return cleanOptionalText(deepseek?.value?.apiKeyEnv) ?? DEEPSEEK_OFFICIAL_API_KEY_REF;
}

function validateModels(models) {
  if (!Array.isArray(models) || models.length < 1 || models.length > 50) {
    throw new Error('models must contain 1..50 entries');
  }
  const seen = new Set();
  return models.map((model) => {
    const id = cleanText(model?.id);
    if (!id || id.length > 128) throw new Error('model id is required and must be <=128 characters');
    if (seen.has(id)) throw new Error(`duplicate model id: ${id}`);
    seen.add(id);
    return {
      id,
      ...(cleanOptionalText(model?.name) ? { name: cleanOptionalText(model.name) } : {}),
      ...(Number.isSafeInteger(model?.contextWindow) && model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isSafeInteger(model?.maxTokens) && model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
    };
  });
}

function assertHostedWritable(ctx, config, env) {
  const preflight = hostedModelSettingsPreflight({ ctx, config, env });
  if (!preflight.ok) {
    const err = new Error(`hosted model settings unavailable: ${preflight.missing.join(', ')}`);
    err.code = 'HOSTED_PREFLIGHT_FAILED';
    err.preflight = preflight;
    throw err;
  }
  return preflight;
}

export async function saveHostedModelSettings({ ctx, config = {}, env = process.env, input } = {}) {
  assertHostedWritable(ctx, config, env);
  const settings = service(ctx, 'settings');
  const credentials = service(ctx, 'credentials');
  const agentDefaultModel = service(ctx, 'agentDefaultModel');
  const kind = cleanText(input?.providerKind || input?.kind);
  const apiKey = cleanOptionalText(input?.apiKey);
  const model = cleanOptionalText(input?.model || input?.defaultModel);
  const reasoningEffort = cleanOptionalText(input?.reasoningEffort);

  if (kind === 'deepseek-official') {
    const apiKeyRef = deepseekApiKeyRef(settings, { usePageManagedRef: !!apiKey });
    const patch = {
      apiKeyEnv: apiKeyRef,
    };
    const baseURL = cleanOptionalText(input?.baseURL);
    if (baseURL) patch.baseURL = validateBaseUrl(baseURL);
    await settings.update(LLM_DEEPSEEK_NAMESPACE, patch);
    if (apiKey) await credentials.set(apiKeyRef, apiKey);
    if (model) {
      await agentDefaultModel.saveSelection({
        provider: DEEPSEEK_OFFICIAL_PROVIDER,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    }
    return readHostedModelSettings({ ctx, config, env });
  }

  if (kind === 'openai-compatible') {
    const providerId = validateProviderId(input?.providerId);
    const api = cleanText(input?.api || 'openai-completions');
    if (!OPENAI_COMPATIBLE_PROTOCOLS.includes(api)) {
      throw new Error(`api must be one of: ${OPENAI_COMPATIBLE_PROTOCOLS.join(', ')}`);
    }
    const apiKeyRef = apiKeyRefForProvider(providerId);
    const baseURL = validateBaseUrl(input?.baseURL);
    const models = validateModels(input?.models);
    const piAi = descriptorByNamespace(settings, LLM_PI_AI_NAMESPACE);
    const currentProviders = piAi?.value?.providers && typeof piAi.value.providers === 'object'
      ? piAi.value.providers
      : {};
    const nextProviders = {
      ...currentProviders,
      [providerId]: {
        displayName: cleanOptionalText(input?.displayName) ?? providerId,
        apiKeyEnv: apiKeyRef,
        api,
        baseURL,
        models,
      },
    };
    await settings.update(LLM_PI_AI_NAMESPACE, { providers: nextProviders });
    if (apiKey) await credentials.set(apiKeyRef, apiKey);
    if (model) {
      await agentDefaultModel.saveSelection({
        provider: providerId,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
    }
    return readHostedModelSettings({ ctx, config, env });
  }

  throw new Error('providerKind must be deepseek-official or openai-compatible');
}

function bearerTestHeaders(apiKey) {
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };
}

export async function testHostedModelSettings({ ctx, config = {}, env = process.env, input } = {}) {
  assertHostedWritable(ctx, config, env);
  const credentials = service(ctx, 'credentials');
  const kind = cleanText(input?.providerKind || input?.kind);
  if (kind !== 'deepseek-official' && kind !== 'openai-compatible') {
    throw new Error('providerKind must be deepseek-official or openai-compatible');
  }
  const providerId = kind === 'deepseek-official'
    ? DEEPSEEK_OFFICIAL_PROVIDER
    : validateProviderId(input?.providerId);
  const suppliedKey = cleanOptionalText(input?.apiKey);
  const settings = service(ctx, 'settings');
  const apiKeyRef = kind === 'deepseek-official'
    ? deepseekApiKeyRef(settings, { usePageManagedRef: !!suppliedKey })
    : apiKeyRefForProvider(providerId);
  const baseURL = validateBaseUrl(input?.baseURL || (kind === 'deepseek-official' ? 'https://api.deepseek.com' : ''));
  const resolved = suppliedKey
    ? { value: suppliedKey, source: 'request' }
    : await credentials.resolve(apiKeyRef).catch(() => null);
  if (!resolved?.value) {
    return Object.freeze({
      ok: false,
      providerId,
      status: 'missing-credential',
      credential: safeCredentialInfo(await credentials.describe(apiKeyRef).catch(() => null)),
    });
  }
  const modelsUrl = `${baseURL.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers: bearerTestHeaders(resolved.value),
      signal: controller.signal,
    });
    return Object.freeze({
      ok: response.ok,
      providerId,
      status: response.ok ? 'reachable' : 'http-error',
      httpStatus: response.status,
    });
  } catch (err) {
    return Object.freeze({
      ok: false,
      providerId,
      status: err?.name === 'AbortError' ? 'timeout' : 'network-error',
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

export function sameOrigin(req) {
  const origin = cleanOptionalText(req.headers.origin);
  if (!origin) return true;
  const host = cleanOptionalText(req.headers.host);
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
