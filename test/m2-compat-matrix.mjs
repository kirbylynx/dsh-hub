#!/usr/bin/env node
// M2 local compatibility and recovery evidence.
//
// This script is intentionally self-contained and uses a mock DSH. It proves the
// M2 matrix is repeatable locally before the same checklist is run against a real
// remote DSH/VPS environment.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SERVICE_BIN = path.join(ROOT, 'packages/dsh-hub-service/bin/dsh-hub-service.js');
const CLIENT_BIN = path.join(ROOT, 'packages/dsh-hub-client/bin/dsh-hub-client.js');
const MOCK_BIN = path.join(ROOT, 'packages/dsh-hub-client/test/mock-dsh.mjs');
const FILE_STORE_ENV = { DSH_HUB_CLIENT_CREDENTIAL_STORE: 'file' };

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhub-m2-'));
  const cfgDir = path.join(work, 'cfg');
  const dbPath = path.join(work, 'hub.db');
  const backupPath = path.join(work, 'hub.backup.db');
  fs.mkdirSync(cfgDir, { recursive: true });

  const hubPort = await freePort();
  const mockPort = await freePort();
  const base = `http://127.0.0.1:${hubPort}`;
  const children = [];
  const killAll = () => {
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* noop */ }
    }
  };
  process.on('exit', killAll);

  try {
    const serviceEnv = {
      DEV_AUTH_USER: 'm2-owner',
      PUBLIC_PORT: String(hubPort),
      TOKEN_PEPPER_KEYRING: JSON.stringify({ m2: randomBytes(32).toString('base64url') }),
      CURRENT_TOKEN_PEPPER_KEY_ID: 'm2',
      IDEMPOTENCY_ENCRYPTION_KEYRING: JSON.stringify({ m2: randomBytes(32).toString('base64url') }),
      CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'm2',
      DSH_HUB_CLIENT_CREDENTIAL_STORE: 'file',
    };

    children.push(spawnNode(MOCK_BIN, [String(mockPort)], {}, path.join(work, 'mock.log')));
    children.push(spawnNode(SERVICE_BIN, ['--port', String(hubPort), '--db', dbPath], serviceEnv, path.join(work, 'service.log')));
    await waitFor(async () => (await fetch(`${base}/healthz`).catch(() => null))?.ok === true, 10_000, 'hub service');

    const portalForCsrf = await api(base, '/api/portal');
    const ns = await api(base, '/api/namespaces', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        'x-csrf-token': portalForCsrf.csrfToken,
      },
      body: JSON.stringify({ name: 'm2-compat' }),
    });
    check('namespace created for M2 evidence', ns.registryKey?.startsWith('dhk_'));

    const join = spawnSyncCapture(CLIENT_BIN, [
      'join',
      '--endpoint', base,
      '--registry-key', ns.registryKey,
      '--target', `127.0.0.1:${mockPort}`,
      '--config-dir', cfgDir,
    ], FILE_STORE_ENV);
    check('agent join succeeds', join.code === 0, join.out);
    const instanceId = join.out.match(/joined as instance (\S+)/)?.[1];
    check('agent join returns instance id', /^inst-[a-z2-7]{26}$/.test(instanceId ?? ''), join.out);

    children.push(spawnNode(CLIENT_BIN, ['run', '--config-dir', cfgDir], FILE_STORE_ENV, path.join(work, 'client.log')));
    await waitFor(async () => {
      const portal = await api(base, '/api/portal');
      return portal.instances.some((item) => item.instanceId === instanceId && item.connectionState === 'online');
    }, 15_000, 'instance online');

    const localDiag = spawnSyncCapture(CLIENT_BIN, [
      'diagnose',
      '--target', `127.0.0.1:${mockPort}`,
      '--json',
      '--config-dir', cfgDir,
    ], FILE_STORE_ENV);
    check('agent diagnose exits 0', localDiag.code === 0, localDiag.out);
    const parsedDiag = JSON.parse(localDiag.out);
    check('diagnose counts sessions/workspaces/unlinked sessions',
      parsedDiag.api.sessionList.itemCount === 3
        && parsedDiag.api.workspaceList.itemCount === 2
        && parsedDiag.workspaceMapping.linkedSessionCount === 2
        && parsedDiag.workspaceMapping.unlinkedSessionCount === 1
        && parsedDiag.workspaceMapping.staleWorkspaceSessionCount === 1,
      JSON.stringify(parsedDiag.workspaceMapping));
    check('diagnose records events.mux active and events.host idle-open',
      parsedDiag.websocket.eventsMux.opened
        && parsedDiag.websocket.eventsMux.messages > 0
        && parsedDiag.websocket.eventsHost.opened
        && parsedDiag.websocket.eventsHost.idle,
      JSON.stringify(parsedDiag.websocket));

    const instanceBase = `http://${instanceId}.localhost:${hubPort}`;
    const directSessions = await dshRpc(`http://127.0.0.1:${mockPort}`, 'session.list');
    const hubSessions = await dshRpc(instanceBase, 'session.list', { origin: instanceBase });
    const directWorkspaces = await dshRpc(`http://127.0.0.1:${mockPort}`, 'workspace.list');
    const hubWorkspaces = await dshRpc(instanceBase, 'workspace.list', { origin: instanceBase });
    check('direct and relayed session.list counts match', directSessions.itemCount === 3 && hubSessions.itemCount === directSessions.itemCount);
    check('direct and relayed workspace.list counts match', directWorkspaces.itemCount === 2 && hubWorkspaces.itemCount === directWorkspaces.itemCount);

    const mux = await wsProbe(`${instanceBase.replace(/^http/, 'ws')}/api/events.mux`, { origin: instanceBase, expectMessage: true });
    const host = await wsProbe(`${instanceBase.replace(/^http/, 'ws')}/api/events.host`, { origin: instanceBase, expectMessage: false });
    check('relayed events.mux opens and emits', mux.opened && mux.messages > 0, JSON.stringify(mux));
    check('relayed events.host opens idle', host.opened && host.idle, JSON.stringify(host));

    const allowedTls = await api(base, `/api/tls/ask?domain=${encodeURIComponent(`${instanceId}.localhost`)}`);
    const deniedTls = await fetch(`${base}/api/tls/ask?domain=${encodeURIComponent('inst-aaaaaaaaaaaaaaaaaaaaaaaaaa.localhost')}`);
    check('TLS ask allows registered instance domain', allowedTls.ok === true);
    check('TLS ask rejects unknown instance domain', deniedTls.status === 403, `status=${deniedTls.status}`);

    const db = new Database(dbPath);
    db.prepare('VACUUM INTO ?').run(backupPath);
    db.close();
    fs.chmodSync(backupPath, 0o600);
    const restored = new Database(backupPath, { readonly: true, fileMustExist: true });
    const restoredInstance = restored.prepare('SELECT id, state FROM instances WHERE id = ?').get(instanceId);
    const restoredNamespace = restored.prepare('SELECT id FROM namespaces WHERE id = ?').get(ns.namespaceId);
    restored.close();
    check('SQLite backup is readable and preserves namespace/instance',
      restoredNamespace?.id === ns.namespaceId && restoredInstance?.id === instanceId && restoredInstance?.state === 'active');
    check('SQLite backup file is 0600', (fs.statSync(backupPath).mode & 0o777) === 0o600);

    console.log(`\nM2 compatibility evidence: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  } catch (err) {
    console.error('M2 compatibility matrix failed:', err);
    console.log(`result: ${pass} passed, ${fail + 1} failed`);
    process.exit(1);
  } finally {
    killAll();
  }
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

async function api(base, url, opts = {}) {
  const request = { ...opts, headers: { ...(opts.headers ?? {}) } };
  const method = String(request.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !request.headers['idempotency-key']) {
    request.headers['idempotency-key'] = `m2_${randomBytes(18).toString('base64url')}`;
  }
  const res = await fetch(base + url, request);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function dshRpc(base, method, { origin = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.origin = origin;
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'client-request', rpcId: `m2-${method}`, method, payload: {} }),
    signal: AbortSignal.timeout(6_000),
  });
  const parsed = await res.json().catch(() => null);
  return {
    status: res.status,
    ok: parsed?.result?.ok === true,
    itemCount: Array.isArray(parsed?.result?.value?.items) ? parsed.result.value.items.length : null,
  };
}

function wsProbe(url, { origin = null, expectMessage = false } = {}) {
  return new Promise((resolve) => {
    const result = { opened: false, messages: 0, firstBytes: 0, idle: false, error: null };
    let settled = false;
    const socket = new WebSocket(url, { headers: origin ? { origin } : {} });
    const settle = () => {
      if (settled) return;
      settled = true;
      result.idle = result.opened && result.messages === 0;
      try { socket.close(); } catch { /* noop */ }
      resolve(result);
    };
    const timeout = setTimeout(settle, expectMessage ? 5_000 : 2_500);
    socket.on('open', () => { result.opened = true; });
    socket.on('message', (data) => {
      result.messages += 1;
      if (!result.firstBytes) result.firstBytes = Buffer.byteLength(data);
      if (expectMessage) {
        clearTimeout(timeout);
        settle();
      }
    });
    socket.on('error', (err) => {
      result.error = err.message;
      clearTimeout(timeout);
      settle();
    });
  });
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
