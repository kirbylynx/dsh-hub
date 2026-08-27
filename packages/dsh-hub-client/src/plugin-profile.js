import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DEFAULT_PROFILE = 'web';
const DEFAULT_ENABLED_PATCH = 'dsh-hub-enabled.patch.yml';
const DEFAULT_PLUGIN_NAME = 'dsh-hub-plugin';
function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fileMode(filePath) {
  try {
    return (fs.statSync(filePath).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return null;
  }
}

export function resolveDshHome(env = process.env) {
  return path.resolve(cleanText(env.DSH_HOME) || path.join(os.homedir(), '.dsh'));
}

export function resolveProfileDir({ dshHome = resolveDshHome(), profile = DEFAULT_PROFILE } = {}) {
  return path.join(path.resolve(dshHome), 'profiles', cleanText(profile) || DEFAULT_PROFILE);
}

export function resolvePluginConfigDir({ dshHome = resolveDshHome(), pluginConfigDir = null } = {}) {
  const configured = cleanText(pluginConfigDir) || cleanText(process.env.DSH_HUB_PLUGIN_CONFIG_DIR);
  if (configured) return path.resolve(configured);
  return path.join(path.resolve(dshHome), DEFAULT_PLUGIN_NAME);
}

export function resolveEnabledPatchPath({ profileDir, enabledPatch = null } = {}) {
  return path.resolve(cleanText(enabledPatch) || path.join(profileDir, DEFAULT_ENABLED_PATCH));
}

export function resolveRemotePatchPath({ profileDir, remotePatch = null } = {}) {
  return path.resolve(cleanText(remotePatch) || path.join(profileDir, 'node_modules', DEFAULT_PLUGIN_NAME, 'remote-capabilities.patch.yml'));
}

export function inspectPluginInstall({
  dshHome = resolveDshHome(),
  profile = DEFAULT_PROFILE,
  enabledPatch = null,
  remotePatch = null,
  pluginConfigDir = null,
} = {}) {
  const profileDir = resolveProfileDir({ dshHome, profile });
  const packagePath = path.join(profileDir, 'package.json');
  const pkg = readJsonFile(packagePath);
  const pluginPackagePath = path.join(profileDir, 'node_modules', DEFAULT_PLUGIN_NAME, 'package.json');
  const pluginPackage = readJsonFile(pluginPackagePath);
  const enabledPatchPath = resolveEnabledPatchPath({ profileDir, enabledPatch });
  const remotePatchPath = resolveRemotePatchPath({ profileDir, remotePatch });
  const configDir = resolvePluginConfigDir({ dshHome, pluginConfigDir });
  const credentialsPath = path.join(configDir, 'credentials.json');
  const statePath = path.join(configDir, 'state.json');
  const dshVersion = spawnSync('dsh', ['--version'], { encoding: 'utf8' });

  const checks = {
    dshCommand: dshVersion.status === 0,
    profileDir: fs.existsSync(profileDir),
    packageJson: !!pkg,
    bundleRegistered: Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(DEFAULT_PLUGIN_NAME),
    dependencyRegistered: !!pkg?.dependencies?.[DEFAULT_PLUGIN_NAME],
    pluginPackage: !!pluginPackage,
    enabledPatch: fs.existsSync(enabledPatchPath),
    remotePatch: fs.existsSync(remotePatchPath),
    credentials: fs.existsSync(credentialsPath),
  };
  const installed = checks.dshCommand
    && checks.profileDir
    && checks.packageJson
    && checks.bundleRegistered
    && checks.dependencyRegistered
    && checks.pluginPackage
    && checks.remotePatch;
  const launchReady = installed && checks.enabledPatch;
  const tunnelReady = launchReady && checks.credentials;

  return Object.freeze({
    ok: installed,
    profile,
    dshHome: path.resolve(dshHome),
    dshVersion: dshVersion.status === 0 ? dshVersion.stdout.trim() : null,
    checks,
    readiness: {
      installed,
      launchReady,
      tunnelReady,
    },
    paths: {
      profileDir,
      packageJson: packagePath,
      pluginPackage: pluginPackagePath,
      enabledPatch: enabledPatchPath,
      remotePatch: remotePatchPath,
      pluginConfigDir: configDir,
      credentials: credentialsPath,
      state: statePath,
    },
    files: {
      credentialsMode: fileMode(credentialsPath),
      stateMode: fileMode(statePath),
    },
    notes: [
      'plugin-install-check is read-only and never prints registry key, replacement grant, or instance token.',
      'dsh-hub-web can use an existing enabled patch or generate a temporary non-secret patch from --endpoint/--namespace.',
      'remote-capabilities.patch.yml is explicit so plain dsh web keeps the local native UI behavior.',
    ],
  });
}
