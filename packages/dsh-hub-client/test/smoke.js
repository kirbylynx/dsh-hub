#!/usr/bin/env node
// End-to-end smoke test: 注册 → 隧道 → 子域 → HTTP/WS 中继 → 门户。
// Starts a mock DSH web + dsh-hub-service, joins a dsh-hub-client, then
// verifies HTTP relay (incl. Host rewrite) and WebSocket relay.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVICE_BIN = path.join(ROOT, 'packages/dsh-hub-service/bin/dsh-hub-service.js');
const CLIENT_BIN = path.join(ROOT, 'packages/dsh-hub-client/bin/dsh-hub-client.js');
const MOCK_BIN = path.join(ROOT, 'packages/dsh-hub-client/test/mock-dsh.mjs');

const HUB_PORT = 18081;
const MOCK_PORT = 13180;
const BASE = `http://127.0.0.1:${HUB_PORT}`;
const FILE_STORE_ENV = { DSH_HUB_CLIENT_CREDENTIAL_STORE: 'file' };
const TOKEN_KEYRING_JSON = JSON.stringify({
  smoke: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64url'),
});
const IDEMPOTENCY_KEYRING_JSON = JSON.stringify({
  smoke: Buffer.from('abcdef0123456789abcdef0123456789', 'utf8').toString('base64url'),
});
const SERVICE_ENV = {
  DEV_AUTH_USER: 'owner',
  PUBLIC_PORT: String(HUB_PORT),
  TOKEN_PEPPER_KEYRING: TOKEN_KEYRING_JSON,
  CURRENT_TOKEN_PEPPER_KEY_ID: 'smoke',
  IDEMPOTENCY_ENCRYPTION_KEYRING: IDEMPOTENCY_KEYRING_JSON,
  CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'smoke',
};

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnDetached(bin, args, env, logFile) {
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', out, out],
  });
  return child;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhub-smoke-'));
  const cfgDir = path.join(work, 'cfg');
  const dbPath = path.join(work, 'hub.db');
  fs.mkdirSync(cfgDir, { recursive: true });

  const children = [];
  const killAll = () => {
    for (const c of children) {
      try { c.kill('SIGTERM'); } catch { /* noop */ }
    }
  };
  process.on('exit', killAll);

  try {
    // 1. mock DSH web + hub service
    console.log('starting mock DSH web + dsh-hub-service …');
    children.push(spawnDetached(MOCK_BIN, [String(MOCK_PORT)], {}, path.join(work, 'mock.log')));
    children.push(spawnDetached(SERVICE_BIN, ['--port', String(HUB_PORT), '--db', dbPath], SERVICE_ENV, path.join(work, 'service.log')));
    await waitFor(async () => (await fetch(`${BASE}/healthz`).catch(() => null))?.ok === true, 10000, 'hub up');

    // 2. create namespace -> registry key
    console.log('creating namespace …');
    const portalForCsrf = await api('/api/portal');
    const ns = await api('/api/namespaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        'x-csrf-token': portalForCsrf.csrfToken,
      },
      body: JSON.stringify({ name: 'smoke-team' }),
    });
    check('namespace created with registry key', !!ns.registryKey?.startsWith('dhk_'));
    const registryKey = ns.registryKey;

    // 3. client join
    console.log('client join …');
    const joinRes = spawnSyncCapture(
      CLIENT_BIN,
      ['join', '--endpoint', BASE, '--registry-key', registryKey, '--target', `127.0.0.1:${MOCK_PORT}`, '--config-dir', cfgDir],
      FILE_STORE_ENV,
    );
    check('join exited 0', joinRes.code === 0, joinRes.out);
    const instanceId = (joinRes.out.match(/joined as instance (\S+)/) || [])[1];
    check('join reported instance id', !!instanceId, joinRes.out);
    check('credentials file 0600', (() => { try { return (fs.statSync(path.join(cfgDir, 'credentials.json')).mode & 0o777) === 0o600; } catch { return false; } })(), 'credentials.json missing or wrong mode');
    const savedCreds = JSON.parse(fs.readFileSync(path.join(cfgDir, 'credentials.json'), 'utf8'));
    check('joined credentials persist installationId', /^insl_[A-Za-z0-9_-]{22}$/.test(savedCreds.installationId), JSON.stringify(savedCreds));
    check('joined credentials do not persist registry key', !('registryKey' in savedCreds), JSON.stringify(savedCreds));
    check('pending register journal cleared after success', !fs.existsSync(path.join(cfgDir, 'pending-register.json')));

    // 4. client run (background)
    console.log('client run …');
    const client = spawnDetached(CLIENT_BIN, ['run', '--config-dir', cfgDir], FILE_STORE_ENV, path.join(work, 'client.log'));
    children.push(client);

    // 5. wait for instance online in portal
    await waitFor(async () => {
      const p = await api('/api/portal');
      return p.instances.some((i) => i.instanceId === instanceId && i.connectionState === 'online');
    }, 15000, 'instance online');
    console.log('instance online in portal ✓');

    // 6. HTTP relay via instance subdomain
    const sub = `http://${instanceId}.localhost:${HUB_PORT}`;
    const rootRes = await fetch(`${sub}/`);
    const rootHtml = await rootRes.text();
    check('HTTP relay: instance subdomain root', rootRes.status === 200 && rootHtml.includes('mock DSH web'), `status=${rootRes.status}`);

    const echo = await api(`${sub}/api/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: sub },
      body: JSON.stringify({ x: 1 }),
    });
    check('HTTP relay: POST /api/echo', echo.ok === true && echo.method === 'POST' && echo.url === '/api/echo', JSON.stringify(echo));
    check('Host rewritten to loopback (fence bypass)', String(echo.host).startsWith('127.0.0.1:'), `got host=${echo.host}`);

    const echoGet = await fetch(`${sub}/api/version`).then((r) => r.json());
    check('HTTP relay: GET /api/*', echoGet.ok === true && echoGet.path === '/api/version');

    // 7. WebSocket relay via instance subdomain
    const wsOk = await testWsRelay(`${sub.replace(/^http/, 'ws')}/api/events.mux`, sub);
    check('WS relay: /api/events.mux streams through tunnel', wsOk);

    // 8. portal lists instance online + delivery
    const portal = await api('/api/portal');
    const inst = portal.instances.find((i) => i.instanceId === instanceId);
    check('portal lists instance (delivery=agent, online)', inst && inst.delivery === 'agent' && inst.connectionState === 'online');

    // 9. auth boundary: no DEV_AUTH_USER -> 401 (start second service without it? we test header trust instead)
    console.log('\nresult: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('smoke failed:', err);
    fail++;
    console.log('result: ' + pass + ' passed, ' + fail + ' failed');
    process.exit(1);
  }
}

function spawnSyncCapture(bin, args, env = {}) {
  const res = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

async function api(url, opts) {
  const full = /^https?:\/\//.test(url) ? url : BASE + url;
  const request = opts ? { ...opts, headers: { ...(opts.headers ?? {}) } } : {};
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !request.headers['idempotency-key'] && !request.headers['Idempotency-Key']) {
    request.headers['idempotency-key'] = `smoke_${randomBytes(12).toString('base64url')}`;
  }
  const r = await fetch(full, request);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${full} -> ${r.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(fn, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn().catch(() => false)) return;
    await sleep(300);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function testWsRelay(url, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { origin } });
    const seen = new Set();
    const t = setTimeout(() => {
      ws.close();
      resolve(seen.has('hello') && seen.has('tick') && seen.has('client-msg'));
    }, 5000);
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        if (m.type) seen.add(m.type);
        if (m.type === 'client-msg' && seen.has('hello') && seen.has('tick')) {
          clearTimeout(t);
          ws.close();
          resolve(true);
        }
      } catch { /* noop */ }
    });
    ws.on('open', () => { /* browser->instance direction also exercised by send below */ ws.send(JSON.stringify({ type: 'client-msg' })); });
    ws.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

await main();
