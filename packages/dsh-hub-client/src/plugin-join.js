import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseTarget } from './util.js';
import { resolveDshHome, resolvePluginConfigDir, resolveProfileDir } from './plugin-profile.js';
import { deploymentModeOrDefault } from './deployment-mode.js';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeProfileName(profile) {
  const name = cleanText(profile) || 'web';
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('profile must be a safe basename');
  }
  return name;
}

function normalizeEndpoint(value) {
  const endpoint = cleanText(value).replace(/\/+$/, '');
  if (!endpoint) return '';
  if (!/^https?:\/\//.test(endpoint)) throw new Error('endpoint must start with http:// or https://');
  return endpoint;
}

function defaultPluginSource({ dshHome, profile }) {
  return path.join(resolveProfileDir({ dshHome, profile }), 'node_modules', 'dsh-hub-plugin');
}

async function loadPluginRuntime(pluginSource) {
  const root = path.resolve(pluginSource);
  const [runtimeModule, storeModule] = await Promise.all([
    import(pathToFileURL(path.join(root, 'src/runtime.js')).href),
    import(pathToFileURL(path.join(root, 'src/credential-store.js')).href),
  ]);
  return {
    PluginRuntime: runtimeModule.PluginRuntime,
    PluginCredentialStore: storeModule.PluginCredentialStore,
  };
}

function createNoStartAdapter(target) {
  return () => Object.freeze({
    delivery: 'plugin',
    target: Object.freeze({ ok: true, ...target }),
    describe: () => Object.freeze({
      available: true,
      active: false,
      delivery: 'plugin',
      state: 'cli-join-only',
      target: Object.freeze({ ok: true, ...target }),
    }),
    start: () => {
      throw new Error('plugin-join CLI does not start the tunnel');
    },
  });
}

export async function joinDshHubPlugin({
  dshHome = resolveDshHome(),
  profile = 'web',
  pluginSource = null,
  pluginConfigDir = null,
  endpoint,
  registryKey = null,
  replacementGrant = null,
  target = '127.0.0.1:3080',
  deploymentMode = null,
  hostname = null,
  dshVersion = null,
  clientVersion = '0.1.3',
  forceEndpointChange = false,
} = {}) {
  const parsedTarget = parseTarget(target);
  const authority = parsedTarget.host.includes(':')
    ? `[${parsedTarget.host}]:${parsedTarget.port}`
    : `${parsedTarget.host}:${parsedTarget.port}`;
  const resolvedDshHome = path.resolve(dshHome);
  const profileName = safeProfileName(profile);
  const normalizedDeploymentMode = deploymentModeOrDefault(deploymentMode);
  const resolvedPluginSource = path.resolve(cleanText(pluginSource) || defaultPluginSource({
    dshHome: resolvedDshHome,
    profile: profileName,
  }));
  const resolvedConfigDir = resolvePluginConfigDir({
    dshHome: resolvedDshHome,
    pluginConfigDir,
  });
  const { PluginRuntime, PluginCredentialStore } = await loadPluginRuntime(resolvedPluginSource);
  const store = new PluginCredentialStore(resolvedConfigDir);
  const existingCredentials = await store.load();
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (
    existingCredentials
    && cleanText(replacementGrant)
    && normalizeEndpoint(existingCredentials.endpoint) !== normalizedEndpoint
    && forceEndpointChange !== true
  ) {
    throw new Error('replacement grant endpoint differs from existing plugin credentials; pass --force-endpoint-change to switch hub endpoint');
  }
  const runtime = new PluginRuntime({
    config: {
      enabled: true,
      endpoint: normalizedEndpoint,
      instanceName: cleanText(hostname),
      deploymentMode: normalizedDeploymentMode,
      dshVersion,
      configDir: resolvedConfigDir,
    },
    webServer: { host: parsedTarget.host, port: parsedTarget.port },
    store,
    adapterFactory: createNoStartAdapter({
      host: parsedTarget.host,
      port: parsedTarget.port,
      authority,
    }),
  });
  await runtime.initialize({ autoStart: false });
  const result = await runtime.join({
    endpoint: normalizedEndpoint,
    registryKey,
    replacementGrant,
    hostname,
    dshVersion,
    clientVersion,
    deploymentMode: normalizedDeploymentMode,
    start: false,
  });
  return Object.freeze({
    ok: true,
    ...result,
    pluginSource: resolvedPluginSource,
    pluginConfigDir: resolvedConfigDir,
    deploymentMode: normalizedDeploymentMode,
    target: authority,
    credentialsPath: path.join(resolvedConfigDir, 'credentials.json'),
    statePath: path.join(resolvedConfigDir, 'state.json'),
  });
}
