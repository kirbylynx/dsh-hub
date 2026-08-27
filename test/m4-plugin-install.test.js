import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { main as clientMain } from '../packages/dsh-hub-client/src/index.js';
import { installDshHubPluginProfile } from '../packages/dsh-hub-client/src/plugin-install.js';
import { joinDshHubPlugin } from '../packages/dsh-hub-client/src/plugin-join.js';
import { inspectPluginInstall } from '../packages/dsh-hub-client/src/plugin-profile.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PLUGIN_ROOT = path.join(ROOT, 'packages/dsh-hub-plugin');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createProfile(dshHome, profile = 'web') {
  const profileDir = path.join(dshHome, 'profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(path.join(profileDir, 'package.json'), {
    dependencies: { dshmarket: '1.12.2' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket'],
      },
    },
  });
  return profileDir;
}

async function captureConsole(fn) {
  const oldLog = console.log;
  const oldError = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  console.error = (...args) => lines.push(args.join(' '));
  try {
    const result = await fn();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = oldLog;
    console.error = oldError;
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function profileWrites(profileDir) {
  return {
    packageJson: fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'),
    entries: fs.readdirSync(profileDir, { recursive: true }).sort(),
  };
}

function assertProfileUnchanged(profileDir, before) {
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before.packageJson);
  const afterEntries = fs.readdirSync(profileDir, { recursive: true }).sort();
  assert.deepEqual(afterEntries, before.entries);
}

async function withProcessStdin(text, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'stdin');
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: Readable.from([text]),
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'stdin', original);
  }
}

function startRegisterServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      requests.push({ req, body });
      handler(req, res, body, requests);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test('M4D-7B plugin-install updates only profile metadata, symlink, and non-secret enabled patch', () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  const profileDir = createProfile(dshHome);

  const result = installDshHubPluginProfile({
    dshHome,
    pluginSource: PLUGIN_ROOT,
    endpoint: 'https://control.example/',
    namespace: 'demo',
    instanceName: 'devbox',
    dryRun: false,
  });

  assert.equal(result.ok, true);
  const pkg = readJson(path.join(profileDir, 'package.json'));
  assert.equal(pkg.dependencies['dsh-hub-plugin'], `link:${PLUGIN_ROOT}`);
  assert.deepEqual(pkg.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dshmarket',
    'dsh-hub-plugin',
  ]);
  assert.equal(fs.lstatSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')).isSymbolicLink(), true);
  const patchPath = path.join(profileDir, 'dsh-hub-enabled.patch.yml');
  const patch = fs.readFileSync(patchPath, 'utf8');
  assert.match(patch, /enabled: true/);
  assert.match(patch, /endpoint: "https:\/\/control\.example"/);
  assert.match(patch, /namespace: "demo"/);
  assert.equal((fs.statSync(patchPath).mode & 0o777), 0o600);
  assert.equal(/dhk_|dhr_|dht_|registryKey|replacementGrant|instanceToken/.test(patch), false);

  const inspected = inspectPluginInstall({ dshHome });
  assert.equal(inspected.checks.bundleRegistered, true);
  assert.equal(inspected.checks.dependencyRegistered, true);
  assert.equal(inspected.checks.pluginPackage, true);
  assert.equal(inspected.checks.enabledPatch, true);
  assert.equal(inspected.checks.remotePatch, true);
});

test('M4D-7B plugin-install dry-run does not write profile package, patch, or symlink', () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  const profileDir = createProfile(dshHome);
  const before = fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8');

  const result = installDshHubPluginProfile({
    dshHome,
    pluginSource: PLUGIN_ROOT,
    endpoint: 'https://control.example',
    namespace: 'demo',
  });

  assert.equal(result.dryRun, true);
  assert.equal(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(profileDir, 'dsh-hub-enabled.patch.yml')), false);
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')), false);
});

test('M4D-7B dsh-hub-client plugin-install defaults to dry-run unless --apply is present', async () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  const profileDir = createProfile(dshHome);

  const { result, output } = await captureConsole(() => clientMain([
    'plugin-install',
    '--dsh-home', dshHome,
    '--plugin-source', PLUGIN_ROOT,
    '--endpoint', 'https://control.example',
    '--namespace', 'demo',
    '--json',
  ]));

  assert.equal(result, 0);
  assert.equal(JSON.parse(output).dryRun, true);
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')), false);
  assert.equal(fs.existsSync(path.join(profileDir, 'dsh-hub-enabled.patch.yml')), false);
});

test('M4D-7B dsh-hub-client plugin-install applies only with --apply and rejects secret inputs', async () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  const profileDir = createProfile(dshHome);

  const rejected = await captureConsole(() => clientMain([
    'plugin-install',
    '--dsh-home', dshHome,
    '--plugin-source', PLUGIN_ROOT,
    '--registry-key', 'dhk_should_not_write',
    '--apply',
  ]));
  assert.equal(rejected.result, 1);
  assert.equal(rejected.output.includes('dhk_should_not_write'), false);
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')), false);

  const applied = await captureConsole(() => clientMain([
    'plugin-install',
    '--dsh-home', dshHome,
    '--plugin-source', PLUGIN_ROOT,
    '--endpoint', 'https://control.example',
    '--namespace', 'demo',
    '--apply',
    '--json',
  ]));
  assert.equal(applied.result, 0);
  assert.equal(JSON.parse(applied.output).dryRun, false);
  assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')), true);
  assert.equal(fs.existsSync(path.join(profileDir, 'dsh-hub-enabled.patch.yml')), true);
});

test('M4D-7B plugin-install rejects profile path traversal before writing', () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  createProfile(dshHome);

  assert.throws(
    () => installDshHubPluginProfile({
      dshHome,
      profile: '../web',
      pluginSource: PLUGIN_ROOT,
    }),
    /profile must be a safe basename/,
  );
});

test('M4D-7B plugin-install rejects enabled patch paths outside the selected profile before writing', () => {
  const dshHome = tempDir('dsh-hub-install-home-');
  const profileDir = createProfile(dshHome);
  const before = profileWrites(profileDir);
  const outside = path.join(dshHome, 'outside.patch.yml');

  assert.throws(
    () => installDshHubPluginProfile({
      dshHome,
      pluginSource: PLUGIN_ROOT,
      endpoint: 'https://control.example',
      namespace: 'demo',
      enabledPatch: '../outside.patch.yml',
      dryRun: false,
    }),
    /enabled patch path must stay inside/,
  );
  assertProfileUnchanged(profileDir, before);
  assert.equal(fs.existsSync(outside), false);
});

test('M4D-7B plugin-install validates endpoint and namespace before any writes', () => {
  for (const badArgs of [
    { endpoint: 'https://control.example' },
    { endpoint: 'ftp://control.example', namespace: 'demo' },
  ]) {
    const dshHome = tempDir('dsh-hub-install-home-');
    const profileDir = createProfile(dshHome);
    const before = profileWrites(profileDir);
    assert.throws(
      () => installDshHubPluginProfile({
        dshHome,
        pluginSource: PLUGIN_ROOT,
        ...badArgs,
        dryRun: false,
      }),
      /both --endpoint and --namespace|endpoint must start/,
    );
    assertProfileUnchanged(profileDir, before);
    assert.equal(fs.existsSync(path.join(profileDir, 'node_modules/dsh-hub-plugin')), false);
    assert.equal(fs.existsSync(path.join(profileDir, 'dsh-hub-enabled.patch.yml')), false);
  }
});

test('M4D-7B plugin-join reuses PluginRuntime.join and stores only plugin instance credentials', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({
    dshHome,
    pluginSource: PLUGIN_ROOT,
    endpoint: 'https://control.example',
    namespace: 'demo',
    dryRun: false,
  });
  const register = await startRegisterServer((_req, res, body) => {
    assert.equal(body.registryKey, 'dhk_join_secret');
    assert.equal(body.delivery, 'plugin');
    assert.match(body.installationId, /^insl_[A-Za-z0-9_-]{22}$/);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instanceId: 'inst-plugin-cli',
      instanceToken: 'dht_plugin_cli_secret',
      instanceTokenExpiresAt: '2026-09-20T00:00:00.000Z',
      instanceTokenRenewalUntil: '2026-09-27T00:00:00.000Z',
    }));
  });
  try {
    const result = await joinDshHubPlugin({
      dshHome,
      endpoint: register.endpoint,
      registryKey: 'dhk_join_secret',
      hostname: 'devbox',
      target: '127.0.0.1:3080',
    });

    assert.equal(result.ok, true);
    assert.equal(result.credentialKind, 'registry');
    assert.equal(result.tunnelStarted, false);
    assert.equal(register.requests.length, 1);
    assert.equal(JSON.stringify(result).includes('dhk_join_secret'), false);
    assert.equal(JSON.stringify(result).includes('dht_plugin_cli_secret'), false);

    const saved = readJson(path.join(dshHome, 'dsh-hub-plugin', 'credentials.json'));
    assert.equal(saved.endpoint, register.endpoint);
    assert.equal(saved.instanceId, 'inst-plugin-cli');
    assert.equal(saved.instanceToken, 'dht_plugin_cli_secret');
    assert.equal(saved.delivery, 'plugin');
    assert.equal(saved.target, '127.0.0.1:3080');
    assert.equal('registryKey' in saved, false);
    assert.equal('replacementGrant' in saved, false);
    assert.equal((fs.statSync(path.join(dshHome, 'dsh-hub-plugin', 'credentials.json')).mode & 0o777), 0o600);
  } finally {
    await register.close();
  }
});

test('M4D-7B plugin-join refuses replacement grant endpoint switch without explicit force', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });
  fs.mkdirSync(path.join(dshHome, 'dsh-hub-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'dsh-hub-plugin', 'credentials.json'), JSON.stringify({
    endpoint: 'https://old.example',
    instanceId: 'inst-existing',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    instanceToken: 'dht_existing_secret',
    delivery: 'plugin',
  }), { mode: 0o600 });
  const register = await startRegisterServer((_req, res) => {
    res.writeHead(500);
    res.end('should not be called');
  });
  try {
    await assert.rejects(
      joinDshHubPlugin({
        dshHome,
        endpoint: register.endpoint,
        replacementGrant: 'dhr_switch_secret',
      }),
      /endpoint differs/,
    );
    assert.equal(register.requests.length, 0);
  } finally {
    await register.close();
  }
});

test('M4D-7B dsh-hub-client plugin-join JSON output redacts secret-shaped inputs and tokens', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });
  const register = await startRegisterServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instanceId: 'inst-plugin-json',
      instanceToken: 'dht_json_secret',
    }));
  });
  try {
    const { result, output } = await captureConsole(() => clientMain([
      'plugin-join',
      '--dsh-home', dshHome,
      '--endpoint', register.endpoint,
      '--registry-key', 'dhk_json_secret',
      '--json',
    ]));
    assert.equal(result, 0);
    assert.equal(output.includes('dhk_json_secret'), false);
    assert.equal(output.includes('dht_json_secret'), false);
    const json = JSON.parse(output);
    assert.equal(json.credentials.instanceId, 'inst-plugin-json');
    assert.equal(json.tunnelStarted, false);
  } finally {
    await register.close();
  }
});

test('M4D-7B dsh-hub-client plugin-join reads registry key from stdin without leaking it', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });
  const register = await startRegisterServer((_req, res, body) => {
    assert.equal(body.registryKey, 'dhk_stdin_secret');
    assert.equal(body.delivery, 'plugin');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instanceId: 'inst-plugin-stdin',
      instanceToken: 'dht_stdin_secret',
    }));
  });
  try {
    const { result, output } = await withProcessStdin('dhk_stdin_secret\n', () => captureConsole(() => clientMain([
      'plugin-join',
      '--dsh-home', dshHome,
      '--endpoint', register.endpoint,
      '--registry-key-stdin',
      '--json',
    ])));
    assert.equal(result, 0);
    assert.equal(register.requests.length, 1);
    assert.equal(output.includes('dhk_stdin_secret'), false);
    assert.equal(output.includes('dht_stdin_secret'), false);
    assert.equal(JSON.parse(output).credentials.instanceId, 'inst-plugin-stdin');
  } finally {
    await register.close();
  }
});

test('M4D-7B dsh-hub-client plugin-join fails clearly when stdin secret is empty', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });

  const { result, output } = await withProcessStdin('', () => captureConsole(() => clientMain([
    'plugin-join',
    '--dsh-home', dshHome,
    '--endpoint', 'https://control.example',
    '--registry-key-stdin',
  ])));

  assert.equal(result, 1);
  assert.match(output, /registry key stdin was empty/);
  assert.doesNotMatch(output, /registry key \(dhk_/);
});

test('M4D-7B plugin-join force endpoint change allows replacement grant and reuses installation ID', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });
  const configDir = path.join(dshHome, 'dsh-hub-plugin');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({
    endpoint: 'https://old.example',
    instanceId: 'inst-existing',
    installationId: 'insl_existinginstallid000',
    instanceToken: 'dht_existing_secret',
    delivery: 'plugin',
  }), { mode: 0o600 });
  const register = await startRegisterServer((_req, res, body) => {
    assert.equal(body.replacementGrant, 'dhr_force_secret');
    assert.equal(body.registryKey, undefined);
    assert.equal(body.delivery, 'plugin');
    assert.equal(body.installationId, 'insl_existinginstallid000');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      instanceId: 'inst-forced',
      instanceToken: 'dht_forced_secret',
    }));
  });
  try {
    const result = await joinDshHubPlugin({
      dshHome,
      endpoint: register.endpoint,
      replacementGrant: 'dhr_force_secret',
      forceEndpointChange: true,
    });
    assert.equal(result.credentials.instanceId, 'inst-forced');
    assert.equal(result.credentials.installationId, 'insl_existinginstallid000');
    assert.equal(register.requests.length, 1);
    const saved = readJson(path.join(configDir, 'credentials.json'));
    assert.equal(saved.endpoint, register.endpoint);
    assert.equal(saved.installationId, 'insl_existinginstallid000');
  } finally {
    await register.close();
  }
});

test('M4D-7B plugin-join rejects registry key rejoin before calling register when credentials already exist', async () => {
  const dshHome = tempDir('dsh-hub-join-home-');
  createProfile(dshHome);
  installDshHubPluginProfile({ dshHome, pluginSource: PLUGIN_ROOT, dryRun: false });
  fs.mkdirSync(path.join(dshHome, 'dsh-hub-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dshHome, 'dsh-hub-plugin', 'credentials.json'), JSON.stringify({
    endpoint: 'http://127.0.0.1:1',
    instanceId: 'inst-existing',
    installationId: 'insl_abcdefghijklmnopqrstuv',
    instanceToken: 'dht_existing_secret',
    delivery: 'plugin',
  }), { mode: 0o600 });
  const register = await startRegisterServer((_req, res) => {
    res.writeHead(500);
    res.end('should not be called');
  });
  try {
    await assert.rejects(
      joinDshHubPlugin({
        dshHome,
        endpoint: register.endpoint,
        registryKey: 'dhk_should_not_call',
      }),
      /already has instance credentials/,
    );
    assert.equal(register.requests.length, 0);
  } finally {
    await register.close();
  }
});
