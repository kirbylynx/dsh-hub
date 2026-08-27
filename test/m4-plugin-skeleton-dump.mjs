#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'packages/dsh-hub-plugin');

function main() {
  assert.ok(existsSync(join(PLUGIN_ROOT, 'package.json')), 'dsh-hub-plugin package exists');
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-hub-m4b-'));
  try {
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

    const dump = execText('dsh', ['--profile', 'web', '--dump-config'], {
      env: { ...process.env, DSH_HOME: tempHome },
    });
    assertIncludes(dump, "id: dsh-hub-plugin\n  name: dsh-hub-plugin", 'composed config contains dsh-hub-plugin row');
    assertIncludes(dump, 'enabled: false', 'dsh-hub-plugin remains default-off in composed config');
    assertIncludes(dump, "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'", 'default directory picker is still auto');
    assertNotIncludes(dump, 'id: directory-picker-browse', 'M4B does not mount browse picker backend');
    assertNotIncludes(dump, 'id: ui-directory-picker-browse', 'M4B does not mount browse picker client surface');
    assert.equal(countRows(dump, 'webserver'), 1, 'M4B must not add a second webserver row');
    assert.equal(countRows(dump, 'dsh-hub-plugin'), 1, 'M4B must mount exactly one plugin row');
    assertRuntimeActivation(tempHome);

    console.log(JSON.stringify({
      ok: true,
      plugin: 'dsh-hub-plugin',
      profile: 'web',
      verification: 'temporary DSH_HOME profile package + node_modules symlink + dsh --dump-config',
      defaultOff: true,
      secondWebserver: false,
      browsePickerAdapter: false,
      runtimeActivation: true,
    }, null, 2));
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function assertRuntimeActivation(tempHome) {
  const result = spawnSync('dsh', ['--profile', 'web', '--port', '0'], {
    env: { ...process.env, DSH_HOME: tempHome },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 4000,
    killSignal: 'SIGTERM',
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  assert.doesNotMatch(output, /failed to import loader entry|Cannot find package|ERR_MODULE_NOT_FOUND/i);
  if (result.status === 0) {
    assert.match(output, /dsh web: http:\/\/127\.0\.0\.1:\d+/);
    return;
  }
  if (result.status !== null) {
    assert.fail(`dsh web exited before runtime activation timeout with status ${result.status}\n${output}`);
  }
  assert.equal(result.signal, 'SIGTERM', `dsh web should be stopped by the runtime activation timeout\n${output}`);
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

main();
