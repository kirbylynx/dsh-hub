import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  inspectPluginInstall,
  resolveDshHome,
  resolveEnabledPatchPath,
  resolveProfileDir,
  resolveRemotePatchPath,
} from './plugin-profile.js';
import { deploymentModeOrDefault } from './deployment-mode.js';

const HELP = `
dsh-hub-web — start DSH web in dsh-hub plugin remote mode

Usage:
  dsh-hub-web [--endpoint <url> --namespace <name>] [--instance-name <name>] [--deployment-mode remote|hosted] [--profile web] [--dsh-home <dir>] [--dry-run] [-- <dsh web args...>]

Examples:
  dsh-hub-web
  dsh-hub-web --endpoint https://control.hub.example.com --namespace my-team
  dsh-hub-web --deployment-mode hosted --endpoint https://control.hub.example.com --namespace hosted-demo
  dsh-hub-web --endpoint https://control.hub.example.com --namespace my-team -- --port 3080

Notes:
  - Plain 'dsh web' is untouched and keeps the local native UI behavior.
  - This command applies the explicit remote-capabilities overlay for browse picker and canOpenPath gating.
  - Registry key / replacement grant are not accepted here; plugin credential setup is a separate flow.
`;

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function quoteYamlString(value) {
  return JSON.stringify(cleanText(value));
}

function parseArgv(argv) {
  const cfg = {
    profile: 'web',
    dshHome: resolveDshHome(),
    endpoint: cleanText(process.env.DSH_HUB_ENDPOINT),
    namespace: cleanText(process.env.DSH_HUB_NAMESPACE),
    instanceName: cleanText(process.env.DSH_HUB_INSTANCE_NAME || os.hostname()),
    deploymentMode: deploymentModeOrDefault(process.env.DSH_HUB_DEPLOYMENT_MODE),
    enabledPatch: null,
    remotePatch: null,
    dryRun: false,
    help: false,
    dshArgs: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      cfg.dshArgs.push(...argv.slice(i + 1));
      break;
    }
    const eq = arg.indexOf('=');
    const key = arg.startsWith('--') ? (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)) : null;
    let value = eq >= 0 ? arg.slice(eq + 1) : null;
    if (!key) {
      cfg.dshArgs.push(arg);
      continue;
    }
    if (['help', 'h'].includes(key)) {
      cfg.help = true;
      continue;
    }
    if (key === 'dry-run') {
      cfg.dryRun = true;
      continue;
    }
    if (value === null && i + 1 < argv.length && !argv[i + 1].startsWith('--')) value = argv[++i];
    switch (key) {
      case 'profile': cfg.profile = cleanText(value) || 'web'; break;
      case 'dsh-home': cfg.dshHome = path.resolve(cleanText(value)); break;
      case 'endpoint': cfg.endpoint = cleanText(value); break;
      case 'namespace': cfg.namespace = cleanText(value); break;
      case 'instance-name': cfg.instanceName = cleanText(value); break;
      case 'deployment-mode': cfg.deploymentMode = deploymentModeOrDefault(value); break;
      case 'enabled-patch': cfg.enabledPatch = cleanText(value); break;
      case 'remote-patch': cfg.remotePatch = cleanText(value); break;
      default:
        cfg.dshArgs.push(arg);
        break;
    }
  }
  return cfg;
}

function createTemporaryEnabledPatch({ endpoint, namespace, instanceName, deploymentMode }) {
  if (!cleanText(endpoint) || !cleanText(namespace)) return null;
  const normalizedDeploymentMode = deploymentModeOrDefault(deploymentMode);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-web-'));
  const file = path.join(dir, 'dsh-hub-enabled.patch.yml');
  const text = [
    '- id: dsh-hub-plugin',
    '  config:',
    '    enabled: true',
    `    endpoint: ${quoteYamlString(endpoint)}`,
    `    namespace: ${quoteYamlString(namespace)}`,
    `    instanceName: ${quoteYamlString(instanceName)}`,
    `    deploymentMode: ${quoteYamlString(normalizedDeploymentMode)}`,
    '',
  ].join('\n');
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { dir, file };
}

export function buildDshHubWebInvocation(argv = process.argv.slice(2)) {
  const cfg = parseArgv(argv);
  if (cfg.help) return { help: true, text: HELP };

  const profileDir = resolveProfileDir({ dshHome: cfg.dshHome, profile: cfg.profile });
  const configuredEnabledPatch = cfg.enabledPatch ? resolveEnabledPatchPath({ profileDir, enabledPatch: cfg.enabledPatch }) : null;
  const defaultEnabledPatch = resolveEnabledPatchPath({ profileDir });
  const enabledPatch = configuredEnabledPatch || (fs.existsSync(defaultEnabledPatch) ? defaultEnabledPatch : null);
  const remotePatch = resolveRemotePatchPath({ profileDir, remotePatch: cfg.remotePatch });
  const tempEnabledPatch = enabledPatch ? null : createTemporaryEnabledPatch(cfg);
  const finalEnabledPatch = enabledPatch || tempEnabledPatch?.file || defaultEnabledPatch;
  const install = inspectPluginInstall({
    dshHome: cfg.dshHome,
    profile: cfg.profile,
    enabledPatch: finalEnabledPatch,
    remotePatch,
  });

  const missing = [];
  if (!install.checks.dshCommand) missing.push('dsh command not found');
  if (!install.checks.profileDir) missing.push(`profile directory not found: ${install.paths.profileDir}`);
  if (!install.checks.bundleRegistered) missing.push('dsh-hub-plugin is not registered in profile package bundles');
  if (!install.checks.dependencyRegistered) missing.push('dsh-hub-plugin is not registered in profile package dependencies');
  if (!install.checks.pluginPackage) missing.push(`plugin package not installed: ${install.paths.pluginPackage}`);
  if (!fs.existsSync(finalEnabledPatch)) missing.push('enabled patch missing; create it or pass --endpoint and --namespace');
  if (!install.checks.remotePatch) missing.push(`remote capabilities patch missing: ${install.paths.remotePatch}`);
  if (missing.length > 0) {
    tempEnabledPatch && fs.rmSync(tempEnabledPatch.dir, { recursive: true, force: true });
    return { ok: false, missing, install, text: HELP };
  }

  const args = cfg.profile === 'web'
    ? ['web', '--patch', finalEnabledPatch, '--patch', remotePatch, ...cfg.dshArgs]
    : ['--profile', cfg.profile, '--patch', finalEnabledPatch, '--patch', remotePatch, ...cfg.dshArgs];

  return {
    ok: true,
    command: 'dsh',
    args,
    env: { DSH_HOME: path.resolve(cfg.dshHome) },
    dryRun: cfg.dryRun,
    tempDir: tempEnabledPatch?.dir ?? null,
    patches: {
      enabled: finalEnabledPatch,
      remote: remotePatch,
    },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const invocation = buildDshHubWebInvocation(argv);
  if (invocation.help) {
    console.log(invocation.text);
    return 0;
  }
  if (!invocation.ok) {
    console.error('dsh-hub-web cannot start:');
    for (const item of invocation.missing) console.error(`  - ${item}`);
    console.error(invocation.text);
    return 1;
  }
  if (invocation.dryRun) {
    console.log(JSON.stringify({
      command: invocation.command,
      args: invocation.args,
      env: invocation.env,
      patches: invocation.patches,
    }, null, 2));
    if (invocation.tempDir) fs.rmSync(invocation.tempDir, { recursive: true, force: true });
    return 0;
  }

  try {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'inherit',
      env: { ...process.env, ...invocation.env },
    });
    const code = await new Promise((resolve) => child.on('exit', (exitCode, signal) => {
      if (signal) resolve(128);
      else resolve(exitCode ?? 1);
    }).on('error', (err) => {
      console.error(`failed to start dsh: ${err.message}`);
      resolve(1);
    }));
    return code;
  } finally {
    if (invocation.tempDir) fs.rmSync(invocation.tempDir, { recursive: true, force: true });
  }
}
