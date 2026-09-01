import readline from 'node:readline';
import { parseConfig, HELP } from './config.js';
import { CredentialStore } from './credentials.js';
import { registerWithHub } from './register.js';
import { revokeSelfWithHub, rotateTokenWithHub } from './lifecycle.js';
import { diagnoseLocalDsh, probeLocalDsh } from './probe.js';
import { runTunnel } from './tunnel.js';
import { log, parseTarget, redactLogText } from './util.js';
import { inspectPluginInstall } from './plugin-profile.js';
import { installDshHubPluginProfile } from './plugin-install.js';
import { joinDshHubPlugin } from './plugin-join.js';
import { publicDeploymentMode } from './deployment-mode.js';

const CLIENT_VERSION = '0.1.4';

export async function main(argv = process.argv.slice(2)) {
  const cfg = parseConfig(argv);
  const [command] = argv.filter((a) => !a.startsWith('--'));
  if (cfg.help || !command || !['join', 'run', 'status', 'diagnose', 'plugin-install-check', 'plugin-install', 'plugin-join', 'rotate-token', 'leave'].includes(command)) {
    console.log(HELP);
    return cfg.help ? 0 : 1;
  }
  try {
    if (command === 'join') return await cmdJoin(cfg);
    if (command === 'run') return await cmdRun(cfg);
    if (command === 'status') return await cmdStatus(cfg);
    if (command === 'diagnose') return await cmdDiagnose(cfg);
    if (command === 'plugin-install-check') return await cmdPluginInstallCheck(cfg);
    if (command === 'plugin-install') return await cmdPluginInstall(cfg);
    if (command === 'plugin-join') return await cmdPluginJoin(cfg);
    if (command === 'rotate-token') return await cmdRotateToken(cfg);
    if (command === 'leave') return await cmdLeave(cfg);
  } catch (err) {
    console.error(`error: ${redactLogText(err.message)}`);
    return 1;
  }
  return 0;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

async function readSecretStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function cmdJoin(cfg) {
  const store = new CredentialStore(cfg.configDir);
  let endpoint = cfg.endpoint;
  let registryKey = cfg.registryKey;
  let replacementGrant = cfg.replacementGrant;
  if (!endpoint) endpoint = await prompt('hub endpoint (e.g. http://127.0.0.1:8081): ');
  if (registryKey && replacementGrant) throw new Error('registry key and replacement grant are mutually exclusive');
  if (!registryKey && !replacementGrant) registryKey = await prompt('registry key (dhk_...) or leave blank for replacement grant: ');
  if (!registryKey && !replacementGrant) replacementGrant = await prompt('replacement grant (dhr_...): ');
  endpoint = endpoint.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(endpoint)) endpoint = 'http://' + endpoint;
  if (!registryKey && !replacementGrant) throw new Error('registry key or replacement grant required');
  const installationId = await store.ensureInstallationId();

  log(`registering with ${endpoint} …`);
  const body = await registerWithHub({
    endpoint,
    registryKey,
    replacementGrant,
    delivery: 'agent',
    deploymentMode: cfg.deploymentMode,
    hostname: cfg.hostname,
    dshVersion: cfg.dshVersion,
    installationId,
    clientVersion: CLIENT_VERSION,
    store,
  });

  const creds = {
    endpoint,
    installationId,
    instanceId: body.instanceId,
    instanceToken: body.instanceToken,
    instanceTokenExpiresAt: body.instanceTokenExpiresAt ?? null,
    instanceTokenRenewalUntil: body.instanceTokenRenewalUntil ?? null,
    delivery: 'agent',
    deploymentMode: publicDeploymentMode(cfg.deploymentMode),
    target: cfg.target,
    hostname: cfg.hostname,
    clientVersion: CLIENT_VERSION,
    dshVersion: cfg.dshVersion,
  };
  const { usedKeyring, filePath } = await store.save(creds);

  log(`joined as instance ${body.instanceId} (namespace ${body.namespaceId})`);
  log(`hub version: ${body.serverVersion}`);
  log(usedKeyring
    ? 'credentials stored in system keychain'
    : `credentials stored in ${filePath} (0600)`);
  log('run `dsh-hub-client run` to establish the tunnel.');
  return 0;
}

async function cmdRun(cfg) {
  const store = new CredentialStore(cfg.configDir);
  const creds = await store.load();
  if (!creds) {
    throw new Error('no credentials — run `dsh-hub-client join` first');
  }
  if (!creds.installationId) {
    creds.installationId = await store.ensureInstallationId();
    creds.clientVersion = creds.clientVersion ?? CLIENT_VERSION;
    await store.save(creds);
  } else if (!creds.clientVersion) {
    creds.clientVersion = CLIENT_VERSION;
    await store.save(creds);
  }
  if (cfg.target !== '127.0.0.1:3080') creds.target = cfg.target; // allow override
  cfg.endpoint = creds.endpoint;
  const { port } = parseTarget(creds.target);

  log(`dsh-hub-client run — hub ${creds.endpoint}, instance ${creds.instanceId}`);
  log(`forwarding local DSH web at http://127.0.0.1:${port}`);
  log('press Ctrl-C to stop.');

  await runTunnel(cfg, creds, {
    onStatus: (level, msg) => log(`[${level}] ${msg}`),
  });
  return 0;
}

async function cmdStatus(cfg) {
  const store = new CredentialStore(cfg.configDir);
  const creds = await store.load();
  if (!creds) {
    console.log('not joined. run `dsh-hub-client join` first.');
    return 0;
  }
  const p = await probeLocalDsh(creds.target);
  console.log(`endpoint:       ${creds.endpoint}`);
  console.log(`instance:       ${creds.instanceId}`);
  console.log(`delivery:       ${creds.delivery}`);
  console.log(`deployment:     ${creds.deploymentMode ?? 'unknown'}`);
  console.log(`local target:   ${creds.target}`);
  console.log(`local DSH web:  ${p.online ? 'online' : 'offline'}` + (p.status ? ` (http ${p.status})` : ''));
  console.log(`hub reachable:  ${await probeHub(creds.endpoint) ? 'yes' : 'no'}`);
  console.log(`token expires:  ${creds.instanceTokenExpiresAt ?? 'unknown'}`);
  console.log(`renewal until:  ${creds.instanceTokenRenewalUntil ?? 'unknown'}`);
  return 0;
}

async function cmdDiagnose(cfg) {
  const store = new CredentialStore(cfg.configDir);
  const creds = await store.load().catch(() => null);
  const target = cfg.target !== '127.0.0.1:3080' ? cfg.target : (creds?.target ?? cfg.target);
  const result = await diagnoseLocalDsh(target);
  if (cfg.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`target:                ${result.target}`);
  console.log(`checked at:            ${result.checkedAt}`);
  console.log(`local DSH web:         ${result.root.online ? 'online' : 'offline'}${result.root.status ? ` (http ${result.root.status})` : ''}`);
  console.log(`session.list:          ${formatRpc(result.api.sessionList)}`);
  console.log(`workspace.list:        ${formatRpc(result.api.workspaceList)}`);
  console.log(`workspace mapping:     sessions=${valueOrUnknown(result.workspaceMapping.sessionCount)}, workspaces=${valueOrUnknown(result.workspaceMapping.workspaceCount)}, linked=${result.workspaceMapping.linkedSessionCount}, unlinked=${result.workspaceMapping.unlinkedSessionCount}, stale=${result.workspaceMapping.staleWorkspaceSessionCount}`);
  console.log(`events.mux:            ${formatWs(result.websocket.eventsMux)}`);
  console.log(`events.host:           ${formatWs(result.websocket.eventsHost)}`);
  console.log(`directory picker:      ${result.hostCapabilities.inferredDirectoryPicker}${result.hostCapabilities.remoteLimited ? ' (remote-limited)' : ''}`);
  console.log(`host capability note:  ${result.hostCapabilities.note}`);
  return 0;
}

async function cmdPluginInstallCheck(cfg) {
  const result = inspectPluginInstall({
    dshHome: cfg.dshHome ?? undefined,
    profile: cfg.profile,
    enabledPatch: cfg.enabledPatch,
    remotePatch: cfg.remotePatch,
    pluginConfigDir: cfg.pluginConfigDir,
  });
  if (cfg.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.readiness.installed ? 0 : 1;
  }

  console.log(`profile:               ${result.profile}`);
  console.log(`dsh home:              ${result.dshHome}`);
  console.log(`dsh command:           ${result.checks.dshCommand ? 'yes' : 'no'}${result.dshVersion ? ` (${result.dshVersion})` : ''}`);
  console.log(`profile package:       ${result.checks.packageJson ? 'yes' : 'no'} (${result.paths.packageJson})`);
  console.log(`bundle registered:     ${result.checks.bundleRegistered ? 'yes' : 'no'}`);
  console.log(`dependency registered: ${result.checks.dependencyRegistered ? 'yes' : 'no'}`);
  console.log(`plugin package:        ${result.checks.pluginPackage ? 'yes' : 'no'} (${result.paths.pluginPackage})`);
  console.log(`enabled patch:         ${result.checks.enabledPatch ? 'yes' : 'no'} (${result.paths.enabledPatch})`);
  console.log(`remote overlay patch:  ${result.checks.remotePatch ? 'yes' : 'no'} (${result.paths.remotePatch})`);
  console.log(`plugin credentials:    ${result.checks.credentials ? 'yes' : 'no'} (${result.paths.credentials})`);
  console.log(`installed:             ${result.readiness.installed ? 'yes' : 'no'}`);
  console.log(`launch ready:          ${result.readiness.launchReady ? 'yes' : 'no'}`);
  console.log(`tunnel ready:          ${result.readiness.tunnelReady ? 'yes' : 'no'}`);
  console.log('note: this command is read-only and never prints registry key, replacement grant, or instance token.');
  return result.readiness.installed ? 0 : 1;
}

async function cmdPluginInstall(cfg) {
  if (cfg.unknownOptions.length) throw new Error(`unknown option for plugin-install: ${cfg.unknownOptions.join(', ')}`);
  if (cfg.registryKey || cfg.replacementGrant || cfg.registryKeyStdin || cfg.replacementGrantStdin) {
    throw new Error('plugin-install does not accept registry key, replacement grant, or instance token');
  }
  const dryRun = cfg.dryRun || !cfg.apply;
  const result = installDshHubPluginProfile({
    dshHome: cfg.dshHome ?? undefined,
    profile: cfg.profile,
    pluginSource: cfg.pluginSource ?? undefined,
    pluginConfigDir: cfg.pluginConfigDir,
    endpoint: cfg.endpoint,
    namespace: cfg.namespace,
    instanceName: cfg.instanceName ?? cfg.hostname,
    deploymentMode: cfg.deploymentMode,
    enabledPatch: cfg.enabledPatch,
    force: cfg.force,
    dryRun,
  });
  if (cfg.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${dryRun ? 'plugin install dry-run' : 'plugin installed'} for profile ${result.profile}`);
  console.log(`dsh home:      ${result.dshHome}`);
  console.log(`plugin source: ${result.pluginSource}`);
  for (const action of result.actions) {
    console.log(`- ${action.type}: ${action.path}${action.target ? ` -> ${action.target}` : ''}${action.reason ? ` (${action.reason})` : ''}`);
  }
  console.log('note: registry key, replacement grant, and instance token were not accepted or persisted by plugin-install.');
  return 0;
}

async function cmdPluginJoin(cfg) {
  if (cfg.unknownOptions.length) throw new Error(`unknown option for plugin-join: ${cfg.unknownOptions.join(', ')}`);
  if (cfg.dryRun || cfg.apply) throw new Error('plugin-join does not support --dry-run or --apply');
  let endpoint = cfg.endpoint;
  let registryKey = cfg.registryKey;
  let replacementGrant = cfg.replacementGrant;
  if (cfg.registryKeyStdin && cfg.replacementGrantStdin) throw new Error('registry key stdin and replacement grant stdin are mutually exclusive');
  if (cfg.registryKeyStdin) {
    registryKey = await readSecretStdin();
    if (!registryKey) throw new Error('registry key stdin was empty');
  }
  if (cfg.replacementGrantStdin) {
    replacementGrant = await readSecretStdin();
    if (!replacementGrant) throw new Error('replacement grant stdin was empty');
  }
  if (!endpoint) endpoint = await prompt('hub endpoint (e.g. https://control.hub.example.com): ');
  if (registryKey && replacementGrant) throw new Error('registry key and replacement grant are mutually exclusive');
  if (!registryKey && !replacementGrant && !process.stdin.isTTY) {
    throw new Error('registry key or replacement grant required; pass --registry-key-stdin or --replacement-grant-stdin, or run interactively from a terminal');
  }
  if (!registryKey && !replacementGrant) registryKey = await prompt('registry key (dhk_...) or leave blank for replacement grant: ');
  if (!registryKey && !replacementGrant) replacementGrant = await prompt('replacement grant (dhr_...): ');
  if (!registryKey && !replacementGrant) throw new Error('registry key or replacement grant required');
  const result = await joinDshHubPlugin({
    dshHome: cfg.dshHome ?? undefined,
    profile: cfg.profile,
    pluginSource: cfg.pluginSource,
    pluginConfigDir: cfg.pluginConfigDir,
    endpoint,
    registryKey,
    replacementGrant,
    target: cfg.target,
    deploymentMode: cfg.deploymentMode,
    hostname: cfg.instanceName ?? cfg.hostname,
    dshVersion: cfg.dshVersion,
    clientVersion: CLIENT_VERSION,
    forceEndpointChange: cfg.forceEndpointChange,
  });
  if (cfg.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  log(`plugin joined as instance ${result.credentials.instanceId}`);
  log(`credentials stored in ${result.credentialsPath} (0600)`);
  log('run `dsh-hub-web` to start DSH in plugin remote mode.');
  return 0;
}

async function cmdRotateToken(cfg) {
  const store = new CredentialStore(cfg.configDir);
  const creds = await store.load();
  if (!creds) throw new Error('no credentials — run `dsh-hub-client join` first');
  const { body } = await rotateTokenWithHub({ creds, store });
  log(`token rotated for instance ${creds.instanceId}`);
  log(`expires at: ${body.instanceTokenExpiresAt}`);
  log(`renewal until: ${body.instanceTokenRenewalUntil}`);
  log(`old token overlap until: ${body.overlapUntil}`);
  return 0;
}

async function cmdLeave(cfg) {
  const store = new CredentialStore(cfg.configDir);
  const creds = await store.load();
  if (!creds) {
    log('not joined; nothing to leave.');
    return 0;
  }
  const result = await revokeSelfWithHub({ creds, store });
  log(result.alreadyRevoked
    ? 'instance was already revoked at the hub; local credentials cleared.'
    : 'instance revoked at the hub; local credentials cleared.');
  return 0;
}

async function probeHub(endpoint) {
  try {
    const r = await fetch(endpoint.replace(/\/+$/, '') + '/healthz', { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

function formatRpc(rpc) {
  return `http=${valueOrUnknown(rpc.status)}, ok=${rpc.ok === true ? 'yes' : 'no'}, items=${valueOrUnknown(rpc.itemCount)}`;
}

function formatWs(ws) {
  if (ws.error) return `error=${ws.error}`;
  return `opened=${ws.opened ? 'yes' : 'no'}, messages=${ws.messages}, ${ws.idle ? 'idle' : 'active'}`;
}

function valueOrUnknown(value) {
  return value === null || value === undefined ? 'unknown' : String(value);
}
