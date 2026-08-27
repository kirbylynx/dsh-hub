import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { main as clientMain } from '../packages/dsh-hub-client/src/index.js';
import { inspectPluginInstall } from '../packages/dsh-hub-client/src/plugin-profile.js';
import { buildDshHubWebInvocation } from '../packages/dsh-hub-client/src/plugin-web.js';

const ROOT = new URL('..', import.meta.url).pathname;
const PLUGIN_ROOT = path.join(ROOT, 'packages/dsh-hub-plugin');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createMockDshPath(root) {
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const dsh = path.join(binDir, 'dsh');
  fs.writeFileSync(dsh, '#!/bin/sh\nprintf "0.1.0-rc.7\\n"\n');
  fs.chmodSync(dsh, 0o755);
  return binDir;
}

function createProfile({ dshHome, profile = 'web', installed = true, enabledPatch = false }) {
  const profileDir = path.join(dshHome, 'profiles', profile);
  fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
  writeJson(path.join(profileDir, 'package.json'), {
    dependencies: installed ? { 'dsh-hub-plugin': '0.1.0' } : {},
    dsh: {
      profile: {
        bundles: installed ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-hub-plugin'] : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      },
    },
  });
  if (installed) fs.symlinkSync(PLUGIN_ROOT, path.join(profileDir, 'node_modules', 'dsh-hub-plugin'), 'dir');
  if (enabledPatch) {
    fs.writeFileSync(path.join(profileDir, 'dsh-hub-enabled.patch.yml'), [
      '- id: dsh-hub-plugin',
      '  config:',
      '    enabled: true',
      '    endpoint: "https://control.example"',
      '    namespace: "demo"',
      '',
    ].join('\n'), { mode: 0o600 });
  }
  return profileDir;
}

async function withMockDsh(fn) {
  const root = tempDir('dsh-hub-cli-path-');
  const oldPath = process.env.PATH;
  process.env.PATH = `${createMockDshPath(root)}${path.delimiter}${oldPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

function captureConsoleLog(fn) {
  const oldLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.log = oldLog; })
    .then((result) => ({ result, output: lines.join('\n') }));
}

test('M4D-7A plugin-install-check is read-only, secret-redacted, and separates install from credential readiness', async () => {
  await withMockDsh(async () => {
    const dshHome = tempDir('dsh-hub-cli-home-');
    const configDir = tempDir('dsh-hub-plugin-config-');
    createProfile({ dshHome, installed: true, enabledPatch: false });
    fs.writeFileSync(path.join(configDir, 'credentials.json'), JSON.stringify({
      endpoint: 'https://control.example',
      instanceId: 'inst_demo',
      instanceToken: 'dht_do_not_print',
      delivery: 'plugin',
    }), { mode: 0o600 });

    const inspected = inspectPluginInstall({ dshHome, pluginConfigDir: configDir });
    assert.equal(inspected.ok, true);
    assert.equal(inspected.readiness.installed, true);
    assert.equal(inspected.readiness.launchReady, false);
    assert.equal(inspected.readiness.tunnelReady, false);
    assert.equal(JSON.stringify(inspected).includes('dht_do_not_print'), false);

    const { result, output } = await captureConsoleLog(() => clientMain([
      'plugin-install-check',
      '--dsh-home', dshHome,
      '--plugin-config-dir', configDir,
      '--json',
    ]));
    assert.equal(result, 0);
    assert.equal(output.includes('dht_do_not_print'), false);
    const json = JSON.parse(output);
    assert.equal(json.readiness.installed, true);
    assert.equal(json.readiness.launchReady, false);
    assert.equal(json.checks.credentials, true);
  });
});

test('M4D-7A dsh-hub-web dry-run generates a temporary enabled patch and applies explicit remote overlay', async () => {
  await withMockDsh(async () => {
    const dshHome = tempDir('dsh-hub-cli-home-');
    createProfile({ dshHome, installed: true, enabledPatch: false });

    const invocation = buildDshHubWebInvocation([
      '--dsh-home', dshHome,
      '--endpoint', 'https://control.example/',
      '--namespace', 'demo',
      '--instance-name', 'devbox',
      '--dry-run',
      '--',
      '--port', '3080',
    ]);

    assert.equal(invocation.ok, true);
    assert.equal(invocation.command, 'dsh');
    assert.deepEqual(invocation.args.slice(0, 5), ['web', '--patch', invocation.patches.enabled, '--patch', invocation.patches.remote]);
    assert.deepEqual(invocation.args.slice(-2), ['--port', '3080']);
    assert.match(invocation.patches.remote, /remote-capabilities\.patch\.yml$/);
    const patch = fs.readFileSync(invocation.patches.enabled, 'utf8');
    assert.match(patch, /enabled: true/);
    assert.match(patch, /endpoint: "https:\/\/control\.example\/"/);
    assert.match(patch, /namespace: "demo"/);
    assert.match(patch, /instanceName: "devbox"/);
    assert.equal((fs.statSync(invocation.patches.enabled).mode & 0o777), 0o600);
    assert.equal(/dhk_|dhr_|dht_|registryKey|instanceToken|replacementGrant/.test(patch), false);
    fs.rmSync(invocation.tempDir, { recursive: true, force: true });
  });
});

test('M4D-7A dsh-hub-web prefers an existing enabled patch and does not create a temp patch', async () => {
  await withMockDsh(async () => {
    const dshHome = tempDir('dsh-hub-cli-home-');
    const profileDir = createProfile({ dshHome, installed: true, enabledPatch: true });

    const invocation = buildDshHubWebInvocation(['--dsh-home', dshHome]);

    assert.equal(invocation.ok, true);
    assert.equal(invocation.tempDir, null);
    assert.equal(invocation.patches.enabled, path.join(profileDir, 'dsh-hub-enabled.patch.yml'));
    assert.deepEqual(invocation.args.slice(0, 5), ['web', '--patch', invocation.patches.enabled, '--patch', invocation.patches.remote]);
  });
});

test('M4D-7A dsh-hub-web supports non-default profile using DSH profile CLI semantics', async () => {
  await withMockDsh(async () => {
    const dshHome = tempDir('dsh-hub-cli-home-');
    createProfile({ dshHome, profile: 'remote', installed: true, enabledPatch: true });

    const invocation = buildDshHubWebInvocation(['--dsh-home', dshHome, '--profile', 'remote']);

    assert.equal(invocation.ok, true);
    assert.deepEqual(invocation.args.slice(0, 5), ['--profile', 'remote', '--patch', invocation.patches.enabled, '--patch']);
    assert.deepEqual(invocation.env, { DSH_HOME: dshHome });
  });
});

test('M4D-7A dsh-hub-web non-default profile args are accepted by real DSH dump-config', async () => {
  const dshHome = tempDir('dsh-hub-cli-home-');
  createProfile({ dshHome, profile: 'remote', installed: true, enabledPatch: true });

  const invocation = buildDshHubWebInvocation([
    '--dsh-home', dshHome,
    '--profile', 'remote',
    '--',
    '--dump-config',
  ]);

  assert.equal(invocation.ok, true);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: 'utf8',
    env: { ...process.env, ...invocation.env },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /dsh-hub-plugin/);
  assert.match(result.stdout, /directory-picker-browse/);
});
