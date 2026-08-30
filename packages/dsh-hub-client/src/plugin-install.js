import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveDshHome,
  resolvePluginConfigDir,
  resolveRemotePatchPath,
} from './plugin-profile.js';
import {
  DEPLOYMENT_MODE_HOSTED,
  deploymentModeOrDefault,
  hostedModeMarkerText,
} from './deployment-mode.js';

const PLUGIN_NAME = 'dsh-hub-plugin';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function defaultPluginSource() {
  return path.resolve(new URL('../../dsh-hub-plugin', import.meta.url).pathname);
}

function safeProfileName(profile) {
  const name = cleanText(profile) || 'web';
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('profile must be a safe basename');
  }
  return name;
}

function safeProfileDir({ dshHome, profile }) {
  const root = path.join(path.resolve(dshHome), 'profiles');
  const profileDir = path.resolve(root, safeProfileName(profile));
  const relative = path.relative(root, profileDir);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('profile path escapes DSH profiles directory');
  return profileDir;
}

function safeProfileContainedPath({ profileDir, value, defaultName, label }) {
  const requested = cleanText(value);
  const filePath = requested
    ? path.resolve(profileDir, requested)
    : path.resolve(profileDir, defaultName);
  const relative = path.relative(profileDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the selected DSH profile directory`);
  }
  return filePath;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileAtomic(filePath, text, { mode = null } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text, mode === null ? undefined : { mode });
  if (mode !== null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
  if (mode !== null) fs.chmodSync(filePath, mode);
}

function backupFile(filePath, actions) {
  if (!fs.existsSync(filePath)) return null;
  const backup = `${filePath}.bak.${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.dsh-hub`;
  fs.copyFileSync(filePath, backup);
  actions.push({ type: 'backup', path: backup });
  return backup;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function packageWithPlugin(pkg, dependencySpec) {
  const next = {
    ...pkg,
    dependencies: { ...(pkg.dependencies ?? {}) },
    dsh: {
      ...(pkg.dsh ?? {}),
      profile: {
        ...(pkg.dsh?.profile ?? {}),
      },
    },
  };
  const bundles = ensureArray(pkg.dsh?.profile?.bundles);
  next.dsh.profile.bundles = bundles.includes(PLUGIN_NAME) ? [...bundles] : [...bundles, PLUGIN_NAME];
  next.dependencies[PLUGIN_NAME] = dependencySpec;
  return next;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function linkTargetMatches(linkPath, target) {
  try {
    return fs.lstatSync(linkPath).isSymbolicLink()
      && path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(target);
  } catch {
    return false;
  }
}

function assertPluginSymlinkReplaceable({ profileDir, pluginSource, force }) {
  const linkPath = path.join(profileDir, 'node_modules', PLUGIN_NAME);
  if (linkTargetMatches(linkPath, pluginSource)) return;
  if ((fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) && !force) {
    throw new Error(`plugin package path already exists; pass --force to replace: ${linkPath}`);
  }
}

function ensurePluginSymlink({ profileDir, pluginSource, force, dryRun, actions }) {
  const nodeModulesDir = path.join(profileDir, 'node_modules');
  const linkPath = path.join(nodeModulesDir, PLUGIN_NAME);
  if (linkTargetMatches(linkPath, pluginSource)) {
    actions.push({ type: 'noop', path: linkPath, reason: 'plugin symlink already points to requested source' });
    return;
  }
  if (fs.existsSync(linkPath) || fs.lstatSync(linkPath, { throwIfNoEntry: false })) {
    if (!force) {
      throw new Error(`plugin package path already exists; pass --force to replace: ${linkPath}`);
    }
    actions.push({ type: dryRun ? 'would-remove' : 'remove', path: linkPath });
    if (!dryRun) fs.rmSync(linkPath, { recursive: true, force: true });
  }
  actions.push({ type: dryRun ? 'would-symlink' : 'symlink', path: linkPath, target: pluginSource });
  if (!dryRun) {
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.symlinkSync(pluginSource, linkPath, 'dir');
  }
}

function enabledPatchText({ endpoint, namespace, instanceName, deploymentMode }) {
  const lines = [
    `- id: ${PLUGIN_NAME}`,
    '  config:',
    '    enabled: true',
    `    endpoint: ${JSON.stringify(endpoint)}`,
    `    namespace: ${JSON.stringify(namespace)}`,
    `    deploymentMode: ${JSON.stringify(deploymentMode)}`,
  ];
  if (cleanText(instanceName)) lines.push(`    instanceName: ${JSON.stringify(cleanText(instanceName))}`);
  lines.push('');
  return lines.join('\n');
}

export function installDshHubPluginProfile({
  dshHome = resolveDshHome(),
  profile = 'web',
  pluginSource = defaultPluginSource(),
  endpoint = null,
  namespace = null,
  instanceName = os.hostname(),
  deploymentMode = null,
  pluginConfigDir = null,
  enabledPatch = null,
  force = false,
  dryRun = true,
} = {}) {
  const resolvedDshHome = path.resolve(dshHome);
  const profileName = safeProfileName(profile);
  const profileDir = safeProfileDir({ dshHome: resolvedDshHome, profile: profileName });
  const normalizedDeploymentMode = deploymentModeOrDefault(deploymentMode);
  const resolvedPluginConfigDir = resolvePluginConfigDir({
    dshHome: resolvedDshHome,
    pluginConfigDir,
  });
  const hostedMarkerPath = path.join(resolvedPluginConfigDir, 'hosted-mode.json');
  const packagePath = path.join(profileDir, 'package.json');
  const resolvedPluginSource = path.resolve(cleanText(pluginSource) || defaultPluginSource());
  const pluginPackagePath = path.join(resolvedPluginSource, 'package.json');
  const actions = [];

  if (!fs.existsSync(profileDir)) throw new Error(`DSH profile directory not found: ${profileDir}`);
  const pkg = readJsonFile(packagePath);
  if (!pkg) throw new Error(`DSH profile package.json is missing or invalid: ${packagePath}`);
  const pluginPackage = readJsonFile(pluginPackagePath);
  if (pluginPackage?.name !== PLUGIN_NAME) throw new Error(`plugin source is not ${PLUGIN_NAME}: ${resolvedPluginSource}`);

  const dependencySpec = `link:${resolvedPluginSource}`;
  const existingDependency = pkg.dependencies?.[PLUGIN_NAME];
  if (existingDependency && existingDependency !== dependencySpec && !force) {
    throw new Error(`profile already depends on ${PLUGIN_NAME} as ${existingDependency}; pass --force to update`);
  }

  let enabledPatchPath = safeProfileContainedPath({
    profileDir,
    value: enabledPatch,
    defaultName: 'dsh-hub-enabled.patch.yml',
    label: 'enabled patch path',
  });
  const normalizedEndpoint = cleanText(endpoint).replace(/\/+$/, '');
  const normalizedNamespace = cleanText(namespace);
  const shouldWriteEnabledPatch = !!(normalizedEndpoint || normalizedNamespace);
  let nextEnabledPatchText = null;
  if (shouldWriteEnabledPatch) {
    if (!normalizedEndpoint || !normalizedNamespace) {
      throw new Error('both --endpoint and --namespace are required when writing the enabled patch');
    }
    if (!/^https?:\/\//.test(normalizedEndpoint)) throw new Error('endpoint must start with http:// or https://');
    nextEnabledPatchText = enabledPatchText({
      endpoint: normalizedEndpoint,
      namespace: normalizedNamespace,
      instanceName,
      deploymentMode: normalizedDeploymentMode,
    });
  }

  assertPluginSymlinkReplaceable({
    profileDir,
    pluginSource: resolvedPluginSource,
    force,
  });

  const nextPkg = packageWithPlugin(pkg, dependencySpec);

  if (sameJson(pkg, nextPkg)) {
    actions.push({ type: 'noop', path: packagePath, reason: 'profile package already declares plugin bundle/dependency' });
  } else {
    actions.push({ type: dryRun ? 'would-write' : 'write', path: packagePath });
    if (!dryRun) {
      backupFile(packagePath, actions);
      writeFileAtomic(packagePath, `${JSON.stringify(nextPkg, null, 2)}\n`);
    }
  }

  ensurePluginSymlink({
    profileDir,
    pluginSource: resolvedPluginSource,
    force,
    dryRun,
    actions,
  });

  if (nextEnabledPatchText) {
    const current = fs.existsSync(enabledPatchPath) ? fs.readFileSync(enabledPatchPath, 'utf8') : null;
    if (current === nextEnabledPatchText) {
      actions.push({ type: 'noop', path: enabledPatchPath, reason: 'enabled patch already matches requested config' });
    } else {
      actions.push({ type: dryRun ? 'would-write' : 'write', path: enabledPatchPath, mode: '0600' });
      if (!dryRun) {
        backupFile(enabledPatchPath, actions);
        writeFileAtomic(enabledPatchPath, nextEnabledPatchText, { mode: 0o600 });
      }
    }
  } else if (!fs.existsSync(enabledPatchPath)) {
    enabledPatchPath = null;
  }

  if (normalizedDeploymentMode === DEPLOYMENT_MODE_HOSTED) {
    const markerText = hostedModeMarkerText();
    const current = fs.existsSync(hostedMarkerPath) ? fs.readFileSync(hostedMarkerPath, 'utf8') : null;
    if (current === markerText) {
      actions.push({ type: 'noop', path: hostedMarkerPath, reason: 'hosted marker already matches requested deployment mode' });
    } else {
      actions.push({ type: dryRun ? 'would-write' : 'write', path: hostedMarkerPath, mode: '0600', reason: 'hosted deployment marker' });
      if (!dryRun) writeFileAtomic(hostedMarkerPath, markerText, { mode: 0o600 });
    }
  }

  const remotePatchPath = resolveRemotePatchPath({ profileDir });
  const remotePatchExists = fs.existsSync(remotePatchPath);
  actions.push({
    type: remotePatchExists ? 'verify' : (dryRun ? 'would-verify-after-apply' : 'missing'),
    path: remotePatchPath,
    reason: 'remote capabilities overlay',
  });

  return Object.freeze({
    ok: true,
    dryRun,
    profile: profileName,
    dshHome: resolvedDshHome,
    pluginSource: resolvedPluginSource,
    paths: {
      profileDir,
      packageJson: packagePath,
      pluginPackage: path.join(profileDir, 'node_modules', PLUGIN_NAME, 'package.json'),
      enabledPatch: enabledPatchPath,
      remotePatch: remotePatchPath,
      pluginConfigDir: resolvedPluginConfigDir,
      hostedMarker: normalizedDeploymentMode === DEPLOYMENT_MODE_HOSTED ? hostedMarkerPath : null,
    },
    deploymentMode: normalizedDeploymentMode,
    actions,
    notes: [
      'plugin-install writes only profile package metadata, a local package symlink, and a non-secret enabled patch.',
      'registry key, replacement grant, and instance token are never accepted or persisted by plugin-install.',
      'Plain dsh web remains unchanged unless the dsh-hub plugin bundle is present in the selected profile.',
    ],
  });
}
