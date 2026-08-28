#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'packages/dsh-hub-plugin');
const HOSTED_PATCH = join(PLUGIN_ROOT, 'hosted-capabilities.patch.yml');

async function main() {
  assert.ok(existsSync(HOSTED_PATCH), 'G11 hosted capabilities patch exists');
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-hub-g11-home-'));
  const workspaceRoot = join(mkdtempSync(join(tmpdir(), 'dsh-hub-g11-workspace-')), 'workspace');
  const outsideRoot = mkdtempSync(join(tmpdir(), 'dsh-hub-g11-outside-'));
  mkdirSync(join(workspaceRoot, 'project'), { recursive: true });

  installPluginIntoTemporaryProfile(tempHome);

  const defaultDump = execText('dsh', ['--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: tempHome },
  });
  assertIncludes(defaultDump, "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'", 'default composition keeps auto picker');
  assertNotIncludes(defaultDump, 'directory-picker-hosted-workspace', 'default composition does not mount hosted picker');

  const hostedDump = execText('dsh', ['--profile', 'web', '--patch', HOSTED_PATCH, '--dump-config'], {
    env: { ...process.env, DSH_HOME: tempHome },
  });
  assertIncludes(
    hostedDump,
    "id: directory-picker-hosted-workspace\n  name: dsh-hub-plugin/restricted-directory-picker",
    'hosted overlay mounts restricted picker backend',
  );
  assertIncludes(hostedDump, 'root: /workspace', 'shipped hosted overlay fixes root to /workspace');
  assertIncludes(hostedDump, "id: ui-directory-picker-browse\n  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'", 'hosted overlay keeps official browse client UI');
  assertIncludes(hostedDump, 'nativeOpen: false', 'hosted overlay keeps canOpenPath gating');
  assertNotIncludes(hostedDump, "name: '@deepseek-ai/dsh-host-directory-picker-browse'", 'hosted overlay does not mount whole-filesystem browse backend');

  const runtimePatch = join(tempHome, 'hosted-runtime.patch.yml');
  writeFileSync(runtimePatch, hostedPatchText(workspaceRoot), { mode: 0o600 });
  const child = spawn('dsh', ['--profile', 'web', '--patch', runtimePatch, '--port', '0'], {
    env: { ...process.env, DSH_HOME: tempHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const { url, output } = await waitForDshUrl(child);
    assert.doesNotMatch(output, /failed to import loader entry|Cannot find package|ERR_MODULE_NOT_FOUND/i);
    const description = await dshRpc(url, 'host.describe', {});
    assert.equal(description.ok, true);
    assert.equal(description.value.canOpenPath, false, 'hosted overlay should make host.describe.canOpenPath=false');

    const rootListing = await dshRpc(url, 'host.listDirectory', {});
    assert.equal(rootListing.ok, true);
    assert.equal(rootListing.value.path, workspaceRoot);
    assert.equal(rootListing.value.home, workspaceRoot);
    assert.equal(rootListing.value.root, workspaceRoot);
    assert.equal(rootListing.value.restricted, true);
    assert.deepEqual(rootListing.value.entries.map((entry) => entry.name), ['project']);

    const outsideListing = await dshRpc(url, 'host.listDirectory', { path: outsideRoot });
    assert.equal(outsideListing.ok, false, 'host.listDirectory outside root should fail');

    const created = await dshRpc(url, 'host.createDirectory', { path: workspaceRoot, name: 'created-by-rpc' });
    assert.equal(created.ok, true);
    assert.equal(created.value.path, join(workspaceRoot, 'created-by-rpc'));

    const outsideCreate = await dshRpc(url, 'host.createDirectory', { path: outsideRoot, name: 'x' });
    assert.equal(outsideCreate.ok, false, 'host.createDirectory outside root should fail');
  } finally {
    await stopChild(child);
  }

  console.log(JSON.stringify({
    ok: true,
    plugin: 'dsh-hub-plugin',
    verification: 'temporary DSH_HOME + hosted overlay dump-config + real DSH host.listDirectory/createDirectory RPC',
    defaultRemoteOverlayUnchanged: true,
    hostedRestrictedDirectoryPicker: true,
    hostedRoot: '/workspace',
    openPathMode: 'can-open-path-disabled-by-overlay',
  }, null, 2));
}

function hostedPatchText(root) {
  return [
    '- id: directory-picker',
    '  disabled: true',
    '- id: api-gateway',
    '  config:',
    '    nativeOpen: false',
    '- insert:',
    '    - id: directory-picker-hosted-workspace',
    '      name: dsh-hub-plugin/restricted-directory-picker',
    '      config:',
    `        root: ${JSON.stringify(root)}`,
    '        maxEntries: 1000',
    '    - id: ui-directory-picker-browse',
    "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n');
}

function installPluginIntoTemporaryProfile(tempHome) {
  execText('dsh', ['--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: tempHome },
  });
  const profileDir = join(tempHome, 'profiles/web');
  const profilePackagePath = join(profileDir, 'package.json');
  const profilePackage = JSON.parse(readFileSync(profilePackagePath, 'utf8'));
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

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assertIncludes(text, needle, message) {
  assert.ok(text.includes(needle), `${message}: missing ${needle}`);
}

function assertNotIncludes(text, needle, message) {
  assert.ok(!text.includes(needle), `${message}: unexpected ${needle}`);
}

async function waitForDshUrl(child) {
  let output = '';
  return await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh web did not print a URL before timeout\n${output}`));
    }, 10000);
    const onData = (chunk) => {
      output += chunk.toString('utf8');
      const match = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      resolvePromise({ url: match[1], output });
    };
    const onExit = (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`dsh web exited before serving with code=${code} signal=${signal}\n${output}`));
    };
    const onError = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function dshRpc(baseUrl, method, payload) {
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-hub-g11-${method}-${Date.now()}`,
      method,
      payload,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${method} should return HTTP 200: ${text}`);
  const body = JSON.parse(text);
  return body.result;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, 1500);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

await main();
