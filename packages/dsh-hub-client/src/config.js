import os from 'node:os';
import path from 'node:path';

const DEFAULTS = {
  endpoint: null,
  registryKey: null,
  replacementGrant: null,
  delivery: 'agent',
  deploymentMode: null,
  target: '127.0.0.1:3080',
  dshVersion: null,
  configDir: path.join(os.homedir(), '.dsh-hub'),
  heartbeatMs: 20000,
  healthMs: 30000,
  json: false,
  profile: 'web',
  dshHome: null,
  enabledPatch: null,
  remotePatch: null,
  pluginConfigDir: null,
  pluginSource: null,
  namespace: null,
  instanceName: null,
  dryRun: false,
  apply: false,
  force: false,
  forceEndpointChange: false,
  registryKeyStdin: false,
  replacementGrantStdin: false,
  unknownOptions: [],
};

export function parseConfig(argv = process.argv.slice(2)) {
  const cfg = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let val = eq >= 0 ? a.slice(eq + 1) : null;
    if (val === null && i + 1 < argv.length && !argv[i + 1].startsWith('--')) val = argv[++i];
    switch (key) {
      case 'endpoint': cfg.endpoint = val ?? null; break;
      case 'registry-key': cfg.registryKey = val ?? null; break;
      case 'replacement-grant': cfg.replacementGrant = val ?? null; break;
      case 'target': cfg.target = val ?? DEFAULTS.target; break;
      case 'deployment-mode': cfg.deploymentMode = val ?? null; break;
      case 'dsh-version': cfg.dshVersion = val ?? null; break;
      case 'config-dir': cfg.configDir = val ?? DEFAULTS.configDir; break;
      case 'json': cfg.json = true; break;
      case 'profile': cfg.profile = val || DEFAULTS.profile; break;
      case 'dsh-home': cfg.dshHome = val ?? null; break;
      case 'enabled-patch': cfg.enabledPatch = val ?? null; break;
      case 'remote-patch': cfg.remotePatch = val ?? null; break;
      case 'plugin-config-dir': cfg.pluginConfigDir = val ?? null; break;
      case 'plugin-source': cfg.pluginSource = val ?? null; break;
      case 'namespace': cfg.namespace = val ?? null; break;
      case 'instance-name': cfg.instanceName = val ?? null; break;
      case 'dry-run': cfg.dryRun = true; break;
      case 'apply': cfg.apply = true; break;
      case 'force': cfg.force = true; break;
      case 'force-endpoint-change': cfg.forceEndpointChange = true; break;
      case 'registry-key-stdin': cfg.registryKeyStdin = true; break;
      case 'replacement-grant-stdin': cfg.replacementGrantStdin = true; break;
      case 'help':
      case 'h':
        cfg.help = true;
        break;
      default:
        cfg.unknownOptions.push(`--${key}`);
        console.error(`unknown option: --${key}`);
    }
  }
  cfg.hostname = os.hostname();
  return cfg;
}

export const HELP = `
dsh-hub-client — dsh-hub instance-side agent (independent process)

Usage:
  dsh-hub-client join [--endpoint <url>] [--registry-key <key>] [--target 127.0.0.1:3080] [--dsh-version <v>]
  dsh-hub-client run   [--target 127.0.0.1:3080]
  dsh-hub-client diagnose [--target 127.0.0.1:3080] [--json]
  dsh-hub-client plugin-install [--profile web] [--dsh-home <dir>] [--endpoint <url> --namespace <name>] [--dry-run | --apply]
  dsh-hub-client plugin-join [--endpoint <url>] [--registry-key-stdin | --replacement-grant-stdin] [--profile web] [--dsh-home <dir>]
  dsh-hub-client plugin-install-check [--profile web] [--dsh-home <dir>] [--json]
  dsh-hub-client rotate-token
  dsh-hub-client leave
  dsh-hub-client status

Commands:
  join      Register this machine with the hub (interactive if args missing),
            store instance token in the system keychain (or a 0600 file).
  run       Maintain the outbound wss tunnel, forwarding the local DSH web.
  diagnose  Run read-only local DSH compatibility probes for M2 evidence.
  plugin-install-check
            Read-only check for the DSH web profile, dsh-hub-plugin package,
            remote overlay, launch patch, and plugin credentials presence.
  plugin-install
            Install or update dsh-hub-plugin metadata in a DSH profile and
            optionally write the non-secret enabled patch.
  plugin-join
            Register plugin delivery using PluginRuntime.join(), storing only
            plugin instance credentials; does not start the tunnel.
  rotate-token
            Explicitly rotate the stored instance token.
  leave     Revoke this instance token at the hub and clear local credentials.
  status    Show stored connection info and probe the local DSH web.

Options:
  --endpoint <url>      hub base URL, e.g. http://127.0.0.1:8081
  --registry-key <key>  namespace-level join key (dhk_...)
  --replacement-grant <grant>
                        one-time recovery grant (dhr_...)
  --target <host:port>  local DSH web to forward (default 127.0.0.1:3080)
  --deployment-mode <remote|hosted>
                        optional non-secret instance composition mode
  --dsh-version <v>     reported DSH version (optional)
  --config-dir <dir>    credential/config dir (default ~/.dsh-hub)
  --dsh-home <dir>      DSH home for plugin profile checks (default ~/.dsh)
  --profile <name>      DSH profile for plugin profile checks (default web)
  --enabled-patch <yml> enabled plugin patch path for plugin checks
  --remote-patch <yml>  remote capabilities patch path for plugin checks
  --plugin-config-dir <dir>
                        dsh-hub-plugin config dir for credential presence checks
  --plugin-source <dir> local dsh-hub-plugin package source for install/join
  --namespace <name>    namespace label for plugin enabled patch
  --instance-name <n>   instance display name for plugin enabled patch/register
  --dry-run             show plugin-install changes without writing
  --apply               allow plugin-install to write the selected DSH profile
  --force               allow plugin-install to replace existing plugin link/spec
  --force-endpoint-change
                        allow plugin-join replacement grant to switch endpoint
  --registry-key-stdin  read plugin registry key from stdin
  --replacement-grant-stdin
                        read plugin replacement grant from stdin
  --json                emit machine-readable JSON for diagnose/plugin-install-check/plugin-install/plugin-join
`;
