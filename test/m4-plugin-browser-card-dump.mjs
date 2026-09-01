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
    await assertClientFactory(readFileSync(join(PLUGIN_ROOT, 'client.js'), 'utf8'));

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
    assert.deepEqual(row.inject, ['@deepseek-ai/dsh-client-ui-settings-plugins', '@deepseek-ai/dsh-client-ui-conversation']);
    assert.equal(row.immediately, undefined, 'M4D browser card should not force immediate materialization');

    const servedClient = await fetchText(new URL(row.url, url).href);
    assert.match(servedClient, /window\.__ModuleLoader__\.load/);
    assert.match(servedClient, /id: 'dsh-hub-plugin'/);
    assert.match(servedClient, /settings\.plugin\.item/);
    await assertClientFactory(servedClient);
    const statusPayload = await fetchJson(new URL('/plugins/dsh-hub-plugin/status.json', url).href);
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.statusView.summary.state, 'disabled');
    assert.equal(statusPayload.statusView.connection.delivery, 'plugin');
    assert.equal(statusPayload.capabilities.liveStatusEndpoint, true);
    assert.equal(statusPayload.capabilities.sessionHistoryAutoLoad, true);
    assert.equal(statusPayload.capabilities.sessionHistoryDiagnostics, true);
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

async function assertClientFactory(source) {
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
    URL,
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
          if (typeof type === 'function') {
            return type({
              ...(props ?? {}),
              ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
            });
          }
          return { type, props, children };
        },
        Fragment: 'Fragment',
      };
    }
    throw new Error(`unexpected browser factory require: ${specifier}`);
  });
  assert.deepEqual(Array.from(exports.inject), ['slots', 'locale', 'sessions']);
  assert.equal(exports.SETTINGS_KEY, 'dsh-hub');
  assert.equal(exports.STATUS_ENDPOINT, '/plugins/dsh-hub-plugin/status.json');
  assert.equal(exports.HISTORY_AUTOLOAD_THRESHOLD_PX, 240);
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.createHistoryAutoLoadController, 'function');
  assert.equal(typeof exports.findHistoryScrollports, 'function');
  assert.equal(typeof exports.HistoryAutoLoadController, 'function');
  assert.equal(typeof exports.historyAutoLoadEnabledForBrowser, 'function');
  assert.equal(typeof exports.resolveHistoryAutoLoadEnabled, 'function');
  assert.equal(typeof exports.shouldAutoLoadHistory, 'function');
  assert.equal(exports.historyAutoLoadEnabledForBrowser({ hostname: '127.0.0.1' }), false);
  assert.equal(exports.historyAutoLoadEnabledForBrowser({
    hostname: 'inst-abc.instances.example.com',
    href: 'https://inst-abc.instances.example.com/',
  }, {
    connection: { instanceUrl: 'https://inst-abc.instances.example.com/' },
    capabilities: { sessionHistoryAutoLoad: true },
  }), true);
  assert.equal(exports.historyAutoLoadEnabledForBrowser({
    hostname: 'desk.local',
    href: 'https://desk.local/',
  }, {
    connection: { instanceUrl: 'https://inst-abc.instances.example.com/' },
    capabilities: { sessionHistoryAutoLoad: true },
  }), false);
  assert.equal(exports.historyAutoLoadEnabledForBrowser({
    hostname: 'inst-abc.instances.example.com',
    href: 'https://inst-abc.instances.example.com/',
  }, {
    connection: { instanceUrl: 'https://inst-abc.instances.example.com/' },
    capabilities: { sessionHistoryAutoLoad: false },
  }), false);

  let registeredLocale;
  let injectedSlot;
  let registered;
  const registrations = new Map();
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
        registrations.set(name, registered);
        return () => {};
      },
      register(options, component) {
        return { options, component };
      },
    },
    sessions: {
      binding() {
        return { session: fakeSession() };
      },
    },
  };
  exports.apply(ctx);
  assert.equal(registeredLocale.ns, 'dsh-hub.browser');
  assert.ok(registeredLocale.copy.zh.title);
  assert.equal(injectedSlot, 'conversation.session.header.utilities');
  const tabRegistration = registrations.get('settings.plugins.tab');
  assert.equal(tabRegistration.options.name, 'settings.plugins.tab');
  assert.equal(tabRegistration.options.id, 'dsh-hub');
  assert.equal(tabRegistration.options.order, 20);
  assert.equal(tabRegistration.options.locale, 'dsh-hub.browser');
  assert.equal(tabRegistration.options.label(), 'dsh-hub');
  const settingsRegistration = registrations.get('settings.plugin.item');
  assert.equal(settingsRegistration.options.name, 'settings.plugin.item');
  assert.equal(settingsRegistration.options.key, 'dsh-hub');
  assert.equal(settingsRegistration.options.locale, 'dsh-hub.browser');
  const tabElement = tabRegistration.component({ t: (key) => key });
  assert.equal(tabElement.type, 'div');
  const autoLoadRegistration = registrations.get('conversation.session.header.utilities');
  assert.equal(autoLoadRegistration.options.name, 'conversation.session.header.utilities');
  assert.equal(autoLoadRegistration.options.id, 'dsh-hub-history-autoload');
  assert.equal(autoLoadRegistration.options.order, 100);
  assert.equal(autoLoadRegistration.options.inject('sess-1').session.sessionId, 'sess-1');
  const element = settingsRegistration.component({ t: (key) => key });
  assert.equal(element.type, 'li');
  const renderedText = renderTreeText(settingsRegistration.component({
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
        historyRelay: {
          retained: 1,
          limit: 20,
          recent: [{
            requestId: 'hist-1',
            method: 'session.history',
            path: '/api/session.history',
            status: 200,
            requestBytes: 120,
            rawResponseBytes: 7000000,
            normalizedBytes: 0,
            elapsedMs: 2400,
            errorCode: 'HISTORY_UNSUPPORTED_ENCODING',
            terminalState: 'error',
            contentEncoding: 'gzip',
            normalized: false,
          }],
        },
      },
    },
  }));
  assert.match(renderedText, /Plugin tunnel is connected/);
  assert.match(renderedText, /tunnel-running/);
  assert.match(renderedText, /v1\.1/);
  assert.match(renderedText, /inst-abcdefghijklmnopqrstuvwxyz\.instances\.hub\.example\.com/);
  assert.match(renderedText, /unlinked=24/);
  assert.match(renderedText, /HISTORY_UNSUPPORTED_ENCODING/);
  assert.match(renderedText, /raw=7000000B/);
  assert.doesNotMatch(renderedText, /dhk_|dhr_|dht_|dit_|dhk_browser_secret/);
  assert.doesNotMatch(renderedText, /\/workspace\/example|C:\\Workspace\\example/);
  assert.match(renderedText, /\[redacted-secret\]/);
  assert.match(renderedText, /\[redacted-path\]/);
  assert.match(renderedText, /historyAutoLoad/);
  assert.match(source, /historyRetry/);
  await assertHistoryAutoLoad(exports);
}

function renderTreeText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(renderTreeText).join(' ');
  return [renderTreeText(node.children), renderTreeText(node.props?.children)].filter(Boolean).join(' ');
}

function fakeSession(snapshot = {}) {
  return {
    sessionId: 'sess-1',
    getSnapshot() {
      return {
        openState: 'open',
        hasMore: true,
        loadingOlder: false,
        ...snapshot,
      };
    },
    subscribe() {
      return () => {};
    },
    async loadOlder() {},
  };
}

async function assertHistoryAutoLoad(exports) {
  const scrollport = fakeScrollport({ scrollTop: 0 });
  const flow = {
    parentElement: scrollport,
    closest() {
      return null;
    },
  };
  const doc = fakeDocument([flow]);
  const ports = exports.findHistoryScrollports(doc);
  assert.equal(ports.length, 1);
  assert.equal(ports[0], scrollport);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'open', hasMore: true, loadingOlder: false }, scrollport), true);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'open', hasMore: true, loadingOlder: false }, scrollport, { armed: false }), false);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'open', hasMore: true, loadingOlder: false }, fakeScrollport({ scrollTop: 241 })), false);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'loading', hasMore: true, loadingOlder: false }, scrollport), false);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'open', hasMore: false, loadingOlder: false }, scrollport), false);
  assert.equal(exports.shouldAutoLoadHistory({ openState: 'open', hasMore: true, loadingOlder: true }, scrollport), false);

  let loads = 0;
  let releaseLoad;
  const session = fakeSession();
  session.loadOlder = () => {
    loads += 1;
    return new Promise((resolve) => {
      releaseLoad = resolve;
    });
  };
  const timers = fakeTimers();
  const controller = exports.createHistoryAutoLoadController({
    session,
    doc,
    locationLike: {
      hostname: 'inst-abc.instances.example.com',
      href: 'https://inst-abc.instances.example.com/',
    },
    fetchStatusView: async () => ({
      connection: { instanceUrl: 'https://inst-abc.instances.example.com/' },
      capabilities: { sessionHistoryAutoLoad: true },
    }),
    recheckMs: 1,
    timer: timers,
  });
  const stop = controller.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scrollport.emitScroll();
  assert.equal(loads, 1);
  scrollport.emitScroll();
  assert.equal(loads, 1, 'in-flight load suppresses duplicate scroll triggers');
  releaseLoad();
  await new Promise((resolve) => setTimeout(resolve, 0));
  timers.flush();
  assert.equal(loads, 1, 'settling at top does not auto-drain additional pages without another scroll');
  scrollport.emitScroll();
  assert.equal(loads, 1, 'staying near the top does not re-arm the next autoload');
  scrollport.scrollTop = 999;
  scrollport.emitScroll();
  assert.equal(loads, 1, 'leaving the top threshold only re-arms the next autoload');
  scrollport.scrollTop = 0;
  scrollport.emitScroll();
  assert.equal(loads, 2, 'returning to the top after leaving the threshold loads another page');
  stop();
  scrollport.emitScroll();
  assert.equal(loads, 2, 'controller cleanup removes scroll listener');

  let starts = 0;
  let errors = 0;
  const failingSession = fakeSession();
  failingSession.loadOlder = async () => {
    throw new Error('failed with dhk_secret at /workspace/private');
  };
  const failingController = exports.createHistoryAutoLoadController({
    session: failingSession,
    doc,
    locationLike: { historyAutoLoadEnabled: true },
    timer: timers,
    onLoadStart: () => {
      starts += 1;
    },
    onLoadError: () => {
      errors += 1;
    },
  });
  const failingStop = failingController.start();
  await Promise.resolve();
  scrollport.scrollTop = 999;
  scrollport.emitScroll();
  scrollport.scrollTop = 0;
  scrollport.emitScroll();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(starts, 1, 'autoload failure records load start');
  assert.equal(errors, 1, 'autoload failure records retryable browser-side error state');
  failingStop();

  let localLoads = 0;
  const localSession = fakeSession();
  localSession.loadOlder = async () => {
    localLoads += 1;
  };
  const localController = exports.createHistoryAutoLoadController({
    session: localSession,
    doc,
    locationLike: { hostname: '127.0.0.1', href: 'http://127.0.0.1:3080/' },
    timer: timers,
  });
  const localStop = localController.start();
  await Promise.resolve();
  scrollport.emitScroll();
  assert.equal(localLoads, 0, 'loopback browser keeps local DSH web UI unchanged');
  localStop();
}

function fakeDocument(flows) {
  return {
    body: {},
    querySelectorAll(selector) {
      assert.equal(selector, '[data-chat-flow]');
      return flows;
    },
  };
}

function fakeScrollport({ scrollTop }) {
  const listeners = new Set();
  return {
    scrollTop,
    addEventListener(type, fn) {
      assert.equal(type, 'scroll');
      listeners.add(fn);
    },
    removeEventListener(type, fn) {
      assert.equal(type, 'scroll');
      listeners.delete(fn);
    },
    emitScroll() {
      for (const fn of [...listeners]) fn();
    },
  };
}

function fakeTimers() {
  const pending = new Set();
  return {
    setTimeout(fn) {
      pending.add(fn);
      return fn;
    },
    clearTimeout(fn) {
      pending.delete(fn);
    },
    flush() {
      const batch = [...pending];
      pending.clear();
      for (const fn of batch) fn();
    },
  };
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
