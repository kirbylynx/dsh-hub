#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_ROOT = join(REPO_ROOT, 'packages/dsh-hub-plugin');

async function main() {
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-hub-m4d-browser-'));
  let child;
  try {
    installPluginIntoTemporaryProfile(tempHome);
    assertClientFactory(readFileSync(join(PLUGIN_ROOT, 'client.js'), 'utf8'));

    child = spawn('dsh', ['--profile', 'web', '--port', '0'], {
      env: { ...process.env, DSH_HOME: tempHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const { url, output } = await waitForDshUrl(child);
    assert.doesNotMatch(output, /client bundle not found|failed to import loader entry|Cannot find package|ERR_MODULE_NOT_FOUND/i);

    const root = await fetchText(url);
    const graph = extractBootGraph(root);
    const row = graph.entries.find((entry) => entry.id === 'dsh-hub-plugin');
    assert.ok(row, 'DSH boot graph contains dsh-hub-plugin browser row');
    assert.equal(row.url, `/plugins/dsh-hub-plugin/client.js?rev=${row.rev}`);
    assert.deepEqual(row.inject, ['@deepseek-ai/dsh-client-ui-settings-plugins']);
    assert.equal(row.immediately, undefined, 'M4D browser card should not force immediate materialization');

    const servedClient = await fetchText(new URL(row.url, url).href);
    assert.match(servedClient, /window\.__ModuleLoader__\.load/);
    assert.match(servedClient, /id: 'dsh-hub-plugin'/);
    assert.match(servedClient, /settings\.plugin\.item/);
    assertClientFactory(servedClient);
    const statusPayload = await fetchJson(new URL('/plugins/dsh-hub-plugin/status.json', url).href);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.statusView.summary.state, 'disabled');
    assert.equal(statusPayload.statusView.connection.delivery, 'plugin');
    assert.equal(statusPayload.capabilities.liveStatusEndpoint, true);
    assert.equal(JSON.stringify(statusPayload).includes('registry'), false);
    assert.equal(JSON.stringify(statusPayload).includes('instanceToken'), false);

    console.log(JSON.stringify({
      ok: true,
      plugin: 'dsh-hub-plugin',
      profile: 'web',
      verification: 'temporary DSH_HOME + dsh.client graph + served /plugins/dsh-hub-plugin/client.js + lazy-CJS factory slot registration',
      browserSettingsCard: true,
      browserLiveStatusEndpoint: true,
      tunnelRuntime: true,
      browserSecretHandling: false,
    }, null, 2));
  } finally {
    if (child) await stopChild(child);
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function installPluginIntoTemporaryProfile(tempHome) {
  const dump = spawnSyncText('dsh', ['--profile', 'web', '--dump-config'], {
    env: { ...process.env, DSH_HOME: tempHome },
  });
  assert.match(dump, /id: webserver/);
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

async function fetchText(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, `GET ${url} should return 200`);
  return await response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  assert.equal(response.status, 200, `GET ${url} should return 200`);
  return await response.json();
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

function extractBootGraph(html) {
  const match = html.match(/(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*(.*?)<\/script>/s);
  assert.ok(match, 'index html contains DSH boot graph');
  const graph = JSON.parse(match[1]);
  assert.ok(Array.isArray(graph.entries), 'boot graph has entries');
  return graph;
}

function assertClientFactory(source) {
  let handoff;
  const context = {
    window: {
      __ModuleLoader__: {
        load(value) {
          handoff = value;
        },
      },
    },
    navigator: { language: 'en-US' },
  };
  vm.runInNewContext(source, context, { filename: 'dsh-hub-plugin/client.js' });
  assert.equal(handoff?.id, 'dsh-hub-plugin');
  assert.equal(typeof handoff.factory, 'function');
  const exports = handoff.factory((specifier) => {
    if (specifier === 'react') {
      return {
        useState(initial) {
          return [typeof initial === 'function' ? initial() : initial, () => {}];
        },
        useEffect() {
          return undefined;
        },
        createElement(type, props, ...children) {
          return { type, props, children };
        },
      };
    }
    throw new Error(`unexpected browser factory require: ${specifier}`);
  });
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale']);
  assert.equal(exports.SETTINGS_KEY, 'dsh-hub');
  assert.equal(exports.STATUS_ENDPOINT, '/plugins/dsh-hub-plugin/status.json');
  assert.equal(typeof exports.apply, 'function');

  let registeredLocale;
  let injectedSlot;
  let registered;
  const ctx = {
    effect(fn) {
      return fn();
    },
    locale: {
      register(ns, copy) {
        registeredLocale = { ns, copy };
        return () => {};
      },
    },
    slots: {
      inject(name, producer) {
        injectedSlot = name;
        registered = producer();
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
  };
  exports.apply(ctx);
  assert.equal(registeredLocale.ns, 'dsh-hub.browser');
  assert.ok(registeredLocale.copy.zh.title);
  assert.equal(injectedSlot, 'settings.plugin.item');
  assert.equal(registered.options.name, 'settings.plugin.item');
  assert.equal(registered.options.key, 'dsh-hub');
  assert.equal(registered.options.locale, 'dsh-hub.browser');
  const element = registered.component({ t: (key) => key });
  assert.equal(element.type, 'li');
  const renderedText = renderTreeText(registered.component({
    t: (key) => key,
    statusView: {
      summary: { message: 'Plugin tunnel is connected with dhk_browser_secret at /workspace/example.' },
      connection: {
        state: 'tunnel-running',
        delivery: 'plugin',
        protocol: 'v1.1',
        instanceId: 'inst-abcdefghijklmnopqrstuvwxyz',
        instanceUrl: 'https://inst-abcdefghijklmnopqrstuvwxyz.instances.hub.example.com/',
        target: 'C:\\Users\\alice\\work',
      },
      diagnostics: {
        workspaceMapping: {
          sessionCount: 37,
          workspaceCount: 5,
          linkedSessionCount: 13,
          unlinkedSessionCount: 24,
          staleWorkspaceSessionCount: 1,
        },
      },
    },
  }));
  assert.match(renderedText, /Plugin tunnel is connected/);
  assert.match(renderedText, /tunnel-running/);
  assert.match(renderedText, /v1\.1/);
  assert.match(renderedText, /inst-abcdefghijklmnopqrstuvwxyz\.instances\.hub\.example\.com/);
  assert.match(renderedText, /unlinked=24/);
  assert.doesNotMatch(renderedText, /dhk_|dhr_|dht_|dit_|dhk_browser_secret/);
  assert.doesNotMatch(renderedText, /\/workspace\/example|C:\\Workspace\\example/);
  assert.match(renderedText, /\[redacted-secret\]/);
  assert.match(renderedText, /\[redacted-path\]/);
}

function renderTreeText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderTreeText).join(' ');
  return [renderTreeText(node.children), renderTreeText(node.props?.children)].filter(Boolean).join(' ');
}

function spawnSyncText(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout || ''}\n${result.stderr || ''}`);
  }
  return result.stdout;
}

main();
