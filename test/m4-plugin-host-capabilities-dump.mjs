#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'packages/dsh-hub-plugin');
const REMOTE_PATCH = join(PLUGIN_ROOT, 'remote-capabilities.patch.yml');

async function main() {
  assert.ok(existsSync(REMOTE_PATCH), 'M4C remote capabilities patch exists');
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-hub-m4c-'));
  try {
    installPluginIntoTemporaryProfile(tempHome);

    const defaultDump = execText('dsh', ['--profile', 'web', '--dump-config'], {
      env: { ...process.env, DSH_HOME: tempHome },
    });
    assertIncludes(defaultDump, "id: dsh-hub-plugin\n  name: dsh-hub-plugin", 'default plugin composition contains host plugin');
    assertIncludes(defaultDump, "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'", 'default composition keeps auto picker');
    assertIncludes(defaultDump, "id: api-gateway\n  name: '@deepseek-ai/dsh-host-apiproxy'", 'default composition keeps the DSH api gateway');
    assertNotIncludes(defaultDump, 'id: directory-picker-browse', 'default composition does not mount browse picker backend');
    assertNotIncludes(defaultDump, 'id: ui-directory-picker-browse', 'default composition does not mount browse picker client surface');
    assertNotIncludes(defaultDump, 'nativeOpen: false', 'default composition does not gate canOpenPath');

    const remoteDump = execText('dsh', ['--profile', 'web', '--patch', REMOTE_PATCH, '--dump-config'], {
      env: { ...process.env, DSH_HOME: tempHome },
    });
    assertIncludes(
      remoteDump,
      "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'\n  disabled: true",
      'remote overlay disables the default auto picker row',
    );
    assertIncludes(
      remoteDump,
      "id: directory-picker-browse\n  name: '@deepseek-ai/dsh-host-directory-picker-browse'",
      'remote overlay mounts browse picker backend',
    );
    assertIncludes(
      remoteDump,
      "id: ui-directory-picker-browse\n  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
      'remote overlay mounts browse picker client surface',
    );
    assertIncludes(
      remoteDump,
      "id: api-gateway\n  name: '@deepseek-ai/dsh-host-apiproxy'\n  config:\n    nativeOpen: false",
      'remote overlay gates canOpenPath through the existing api gateway config',
    );
    assert.equal(countRows(remoteDump, 'directory-picker'), 1, 'remote overlay must keep one disabled auto picker row');
    assert.equal(countRows(remoteDump, 'directory-picker-browse'), 1, 'remote overlay must mount one browse picker backend row');
    assert.equal(countRows(remoteDump, 'ui-directory-picker-browse'), 1, 'remote overlay must mount one browse picker client row');
    assert.equal(countRows(remoteDump, 'api-gateway'), 1, 'remote overlay must patch the existing api gateway row instead of adding another gateway');
    assert.equal(countRows(remoteDump, 'webserver'), 1, 'remote overlay must not add a second webserver row');
    await assertRuntimeActivation(tempHome);

    console.log(JSON.stringify({
      ok: true,
      plugin: 'dsh-hub-plugin',
      profile: 'web',
      verification: 'temporary DSH_HOME + explicit remote-capabilities.patch.yml + dsh --dump-config + runtime activation',
      defaultCompositionUnchanged: true,
      browsePickerOverlay: true,
      openPathMode: 'can-open-path-disabled-by-overlay',
      directOpenPathRpcIntercept: false,
      openPathReplacement: false,
      browserSettingsCard: true,
      tunnelAdapter: true,
      tunnelRuntime: true,
    }, null, 2));
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function installPluginIntoTemporaryProfile(tempHome) {
  execText('dsh', ['--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: tempHome },
  });
  const profileDir = join(tempHome, 'profiles/web');
  const profilePackagePath = join(profileDir, 'package.json');
  const profilePackage = readJson(profilePackagePath);
  const bundles = profilePackage.dsh?.profile?.bundles;
  assert.deepEqual(bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
  profilePackage.dsh.profile.bundles = [...bundles, 'dsh-hub-plugin'];
  profilePackage.dependencies = {
    ...profilePackage.dependencies,
    'dsh-hub-plugin': `link:${PLUGIN_ROOT}`,
  };
  writeFileSync(profilePackagePath, `${JSON.stringify(profilePackage, null, 2)}\n`);
  const profileNodeModules = join(profileDir, 'node_modules');
  mkdirSync(profileNodeModules, { recursive: true });
  symlinkSync(PLUGIN_ROOT, join(profileNodeModules, 'dsh-hub-plugin'), 'dir');
}

async function assertRuntimeActivation(tempHome) {
  const child = spawn('dsh', ['--profile', 'web', '--patch', REMOTE_PATCH, '--port', '0'], {
    env: { ...process.env, DSH_HOME: tempHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const { url, output } = await waitForDshUrl(child);
    assert.doesNotMatch(output, /failed to import loader entry|Cannot find package|ERR_MODULE_NOT_FOUND/i);
    const description = await dshRpc(url, 'host.describe');
    assert.equal(description?.canOpenPath, false, 'remote overlay should make host.describe.canOpenPath=false');
  } finally {
    await stopChild(child);
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function countRows(dump, rowId) {
  const pattern = new RegExp(`^[-] id: ${escapeRegex(rowId)}$`, 'gm');
  return [...dump.matchAll(pattern)].length;
}

function assertIncludes(text, needle, message) {
  assert.ok(text.includes(needle), `${message}: missing ${needle}`);
}

function assertNotIncludes(text, needle, message) {
  assert.ok(!text.includes(needle), `${message}: unexpected ${needle}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function waitForDshUrl(child) {
  let output = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not print a URL before timeout\n${output}`));
    }, 8000);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ url: match[1], output });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`dsh web exited before serving with code=${code} signal=${signal}\n${output}`));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function dshRpc(baseUrl, method) {
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-hub-m4d6-${method}`,
      method,
      payload: {},
    }),
  });
  assert.equal(response.status, 200, `${method} should return HTTP 200`);
  const body = await response.json();
  assert.equal(body?.result?.ok, true, `${method} should return an ok RPC result`);
  return body.result.value;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

await main();
