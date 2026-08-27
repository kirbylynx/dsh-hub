#!/usr/bin/env node
// M1C opt-in validation against a real local DSH web process.
//
// This script starts an isolated dsh-hub-service and dsh-hub-client with a
// temporary DB/config, then relays the already-running local DSH target. It does
// not modify DSH config and is intentionally not part of the default npm test.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVICE_BIN = path.join(ROOT, 'packages/dsh-hub-service/bin/dsh-hub-service.js');
const CLIENT_BIN = path.join(ROOT, 'packages/dsh-hub-client/bin/dsh-hub-client.js');

const TARGET = validateLoopbackTarget(process.env.DSH_HUB_M1C_TARGET ?? '127.0.0.1:3080');
const DSH_VERSION = process.env.DSH_HUB_M1C_DSH_VERSION ?? detectDshVersion();
const KEEP_MS = Number(process.env.DSH_HUB_M1C_KEEP_MS ?? 0);
const EVIDENCE_FILE = process.env.DSH_HUB_M1C_EVIDENCE_FILE ?? null;
const FILE_STORE_ENV = { DSH_HUB_CLIENT_CREDENTIAL_STORE: 'file' };
const TOKEN_KEYRING_JSON = JSON.stringify({
  m1c: randomBytes(32).toString('base64url'),
});
const IDEMPOTENCY_KEYRING_JSON = JSON.stringify({
  m1c: randomBytes(32).toString('base64url'),
});

let pass = 0;
let fail = 0;
const evidence = {
  target: TARGET,
  direct: {},
  hub: {},
  limitations: [],
};

function check(name, condition, details = {}) {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${details.message ? ` — ${details.message}` : ''}`);
  }
  return condition;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhub-m1c-'));
  const cfgDir = path.join(work, 'cfg');
  const dbPath = path.join(work, 'hub.db');
  fs.mkdirSync(cfgDir, { recursive: true });
  evidence.workDir = work;

  const hubPort = await freePort();
  const base = `http://127.0.0.1:${hubPort}`;
  const children = [];
  const killAll = () => {
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }
  };
  process.on('exit', killAll);

  try {
    console.log(`validating real DSH at http://${TARGET} …`);
    const directRoot = await fetchText(`http://${TARGET}/`);
    evidence.direct.root = summarizeHttp(directRoot);
    check('direct DSH root is reachable', directRoot.status === 200 && directRoot.text.includes('DeepSeek Harness'), evidence.direct.root);

    const directManifest = await fetchText(`http://${TARGET}/manifest.webmanifest`);
    evidence.direct.manifest = summarizeHttp(directManifest);
    check('direct DSH manifest is reachable', directManifest.status === 200, evidence.direct.manifest);

    const directSessionList = await dshRpc(`http://${TARGET}`, 'session.list');
    evidence.direct.sessionList = directSessionList;
    check('direct /api/session.list returns ok JSON-RPC result', directSessionList.status === 200 && directSessionList.ok === true, directSessionList);

    const directFence = await fetchText(`http://${TARGET}/`, { headers: { host: 'm1c-invalid.example' } });
    evidence.direct.hostFence = summarizeHttp(directFence);
    check('direct DSH non-loopback Host behavior recorded', directFence.status > 0, evidence.direct.hostFence);
    if (directFence.status < 400) {
      evidence.limitations.push('Direct loopback DSH accepted a non-loopback Host header; dsh-hub must not rely on DSH Host fencing as an auth boundary.');
    }

    evidence.direct.eventsMux = await wsProbe(`ws://${TARGET}/api/events.mux`, { expectMessage: true });
    check('direct /api/events.mux opens and emits events', evidence.direct.eventsMux.opened && evidence.direct.eventsMux.messages > 0, evidence.direct.eventsMux);

    evidence.direct.eventsHost = await wsProbe(`ws://${TARGET}/api/events.host`, { expectMessage: false });
    check('direct /api/events.host opens', evidence.direct.eventsHost.opened, evidence.direct.eventsHost);

    console.log('starting isolated dsh-hub-service …');
    const serviceEnv = {
      DEV_AUTH_USER: 'm1c-owner',
      PUBLIC_PORT: String(hubPort),
      TOKEN_PEPPER_KEYRING: TOKEN_KEYRING_JSON,
      CURRENT_TOKEN_PEPPER_KEY_ID: 'm1c',
      IDEMPOTENCY_ENCRYPTION_KEYRING: IDEMPOTENCY_KEYRING_JSON,
      CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'm1c',
    };
    children.push(spawnNode(SERVICE_BIN, ['--port', String(hubPort), '--db', dbPath], serviceEnv, path.join(work, 'service.log')));
    await waitFor(async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok === true, 10_000, 'hub service');

    console.log('creating isolated namespace and joining client …');
    const portalForCsrf = await api(base, '/api/portal');
    const ns = await api(base, '/api/namespaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-csrf-token': portalForCsrf.csrfToken,
      },
      body: JSON.stringify({ name: 'm1c-real-dsh' }),
    });
    check('namespace created with one-time visible registry key', ns.registryKey?.startsWith('dhk_'));

    const joinArgs = [
      'join',
      '--endpoint', base,
      '--registry-key', ns.registryKey,
      '--target', TARGET,
      '--config-dir', cfgDir,
    ];
    if (DSH_VERSION) joinArgs.push('--dsh-version', DSH_VERSION);
    const join = spawnSyncCapture(CLIENT_BIN, joinArgs, FILE_STORE_ENV);
    check('client join succeeded', join.code === 0, { message: join.out });
    const instanceId = join.out.match(/joined as instance (\S+)/)?.[1];
    check('client join returned instance id', !!instanceId, { message: join.out });
    evidence.hub.instanceId = instanceId;

    const client = spawnNode(CLIENT_BIN, ['run', '--config-dir', cfgDir], FILE_STORE_ENV, path.join(work, 'client.log'));
    children.push(client);
    await waitFor(async () => {
      const portal = await api(base, '/api/portal');
      return portal.instances.some((item) => item.instanceId === instanceId && item.connectionState === 'online');
    }, 15_000, 'instance online');
    check('portal reports real DSH instance online', true);

    const instanceBase = `http://${instanceId}.localhost:${hubPort}`;
    evidence.hub.instanceBase = instanceBase;
    const relayedRoot = await fetchText(`${instanceBase}/`);
    evidence.hub.root = summarizeHttp(relayedRoot);
    check('relayed root loads original DSH HTML', relayedRoot.status === 200 && relayedRoot.text.includes('DeepSeek Harness'), evidence.hub.root);

    const relayedSessionList = await dshRpc(instanceBase, 'session.list', { origin: instanceBase });
    evidence.hub.sessionList = relayedSessionList;
    check('relayed /api/session.list returns ok JSON-RPC result', relayedSessionList.status === 200 && relayedSessionList.ok === true, relayedSessionList);

    const assetPaths = [...relayedRoot.text.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((url) => url.startsWith('/assets/') || url === '/manifest.webmanifest' || url === '/favicon.svg')
      .slice(0, 8);
    evidence.hub.assets = [];
    for (const asset of assetPaths) {
      const res = await fetchText(`${instanceBase}${asset}`);
      evidence.hub.assets.push({ path: asset, ...summarizeHttp(res) });
    }
    check('relayed static assets load without 404', evidence.hub.assets.length > 0 && evidence.hub.assets.every((item) => item.status >= 200 && item.status < 400), {
      message: JSON.stringify(evidence.hub.assets),
    });

    evidence.hub.eventsMux = await wsProbe(`${instanceBase.replace(/^http/, 'ws')}/api/events.mux`, {
      origin: instanceBase,
      expectMessage: true,
    });
    check('relayed /api/events.mux opens and emits events', evidence.hub.eventsMux.opened && evidence.hub.eventsMux.messages > 0, evidence.hub.eventsMux);

    evidence.hub.eventsHost = await wsProbe(`${instanceBase.replace(/^http/, 'ws')}/api/events.host`, {
      origin: instanceBase,
      expectMessage: false,
    });
    check('relayed /api/events.host opens', evidence.hub.eventsHost.opened, evidence.hub.eventsHost);

    const portal = await api(base, '/api/portal');
    const inst = portal.instances.find((item) => item.instanceId === instanceId);
    evidence.hub.portalInstance = summarizePortalInstance(inst);
    check('portal lists delivery, connectionState and DSH health', inst?.delivery === 'agent'
      && inst?.connectionState === 'online'
      && inst?.dshHealth?.lastReportedOnline === true
      && inst?.dshVersion === DSH_VERSION, inst ?? {});

    evidence.limitations.push('Did not stop/restart the user’s running DSH process; DSH stop/recover remains manual or requires separate explicit permission.');
    evidence.limitations.push('Cookie/identity header stripping is covered by mock/security tests; real DSH does not expose received headers for direct confirmation.');

    console.log('\nM1C evidence:');
    console.log(JSON.stringify(evidence, null, 2));
    writeEvidence();
    if (KEEP_MS > 0) {
      console.log(`keeping isolated hub alive for ${KEEP_MS}ms …`);
      await new Promise((resolve) => setTimeout(resolve, KEEP_MS));
    }
    console.log(`\nresult: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('M1C validation failed:', err);
    console.log('\nM1C evidence:');
    console.log(JSON.stringify(evidence, null, 2));
    writeEvidence();
    console.log(`result: ${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  } finally {
    killAll();
  }
}

function summarizeHttp(res) {
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: Buffer.byteLength(res.text),
    sample: res.text.slice(0, 120).replace(/\s+/g, ' '),
  };
}

function summarizePortalInstance(inst) {
  if (!inst) return null;
  return {
    delivery: inst.delivery,
    clientVersion: inst.clientVersion,
    dshVersion: inst.dshVersion,
    state: inst.state,
    connectionState: inst.connectionState,
    dshHealth: inst.dshHealth ? {
      lastReportedOnline: inst.dshHealth.lastReportedOnline,
      freshness: inst.dshHealth.freshness,
    } : null,
  };
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(6_000) });
  return { status: res.status, headers: res.headers, text: await res.text().catch(() => '') };
}

async function dshRpc(base, method, { origin = null } = {}) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `m1c-${method}`,
    method,
    payload: {},
  });
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(6_000),
  });
  const text = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* noop */ }
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: Buffer.byteLength(text),
    rpcType: parsed?.type ?? null,
    ok: parsed?.result?.ok === true,
    itemCount: Array.isArray(parsed?.result?.value?.items) ? parsed.result.value.items.length : null,
  };
}

function wsProbe(url, { origin = null, expectMessage = false } = {}) {
  return new Promise((resolve) => {
    const result = { opened: false, messages: 0, firstBytes: 0, error: null };
    let settled = false;
    const settle = (socket) => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* noop */ }
      resolve(result);
    };
    const headers = origin ? { origin } : {};
    const socket = new WebSocket(url, { headers });
    const timeout = setTimeout(() => {
      if (!expectMessage && result.opened) settle(socket);
      else settle(socket);
    }, expectMessage ? 5_000 : 2_500);
    socket.on('open', () => { result.opened = true; });
    socket.on('message', (data) => {
      result.messages += 1;
      if (!result.firstBytes) result.firstBytes = Buffer.byteLength(data);
      if (expectMessage) {
        clearTimeout(timeout);
        settle(socket);
      }
    });
    socket.on('error', (err) => {
      result.error = err.message;
      clearTimeout(timeout);
      settle(socket);
    });
  });
}

function spawnNode(bin, args, env, logFile) {
  const out = fs.openSync(logFile, 'a');
  return spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
  });
}

function spawnSyncCapture(bin, args, env = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function detectDshVersion() {
  const res = spawnSync('dsh', ['--version'], { encoding: 'utf8' });
  const value = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return res.status === 0 && value ? value : null;
}

function validateLoopbackTarget(raw) {
  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    throw new Error('DSH_HUB_M1C_TARGET must be a loopback host:port, for example 127.0.0.1:3080');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('DSH_HUB_M1C_TARGET must not include credentials, path, query or fragment');
  }
  if (!parsed.port) {
    throw new Error('DSH_HUB_M1C_TARGET must include an explicit port');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('DSH_HUB_M1C_TARGET must be loopback only: 127.0.0.1, localhost or ::1');
  }
  return host === '::1' ? `[::1]:${parsed.port}` : `${host}:${parsed.port}`;
}

function writeEvidence() {
  if (!EVIDENCE_FILE) return;
  fs.writeFileSync(EVIDENCE_FILE, JSON.stringify({ pass, fail, evidence }, null, 2));
}

async function api(base, url, opts) {
  const request = opts ? { ...opts, headers: { ...(opts.headers ?? {}) } } : {};
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !request.headers['idempotency-key'] && !request.headers['Idempotency-Key']) {
    request.headers['idempotency-key'] = `m1c_${randomBytes(18).toString('base64url')}`;
  }
  const res = await fetch(base + url, request);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

await main();
