import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import vm from 'node:vm';
import { once } from 'node:events';
import test from 'node:test';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

import { HubServer } from '../src/server.js';
import { portalHtml } from '../src/portal.js';
import { portalApiScript } from '../src/portal-api.js';
import { portalStyles } from '../src/portal-styles.js';
import { portalUiScript } from '../src/portal-ui.js';
import {
  addNamespaceMembership,
  createNamespace,
  ensureHubUser,
  getNamespaceRole,
  registerInstance,
} from '../src/db.js';
import { DEFAULT_LIMITS, PROTO_MINOR, REQUIRED_CAPABILITIES } from '../src/protocol.js';
import { makeInstallationId } from '../src/security.js';
import { securityOptions, tempDatabase } from './test-helpers.js';

const SERVICE_PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

async function startHub(t, overrides = {}) {
  const { dbPath } = tempDatabase(t, 'dshhub-server-');
  const hub = new HubServer({
    host: '127.0.0.1',
    port: 0,
    dbPath,
    baseDomain: 'localhost',
    inactiveMs: 60_000,
    devAuthUser: 'owner',
    ...securityOptions(),
    ...overrides,
  });
  hub.listen();
  await once(hub.http, 'listening');
  const port = hub.http.address().port;
  t.after(() => hub.close());
  return { hub, baseUrl: `http://127.0.0.1:${port}` };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(check, message) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function jsonRequest(baseUrl, pathname, {
  method = 'GET',
  body,
  idempotencyKey,
  headers = {},
  host,
} = {}) {
  const finalHeaders = { ...headers };
  if (needsPortalCsrf(pathname, method, finalHeaders)) {
    const portal = await jsonRequest(baseUrl, '/api/portal', { host, headers });
    finalHeaders['x-csrf-token'] = portal.body.csrfToken;
    finalHeaders.origin = host ? `http://${host}` : baseUrl;
    if (!idempotencyKey) finalHeaders['idempotency-key'] = `test-${cryptoRandomId()}`;
  }
  if (host) finalHeaders.host = host;
  if (body !== undefined) finalHeaders['content-type'] = 'application/json';
  if (idempotencyKey) finalHeaders['idempotency-key'] = idempotencyKey;
  if (!host) {
    const response = await fetch(baseUrl + pathname, {
      method,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => null);
    return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) };
  }
  return rawHttpRequest(baseUrl, pathname, {
    method,
    headers: finalHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let testRequestSequence = 0;
function cryptoRandomId() {
  testRequestSequence += 1;
  return `${process.pid}-${Date.now()}-${testRequestSequence}`.padEnd(24, '0');
}

function needsPortalCsrf(pathname, method, headers) {
  if (!['POST', 'PATCH', 'DELETE'].includes(String(method).toUpperCase())) return false;
  if (headers.authorization || headers.Authorization) return false;
  if (headers['x-csrf-token'] || headers['X-CSRF-Token']) return false;
  return pathname === '/api/namespaces'
    || /^\/api\/(?:system\/)?users\/[^/]+\/(?:disable|restore)$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+\/members$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+\/members\/[^/]+$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+\/invites$/.test(pathname)
    || /^\/api\/invites\/[^/]+\/revoke$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+\/registry-key\/reveal$/.test(pathname)
    || /^\/api\/namespaces\/[^/]+\/rotate$/.test(pathname)
    || /^\/api\/instances\/[^/]+\/revoke$/.test(pathname)
    || /^\/api\/instances\/[^/]+\/recover$/.test(pathname)
    || /^\/api\/instances\/[^/]+\/replacement-grants$/.test(pathname);
}

async function assertPortalWriteSecurity(baseUrl, pathname, { body, idempotencyKey }) {
  const rawBody = JSON.stringify(body);
  const missingOrigin = await rawHttpRequest(baseUrl, pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': `${idempotencyKey}-missing-origin` } : {}),
    },
    body: rawBody,
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.error.code, 'FORBIDDEN_ORIGIN');

  const portal = await jsonRequest(baseUrl, '/api/portal');
  const badOrigin = await rawHttpRequest(baseUrl, pathname, {
    method: 'POST',
    headers: {
      origin: 'http://evil.example',
      'x-csrf-token': portal.body.csrfToken,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': `${idempotencyKey}-bad-origin` } : {}),
    },
    body: rawBody,
  });
  assert.equal(badOrigin.status, 403);
  assert.equal(badOrigin.body.error.code, 'FORBIDDEN_ORIGIN');

  const missingCsrf = await rawHttpRequest(baseUrl, pathname, {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': `${idempotencyKey}-missing-csrf` } : {}),
    },
    body: rawBody,
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal(missingCsrf.body.error.code, 'CSRF_INVALID');
}

function rawHttpRequest(baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: pathname,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          body: raw ? JSON.parse(raw) : null,
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rawTextRequest(baseUrl, pathname, { method = 'GET', headers = {}, body } = {}) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path: pathname,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rawTcpRequest(baseUrl, rawRequest) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const socket = net.connect({ host: base.hostname, port: Number(base.port) }, () => {
      socket.write(rawRequest);
    });
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    socket.on('close', () => finish(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    socket.setTimeout(2000, () => {
      socket.destroy(new Error('socket timeout'));
    });
  });
}

function splitHosts() {
  return {
    portalHost: 'hub.localhost',
    controlHost: 'control.localhost',
    instanceBaseDomain: 'instances.localhost',
    publicScheme: 'http',
    publicPort: null,
  };
}

async function createJoinedInstance(baseUrl, { idSuffix = '001', installationId = makeInstallationId() } = {}) {
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: `namespace-create-${idSuffix}`.padEnd(32, '0'),
    body: { name: `team-${idSuffix}` },
  });
  assert.equal(namespace.status, 201);
  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: `register-${idSuffix}`.padEnd(32, '0'),
    body: {
      registryKey: namespace.body.registryKey,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(joined.status, 201);
  return { namespace: namespace.body, joined: joined.body, installationId };
}

test('G2 多用户权限按 namespace role 生效且 viewer 不能打开实例', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, instanceBaseDomain: 'instances.localhost' });
  const ownerHeaders = { 'remote-user': 'owner' };
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: ownerHeaders,
    idempotencyKey: 'g2-namespace-authz-00000001',
    body: { name: 'g2-authz' },
  });
  assert.equal(namespace.status, 201);
  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'g2-register-authz-000000001',
    body: {
      registryKey: namespace.body.registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(joined.status, 201);
  ensureHubUser(hub.db, { username: 'viewer1' });
  ensureHubUser(hub.db, { username: 'member1' });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.body.namespaceId,
    userId: 'viewer1',
    role: 'viewer',
    createdBy: 'owner',
  });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.body.namespaceId,
    userId: 'member1',
    role: 'member',
    createdBy: 'owner',
  });

  const viewerInstances = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'viewer1' } });
  assert.equal(viewerInstances.status, 200);
  assert.equal(viewerInstances.body.instances[0].role, 'viewer');
  assert.equal(viewerInstances.body.instances[0].canOpen, false);
  const viewerMembers = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/members`, {
    headers: { 'remote-user': 'viewer1' },
  });
  assert.equal(viewerMembers.status, 404);
  const memberInvites = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/invites`, {
    headers: { 'remote-user': 'member1' },
  });
  assert.equal(memberInvites.status, 404);

  const instanceHost = `${joined.body.instanceId}.instances.localhost`;
  const viewerOpen = await rawHttpRequest(baseUrl, '/', {
    headers: {
      host: instanceHost,
      origin: `http://${instanceHost}`,
      'sec-fetch-site': 'same-origin',
      'remote-user': 'viewer1',
    },
  });
  assert.equal(viewerOpen.status, 403);

  const memberOpen = await rawHttpRequest(baseUrl, '/', {
    headers: {
      host: instanceHost,
      origin: `http://${instanceHost}`,
      'sec-fetch-site': 'same-origin',
      'remote-user': 'member1',
    },
  });
  assert.equal(memberOpen.status, 503);

  const viewerUpgrade = await rawTcpRequest(baseUrl, [
    'GET /events.mux HTTP/1.1',
    `Host: ${instanceHost}`,
    `Origin: http://${instanceHost}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Remote-User: viewer1',
    '',
    '',
  ].join('\r\n'));
  assert.match(viewerUpgrade, /^HTTP\/1\.1 403 Forbidden/);

  const memberUpgrade = await rawTcpRequest(baseUrl, [
    'GET /events.mux HTTP/1.1',
    `Host: ${instanceHost}`,
    `Origin: http://${instanceHost}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'Remote-User: member1',
    '',
    '',
  ].join('\r\n'));
  assert.match(memberUpgrade, /^HTTP\/1\.1 503 Service Unavailable/);
});

test('G2 邀请注册使用 PoW 并创建 LLDAP/mock 用户和成员关系', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    invitePowDifficulty: 0,
  });
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g2-invite-namespace-0000001',
    body: { name: 'g2-invite' },
  });
  assert.equal(namespace.status, 201);
  const inviteCreateKey = 'g2-invite-create-idempotent01';
  const created = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/invites`, {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: inviteCreateKey,
    body: { role: 'member', emailHint: 'alice@example.com' },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.invite.token, /^dhi_[A-Za-z0-9_-]{32}$/);
  const replayed = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/invites`, {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: inviteCreateKey,
    body: { role: 'member', emailHint: 'alice@example.com' },
  });
  assert.equal(replayed.status, 201);
  assert.deepEqual(replayed.body, created.body);

  const summary = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/summary`);
  assert.equal(summary.status, 200);
  assert.equal(summary.body.invite.namespaceName, 'g2-invite');

  const badPow = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/consume`, {
    method: 'POST',
    body: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'StrongPassword-123!',
      powChallengeId: 'pow_missing',
      powNonce: '0',
    },
  });
  assert.equal(badPow.status, 400);
  assert.equal(badPow.body.error.code, 'POW_INVALID');

  const challenge = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/pow`, { method: 'POST', body: {} });
  assert.equal(challenge.status, 201);
  const consumed = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/consume`, {
    method: 'POST',
    body: {
      username: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      password: 'StrongPassword-123!',
      powChallengeId: challenge.body.challenge.id,
      powNonce: '0',
    },
  });
  assert.equal(consumed.status, 201);
  assert.equal(consumed.body.user.username, 'alice');
  assert.equal(getNamespaceRole(hub.db, 'alice', namespace.body.namespaceId), 'member');

  const reused = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/summary`);
  assert.equal(reused.status, 404);
});

test('G2 邀请消费在用户名无效时不会触碰 LLDAP', async (t) => {
  const calls = [];
  const { baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapClient: {
      async createUserWithPasswordAndGroup() { calls.push('create'); },
      async addUserToAdmissionGroup() {},
      async removeUserFromAdmissionGroup() {},
    },
    invitePowDifficulty: 0,
  });
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g2-invite-bad-user-namespace',
    body: { name: 'g2-bad-user' },
  });
  assert.equal(namespace.status, 201);
  const created = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/invites`, {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    body: { role: 'member', emailHint: '' },
  });
  const challenge = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/pow`, { method: 'POST', body: {} });
  const consumed = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/consume`, {
    method: 'POST',
    body: {
      username: 'a',
      email: '',
      displayName: 'A',
      password: 'StrongPassword-123!',
      powChallengeId: challenge.body.challenge.id,
      powNonce: '0',
    },
  });
  assert.equal(consumed.status, 400);
  assert.equal(consumed.body.error.code, 'BAD_USERNAME');
  assert.deepEqual(calls, []);
});

test('G2 邀请消费遇到 LLDAP 临时失败后可重新消费', async (t) => {
  let fail = true;
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapClient: {
      async createUserWithPasswordAndGroup() {
        if (fail) {
          const error = new Error('timeout');
          error.code = 'LLDAP_TIMEOUT';
          throw error;
        }
      },
      async addUserToAdmissionGroup() {},
      async removeUserFromAdmissionGroup() {},
    },
    invitePowDifficulty: 0,
  });
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g2-invite-retry-namespace',
    body: { name: 'g2-invite-retry' },
  });
  assert.equal(namespace.status, 201);
  const created = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/invites`, {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    body: { role: 'member', emailHint: '' },
  });
  const firstChallenge = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/pow`, { method: 'POST', body: {} });
  const failed = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/consume`, {
    method: 'POST',
    body: {
      username: 'retry-user',
      email: '',
      displayName: 'Retry User',
      password: 'StrongPassword-123!',
      powChallengeId: firstChallenge.body.challenge.id,
      powNonce: '0',
    },
  });
  assert.equal(failed.status, 404);
  assert.equal(hub.db.prepare('SELECT status FROM invites WHERE id=?').get(created.body.invite.inviteId).status, 'failed_retryable');

  fail = false;
  const secondChallenge = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/pow`, { method: 'POST', body: {} });
  const consumed = await jsonRequest(baseUrl, `/api/invites/${created.body.invite.token}/consume`, {
    method: 'POST',
    body: {
      username: 'retry-user',
      email: '',
      displayName: 'Retry User',
      password: 'StrongPassword-123!',
      powChallengeId: secondChallenge.body.challenge.id,
      powNonce: '0',
    },
  });
  assert.equal(consumed.status, 201);
  assert.equal(getNamespaceRole(hub.db, 'retry-user', namespace.body.namespaceId), 'member');
});

test('G2 系统管理员可以禁用和恢复用户，禁用用户不能继续访问 Portal', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapMode: 'mock' });
  ensureHubUser(hub.db, { username: 'bob' });

  const cannotDisableLastAdmin = await jsonRequest(baseUrl, '/api/system/users/owner/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    body: { reason: 'self lockout guard' },
  });
  assert.equal(cannotDisableLastAdmin.status, 409);
  assert.equal(cannotDisableLastAdmin.body.error.code, 'LAST_SYSTEM_ADMIN');

  const bobBefore = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'bob' } });
  assert.equal(bobBefore.status, 200);

  const detail = await jsonRequest(baseUrl, '/api/users/bob', { headers: { 'remote-user': 'owner' } });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.user.username, 'bob');

  const disabled = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    body: { reason: 'test disable' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.user.status, 'disabled');

  const bobAfter = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'bob' } });
  assert.equal(bobAfter.status, 401);

  const restored = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    body: { reason: 'test restore' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.user.status, 'active');

  const bobRestored = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'bob' } });
  assert.equal(bobRestored.status, 200);
});

test('G2 用户禁用和恢复使用持久幂等结果，重放不会重复同步 LLDAP', async (t) => {
  const calls = { add: 0, remove: 0 };
  const lldapClient = {
    async addUserToAdmissionGroup() { calls.add += 1; },
    async removeUserFromAdmissionGroup() { calls.remove += 1; },
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'bob' });

  const disableKey = 'disable-user-idempotent-000001';
  const disabled = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: disableKey,
    body: { reason: 'test disable' },
  });
  const disabledReplay = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: disableKey,
    body: { reason: 'test disable' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabledReplay.status, 200);
  assert.deepEqual(disabledReplay.body, disabled.body);
  assert.equal(calls.remove, 1);

  const restoreKey = 'restore-user-idempotent-000001';
  const restored = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: restoreKey,
    body: { reason: 'test restore' },
  });
  const restoredReplay = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: restoreKey,
    body: { reason: 'test restore' },
  });
  assert.equal(restored.status, 200);
  assert.equal(restoredReplay.status, 200);
  assert.deepEqual(restoredReplay.body, restored.body);
  assert.equal(calls.add, 1);

  const conflict = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: restoreKey,
    body: { reason: 'different reason' },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('G2 disable 记录 LLDAP partial failure 后仍完成本地幂等响应', async (t) => {
  const calls = { remove: 0 };
  const lldapClient = {
    async addUserToAdmissionGroup() {},
    async removeUserFromAdmissionGroup() {
      calls.remove += 1;
      throw new Error('sync failed');
    },
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'bob' });

  const key = 'disable-partial-idempotent-001';
  const disabled = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: key,
    body: { reason: 'test partial' },
  });
  const replay = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: key,
    body: { reason: 'test partial' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.groupSync, 'failed_needs_admin');
  assert.equal(replay.body.groupSync, 'failed_needs_admin');
  assert.equal(calls.remove, 1);
  assert.equal(hub.db.prepare("SELECT status FROM users WHERE id='bob'").get().status, 'disabled');
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='user.disable' AND result='partial_failure'").get().n, 1);
});

test('G2 restore LLDAP 失败会清除 pending 并允许同 key 重试', async (t) => {
  let addCalls = 0;
  const lldapClient = {
    async addUserToAdmissionGroup() {
      addCalls += 1;
      if (addCalls === 1) throw new Error('sync failed');
    },
    async removeUserFromAdmissionGroup() {},
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'bob' });
  hub.db.prepare("UPDATE users SET status='disabled' WHERE id='bob'").run();

  const key = 'restore-retry-idempotent-0001';
  const failed = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: key,
    body: { reason: 'test retry' },
  });
  const retried = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: key,
    body: { reason: 'test retry' },
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, 'LLDAP_GROUP_SYNC_FAILED');
  assert.equal(retried.status, 200);
  assert.equal(retried.body.user.status, 'active');
  assert.equal(addCalls, 2);
});

test('G2 用户状态变更全局串行，两个管理员互相 disable 不会留下 0 个 active admin', async (t) => {
  const admissionUsers = new Set(['owner', 'alice']);
  const gates = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const lldapClient = {
    async addUserToAdmissionGroup(username) {
      admissionUsers.add(username);
    },
    async removeUserFromAdmissionGroup(username) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred();
      gates.push({ username, gate });
      await gate.promise;
      admissionUsers.delete(username);
      inFlight -= 1;
    },
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'alice' });
  hub.db.prepare('INSERT INTO system_admins (user_id, created_at, created_by, reason) VALUES (?,?,?,?)')
    .run('alice', Date.now(), 'owner', 'test concurrent admin');

  const ownerDisablesAlice = jsonRequest(baseUrl, '/api/users/alice/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'disable-alice-concurrent-001',
    body: { reason: 'concurrent guard' },
  });
  const aliceDisablesOwner = jsonRequest(baseUrl, '/api/users/owner/disable', {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: 'disable-owner-concurrent-001',
    body: { reason: 'concurrent guard' },
  });
  await waitUntil(() => gates.length === 1, 'first LLDAP remove should be waiting');
  assert.equal(maxInFlight, 1);
  gates[0].gate.resolve();

  const responses = await Promise.all([ownerDisablesAlice, aliceDisablesOwner]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 401]);
  const activeAdmins = hub.db.prepare(`
    SELECT u.username FROM users u
      JOIN system_admins s ON s.user_id = u.id
     WHERE u.status='active'
     ORDER BY u.username
  `).all().map((row) => row.username);
  assert.equal(activeAdmins.length, 1);
  assert.equal(admissionUsers.has(activeAdmins[0]), true);
});

test('G2 用户 disable 和 restore 串行后不会让相反操作与 LLDAP 状态交叉', async (t) => {
  const admissionUsers = new Set(['owner', 'bob']);
  const gates = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const lldapClient = {
    async addUserToAdmissionGroup(username) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      admissionUsers.add(username);
      inFlight -= 1;
    },
    async removeUserFromAdmissionGroup(username) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred();
      gates.push({ username, gate });
      await gate.promise;
      admissionUsers.delete(username);
      inFlight -= 1;
    },
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'bob' });

  const disable = jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'disable-bob-opposing-00001',
    body: { reason: 'disable first' },
  });
  await waitUntil(() => gates.length === 1, 'disable LLDAP remove should be waiting');
  const restore = jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'restore-bob-opposing-00001',
    body: { reason: 'restore second' },
  });
  gates[0].gate.resolve();

  const responses = await Promise.all([disable, restore]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(maxInFlight, 1);
  assert.equal(hub.db.prepare("SELECT status FROM users WHERE id='bob'").get().status, 'active');
  assert.equal(admissionUsers.has('bob'), true);
});

test('G2 用户状态 complete 失败会清 pending 并按真实状态转换补偿 LLDAP', async (t) => {
  const admissionUsers = new Set(['owner', 'bob', 'carol']);
  const calls = { add: 0, remove: 0 };
  const lldapClient = {
    async addUserToAdmissionGroup(username) {
      calls.add += 1;
      admissionUsers.add(username);
    },
    async removeUserFromAdmissionGroup(username) {
      calls.remove += 1;
      admissionUsers.delete(username);
    },
  };
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapClient });
  ensureHubUser(hub.db, { username: 'bob' });
  ensureHubUser(hub.db, { username: 'carol' });
  hub.db.prepare("UPDATE users SET status='disabled' WHERE id='carol'").run();
  admissionUsers.delete('carol');

  hub.db.exec(`
    CREATE TRIGGER fail_disable_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action='user.disable' AND NEW.result='success'
    BEGIN
      SELECT RAISE(ABORT, 'disable audit blocked');
    END;
  `);
  const failedDisable = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'disable-complete-fail-00001',
    body: { reason: 'trigger rollback' },
  });
  assert.equal(failedDisable.status, 500);
  assert.equal(hub.db.prepare("SELECT status FROM users WHERE id='bob'").get().status, 'active');
  assert.equal(admissionUsers.has('bob'), true);
  assert.equal(calls.remove, 1);
  assert.equal(calls.add, 1);
  assert.equal(hub.db.prepare('SELECT count(*) AS n FROM idempotency_records').get().n, 0);

  const alreadyDisabled = await jsonRequest(baseUrl, '/api/users/carol/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'disable-already-fail-000001',
    body: { reason: 'already disabled rollback' },
  });
  assert.equal(alreadyDisabled.status, 500);
  assert.equal(admissionUsers.has('carol'), false);
  assert.equal(calls.add, 1);
  hub.db.exec('DROP TRIGGER fail_disable_audit');

  const retriedDisable = await jsonRequest(baseUrl, '/api/users/bob/disable', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'disable-complete-fail-00001',
    body: { reason: 'trigger rollback' },
  });
  assert.equal(retriedDisable.status, 200);
  assert.equal(retriedDisable.body.user.status, 'disabled');
  assert.equal(admissionUsers.has('bob'), false);

  hub.db.exec(`
    CREATE TRIGGER fail_restore_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action='user.restore' AND NEW.result='success'
    BEGIN
      SELECT RAISE(ABORT, 'restore audit blocked');
    END;
  `);
  const failedRestore = await jsonRequest(baseUrl, '/api/users/bob/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'restore-complete-fail-00001',
    body: { reason: 'restore rollback' },
  });
  assert.equal(failedRestore.status, 500);
  assert.equal(hub.db.prepare("SELECT status FROM users WHERE id='bob'").get().status, 'disabled');
  assert.equal(admissionUsers.has('bob'), false);
  assert.equal(calls.add, 2);
  assert.equal(calls.remove, 4);
  assert.equal(hub.db.prepare('SELECT count(*) AS n FROM idempotency_records WHERE status_code=0').get().n, 0);

  const alreadyActive = await jsonRequest(baseUrl, '/api/users/owner/restore', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'restore-already-fail-000001',
    body: { reason: 'already active rollback' },
  });
  assert.equal(alreadyActive.status, 500);
  assert.equal(admissionUsers.has('owner'), true);
  assert.equal(calls.remove, 4);
});

test('G2 系统管理员可查看全局审计，普通用户不可查看', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapMode: 'mock' });
  ensureHubUser(hub.db, { username: 'member2' });
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g2-global-audit-namespace01',
    body: { name: 'g2-global-audit' },
  });
  assert.equal(namespace.status, 201);
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.body.namespaceId,
    userId: 'member2',
    role: 'member',
    createdBy: 'owner',
  });

  const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
  assert.equal(denied.status, 403);
  const audit = await jsonRequest(baseUrl, '/api/audit?limit=100', { headers: { 'remote-user': 'owner' } });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some((item) => item.action === 'namespace.create'));
  const deniedEvent = audit.body.items.find((item) => item.action === 'audit.view_global' && item.result === 'denied');
  assert.ok(deniedEvent);
  assert.match(deniedEvent.requestId, /^req_/);
  assert.equal(deniedEvent.details.clientIpSummary.length, 16);
  assert.equal(deniedEvent.details.userAgentSummary.length, 16);
});

test('重复权限拒绝审计在窗口内聚合，强审计不受影响', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 60_000,
  });
  ensureHubUser(hub.db, { username: 'member2' });

  for (let i = 0; i < 3; i++) {
    const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
    assert.equal(denied.status, 403);
  }

  const auditRows = hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.view_global' AND result='denied'
  `).all();
  assert.equal(auditRows.length, 1);
  assert.equal(JSON.parse(auditRows[0].details).auditAggregation.windowMs, 60_000);

  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'must-audit-after-denied-0001',
    body: { name: 'must-audit-after-denied' },
  });
  assert.equal(namespace.status, 201);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='namespace.create' AND result='success'").get().n, 1);

  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(metrics.body, /^dsh_hub_audit_suppressed_total\{action="audit_view_global"\} 2$/m);
});

test('重复权限拒绝审计首条落库失败时不会占用聚合桶，下一次可重新落库', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 60_000,
  });
  ensureHubUser(hub.db, { username: 'member2' });
  hub.db.exec(`
    CREATE TRIGGER fail_denied_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action='audit.view_global' AND NEW.result='denied'
    BEGIN
      SELECT RAISE(ABORT, 'denied audit blocked');
    END;
  `);

  const first = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
  assert.equal(first.status, 403);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='audit.view_global'").get().n, 0);
  hub.db.exec('DROP TRIGGER fail_denied_audit');

  const second = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
  assert.equal(second.status, 403);
  assert.equal(hub.db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='audit.view_global' AND result='denied'").get().n, 1);
});

test('重复权限拒绝审计窗口结束时会 flush 被抑制数量摘要', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 10_000,
  });
  ensureHubUser(hub.db, { username: 'member2' });

  for (let i = 0; i < 3; i += 1) {
    const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
    assert.equal(denied.status, 403);
  }
  assert.equal(hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n, 0);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterWindow = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member2' } });
  assert.equal(afterWindow.status, 403);

  const auditRows = hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.view_global' AND result='denied'
     ORDER BY time, id
  `).all();
  assert.equal(auditRows.length, 3);
  const flushed = auditRows.map((row) => JSON.parse(row.details).auditAggregation)
    .find((aggregation) => aggregation?.flushReason === 'expired');
  assert.ok(flushed);
  assert.equal(flushed.suppressedCount, 2);
  assert.equal(Number.isSafeInteger(flushed.firstTime), true);
  assert.equal(Number.isSafeInteger(flushed.lastTime), true);
});

test('重复权限拒绝审计定时器会在无后续安全事件时 flush 摘要', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 10,
  });
  ensureHubUser(hub.db, { username: 'member-timer' });

  for (let i = 0; i < 3; i += 1) {
    const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-timer' } });
    assert.equal(denied.status, 403);
  }

  await waitUntil(() => hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n === 1, 'audit coalesce timer should flush expired suppressed summary');

  const auditRows = hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.view_global' AND result='denied'
     ORDER BY time, id
  `).all();
  assert.equal(auditRows.length, 2);
  const flushed = auditRows.map((row) => JSON.parse(row.details).auditAggregation)
    .find((aggregation) => aggregation?.flushReason === 'expired');
  assert.equal(flushed.suppressedCount, 2);
});

test('过期审计聚合桶由其他请求触发 flush 时不借用当前请求上下文', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 10_000,
  });
  ensureHubUser(hub.db, { username: 'member-a' });
  ensureHubUser(hub.db, { username: 'member-b' });

  const headersA = { 'remote-user': 'member-a', 'x-request-id': 'req-a', 'user-agent': 'Agent-A' };
  const headersB = { 'remote-user': 'member-b', 'x-request-id': 'req-b', 'user-agent': 'Agent-B' };
  const firstA = await jsonRequest(baseUrl, '/api/system/audit', { headers: headersA });
  assert.equal(firstA.status, 403);
  const secondA = await jsonRequest(baseUrl, '/api/system/audit', { headers: headersA });
  assert.equal(secondA.status, 403);
  const initialA = hub.db.prepare(`
    SELECT actor_id, request_id, details FROM audit_events
     WHERE action='audit.view_global' AND result='denied'
     ORDER BY time, id
     LIMIT 1
  `).get();
  const initialADetails = JSON.parse(initialA.details);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const triggerB = await jsonRequest(baseUrl, '/api/system/audit', { headers: headersB });
  assert.equal(triggerB.status, 403);

  const flushed = hub.db.prepare(`
    SELECT actor_id, request_id, details FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
     ORDER BY time, id
     LIMIT 1
  `).get();
  assert.equal(flushed.actor_id, 'member-a');
  assert.equal(flushed.request_id, 'req-a');
  const flushedDetails = JSON.parse(flushed.details);
  assert.equal(flushedDetails.userAgentSummary, initialADetails.userAgentSummary);
  assert.equal(flushedDetails.auditAggregation.suppressedCount, 1);

  const latestB = hub.db.prepare(`
    SELECT request_id, details FROM audit_events
     WHERE actor_id='member-b' AND action='audit.view_global' AND result='denied'
     ORDER BY time DESC, id DESC
     LIMIT 1
  `).get();
  assert.equal(latestB.request_id, 'req-b');
  assert.notEqual(JSON.parse(latestB.details).userAgentSummary, flushedDetails.userAgentSummary);
});

test('审计聚合过期 flush 使用固定 batch 上限，避免单次 sweep 无界写入', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 1000,
    auditCoalesceFlushIntervalMs: 10_000,
    auditCoalesceFlushBatchSize: 2,
  });
  for (let i = 0; i < 5; i += 1) {
    const username = `member-batch-${i}`;
    ensureHubUser(hub.db, { username });
    const first = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': username } });
    assert.equal(first.status, 403);
    const second = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': username } });
    assert.equal(second.status, 403);
  }

  assert.equal(hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n, 0);

  await new Promise((resolve) => setTimeout(resolve, 1050));
  ensureHubUser(hub.db, { username: 'member-batch-trigger' });
  const trigger = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-batch-trigger' } });
  assert.equal(trigger.status, 403);

  const flushedCount = hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n;
  assert.equal(flushedCount, 2);
});

test('审计聚合 flush 失败保留桶并在下一 tick 重试', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 10,
    auditCoalesceFlushRetryMs: 20,
    auditCoalesceFlushMaxRetryMs: 80,
    auditCoalesceFlushJitterMs: 0,
  });
  ensureHubUser(hub.db, { username: 'member-retry' });

  for (let i = 0; i < 3; i += 1) {
    const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-retry' } });
    assert.equal(denied.status, 403);
  }
  hub.db.exec(`
    CREATE TRIGGER fail_coalesced_flush
    BEFORE INSERT ON audit_events
    WHEN NEW.action='audit.view_global'
      AND NEW.result='denied'
      AND NEW.details LIKE '%"flushReason":"expired"%'
    BEGIN
      SELECT RAISE(ABORT, 'coalesced flush blocked');
    END;
  `);

  await new Promise((resolve) => setTimeout(resolve, 130));
  assert.equal(hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n, 0);

  hub.db.exec('DROP TRIGGER fail_coalesced_flush');
  await waitUntil(() => hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n === 1, 'audit coalesce flush should retry after transient db failure');
  const flushed = JSON.parse(hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
     LIMIT 1
  `).get().details).auditAggregation;
  assert.equal(flushed.suppressedCount, 2);
  assert.ok((hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0) >= 1);
});

test('审计聚合 flush 失败退避期同 key 新事件会合并进待 flush 摘要', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 5,
    auditCoalesceFlushRetryMs: 200,
    auditCoalesceFlushMaxRetryMs: 200,
    auditCoalesceFlushJitterMs: 0,
  });
  ensureHubUser(hub.db, { username: 'member-pending-merge' });

  const first = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-pending-merge' } });
  assert.equal(first.status, 403);
  const second = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-pending-merge' } });
  assert.equal(second.status, 403);
  hub.db.exec(`
    CREATE TRIGGER fail_pending_merge_flush
    BEFORE INSERT ON audit_events
    WHEN NEW.action='audit.view_global'
      AND NEW.result='denied'
      AND NEW.details LIKE '%"flushReason":"expired"%'
    BEGIN
      SELECT RAISE(ABORT, 'pending merge flush blocked');
    END;
  `);

  await waitUntil(
    () => (hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0) >= 1,
    'audit coalesce bucket should enter retry backoff',
  );
  const beforeRetry = hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0;
  const duringBackoff = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-pending-merge' } });
  assert.equal(duringBackoff.status, 403);
  assert.equal(hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0, beforeRetry);
  hub.db.exec('DROP TRIGGER fail_pending_merge_flush');

  await waitUntil(() => hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE actor_id='member-pending-merge'
       AND action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n === 1, 'pending audit coalesce bucket should retry and flush merged events');

  const auditRows = hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE actor_id='member-pending-merge'
       AND action='audit.view_global'
       AND result='denied'
     ORDER BY time, id
  `).all();
  assert.equal(auditRows.length, 2);
  const flushed = auditRows.map((row) => JSON.parse(row.details).auditAggregation)
    .find((aggregation) => aggregation?.flushReason === 'expired');
  assert.equal(flushed.suppressedCount, 2);
});

test('审计聚合 flush 持续失败时按指数退避控制重试频率', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 5,
    auditCoalesceFlushRetryMs: 50,
    auditCoalesceFlushMaxRetryMs: 200,
    auditCoalesceFlushJitterMs: 0,
  });
  ensureHubUser(hub.db, { username: 'member-backoff' });

  const first = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-backoff' } });
  assert.equal(first.status, 403);
  const second = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-backoff' } });
  assert.equal(second.status, 403);
  hub.db.exec(`
    CREATE TRIGGER fail_backoff_flush
    BEFORE INSERT ON audit_events
    WHEN NEW.action='audit.view_global'
      AND NEW.result='denied'
      AND NEW.details LIKE '%"flushReason":"expired"%'
    BEGIN
      SELECT RAISE(ABORT, 'backoff flush blocked');
    END;
  `);

  await waitUntil(
    () => (hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0) >= 1,
    'audit coalesce flush should record the first failure',
  );
  const firstFailureCount = hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0, firstFailureCount);

  await waitUntil(
    () => (hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0) >= firstFailureCount + 1,
    'audit coalesce flush should retry after base backoff',
  );
  const secondFailureCount = hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0, secondFailureCount);
  hub.db.exec('DROP TRIGGER fail_backoff_flush');
});

test('审计聚合失败桶移到队尾，后续过期桶仍可 flush', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 5,
    auditCoalesceFlushBatchSize: 1,
    auditCoalesceFlushRetryMs: 5,
    auditCoalesceFlushMaxRetryMs: 5,
    auditCoalesceFlushJitterMs: 0,
  });
  for (const username of ['member-starve-0', 'member-starve-1']) {
    ensureHubUser(hub.db, { username });
    const first = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': username } });
    assert.equal(first.status, 403);
    const second = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': username } });
    assert.equal(second.status, 403);
  }
  hub.db.exec(`
    CREATE TRIGGER fail_first_starvation_flush
    BEFORE INSERT ON audit_events
    WHEN NEW.actor_id='member-starve-0'
      AND NEW.action='audit.view_global'
      AND NEW.result='denied'
      AND NEW.details LIKE '%"flushReason":"expired"%'
    BEGIN
      SELECT RAISE(ABORT, 'first flush blocked');
    END;
  `);

  await waitUntil(
    () => (hub.metrics.auditFlushFailures.get('audit_view_global') ?? 0) >= 1,
    'first audit coalesce bucket should fail once',
  );
  await waitUntil(() => hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE actor_id='member-starve-1'
       AND action='audit.view_global'
       AND result='denied'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n === 1, 'later audit coalesce bucket should flush despite earlier failing bucket');
  hub.db.exec('DROP TRIGGER fail_first_starvation_flush');
});

test('overflow 审计聚合 flush 失败退避期新事件会合并进待 flush 摘要', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 100,
    auditCoalesceFlushIntervalMs: 5,
    auditCoalesceFlushRetryMs: 200,
    auditCoalesceFlushMaxRetryMs: 200,
    auditCoalesceFlushJitterMs: 0,
    auditCoalesceMaxBuckets: 1,
  });
  for (const username of [
    'member-overflow-holder',
    'member-overflow-pending-0',
    'member-overflow-pending-1',
    'member-overflow-pending-2',
  ]) {
    ensureHubUser(hub.db, { username });
  }

  const holder = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-overflow-holder' } });
  assert.equal(holder.status, 403);
  const overflowFirst = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-overflow-pending-0' } });
  assert.equal(overflowFirst.status, 403);
  const overflowSecond = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': 'member-overflow-pending-1' } });
  assert.equal(overflowSecond.status, 403);
  hub.db.exec(`
    CREATE TRIGGER fail_pending_overflow_flush
    BEFORE INSERT ON audit_events
    WHEN NEW.action='audit.coalesce_overflow'
      AND NEW.result='suppressed'
      AND NEW.details LIKE '%"flushReason":"expired"%'
    BEGIN
      SELECT RAISE(ABORT, 'pending overflow flush blocked');
    END;
  `);

  await waitUntil(
    () => (hub.metrics.auditFlushFailures.get('audit_coalesce_overflow') ?? 0) >= 1,
    'overflow audit coalesce bucket should enter retry backoff',
  );
  const overflowDuringBackoff = await jsonRequest(baseUrl, '/api/system/audit', {
    headers: { 'remote-user': 'member-overflow-pending-2' },
  });
  assert.equal(overflowDuringBackoff.status, 403);
  hub.db.exec('DROP TRIGGER fail_pending_overflow_flush');

  await waitUntil(() => hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='audit.coalesce_overflow'
       AND result='suppressed'
       AND details LIKE '%"flushReason":"expired"%'
  `).get().n === 1, 'pending overflow audit coalesce bucket should retry and flush merged events');

  const flushed = JSON.parse(hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.coalesce_overflow'
       AND result='suppressed'
       AND details LIKE '%"flushReason":"expired"%'
     LIMIT 1
  `).get().details).auditAggregation;
  assert.equal(flushed.suppressedCount, 2);
  assert.equal(flushed.samples.length, 3);
  assert.deepEqual(
    flushed.samples.map((sample) => sample.actorId),
    ['member-overflow-pending-0', 'member-overflow-pending-1', 'member-overflow-pending-2'],
  );
});

test('重复权限拒绝审计桶满后使用固定 overflow 窗口，避免大量不同 bucket 穿透写库', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    devAuthUser: null,
    lldapMode: 'mock',
    auditCoalesceWindowMs: 60_000,
    auditCoalesceMaxBuckets: 2,
  });
  for (let i = 0; i < 6; i += 1) {
    ensureHubUser(hub.db, { username: `member-overflow-${i}` });
    const denied = await jsonRequest(baseUrl, '/api/system/audit', { headers: { 'remote-user': `member-overflow-${i}` } });
    assert.equal(denied.status, 403);
  }

  const auditRows = hub.db.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.view_global' AND result='denied'
     ORDER BY time, id
  `).all();
  assert.equal(auditRows.length, 2);
  const overflowRows = hub.db.prepare(`
    SELECT actor_type, actor_id, details FROM audit_events
     WHERE action='audit.coalesce_overflow' AND result='suppressed'
     ORDER BY time, id
  `).all();
  assert.equal(overflowRows.length, 1);
  assert.deepEqual(
    { actor_type: overflowRows[0].actor_type, actor_id: overflowRows[0].actor_id },
    { actor_type: 'system', actor_id: 'audit-coalescer' },
  );
  const overflowDetails = JSON.parse(overflowRows[0].details).auditAggregation;
  assert.equal(overflowDetails.overflow, true);
  assert.equal(overflowDetails.samples.length, 1);
  assert.equal(overflowDetails.samples[0].actorId, 'member-overflow-2');
  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(metrics.body, /^dsh_hub_audit_suppressed_total\{action="audit_view_global"\} 3$/m);

  const dbPath = hub.config.dbPath;
  await hub.close();
  const reopened = new Database(dbPath, { readonly: true });
  t.after(() => reopened.close());
  const flushed = reopened.prepare(`
    SELECT details FROM audit_events
     WHERE action='audit.coalesce_overflow' AND result='suppressed'
     ORDER BY time DESC, id DESC
     LIMIT 1
  `).get();
  const flushedAggregation = JSON.parse(flushed.details).auditAggregation;
  assert.equal(flushedAggregation.flushReason, 'close');
  assert.equal(flushedAggregation.suppressedCount, 3);
  assert.equal(Number.isSafeInteger(flushedAggregation.firstTime), true);
  assert.equal(Number.isSafeInteger(flushedAggregation.lastTime), true);
  assert.equal(flushedAggregation.samples.length, 4);
});

test('G3 namespace 管理支持个人创建、归属筛选、编辑和 registry key reveal 权限', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapMode: 'mock' });
  ensureHubUser(hub.db, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' });
  ensureHubUser(hub.db, { username: 'bob', email: 'bob@example.com', displayName: 'Bob' });
  ensureHubUser(hub.db, { username: 'charlie', email: 'charlie@example.com', displayName: 'Charlie' });

  const aliceNs = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: 'g3-alice-create-namespace',
    body: { name: ' MacMini ', description: '' },
  });
  assert.equal(aliceNs.status, 201);
  assert.equal(aliceNs.body.name, 'MacMini');
  assert.equal(aliceNs.body.description, null);
  assert.match(aliceNs.body.registryKey, /^dhk_/);

  const aliceForBob = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: 'g3-alice-for-bob-denied01',
    body: { name: 'bob-space', ownerUsername: 'bob' },
  });
  assert.equal(aliceForBob.status, 403);

  const bobNs = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g3-owner-for-bob-namespace01',
    body: { name: 'Shared Lab', description: 'owned by bob', ownerUsername: 'bob' },
  });
  assert.equal(bobNs.status, 201);

  const duplicate = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'remote-user': 'owner' },
    idempotencyKey: 'g3-owner-for-bob-duplicate',
    body: { name: ' shared lab ', ownerUsername: 'bob' },
  });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, 'NAMESPACE_NAME_CONFLICT');

  const bobMine = await jsonRequest(baseUrl, '/api/namespaces?scope=mine&q=shared', {
    headers: { 'remote-user': 'bob' },
  });
  assert.equal(bobMine.status, 200);
  assert.equal(bobMine.body.namespaces.length, 1);
  assert.equal(bobMine.body.namespaces[0].ownerUsername, 'bob');
  assert.equal(bobMine.body.namespaces[0].registryKey.secretAvailable, true);

  const updated = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}`, {
    method: 'PATCH',
    headers: { 'remote-user': 'bob' },
    idempotencyKey: 'g3-bob-update-namespace',
    body: { name: 'Shared Lab 2', description: '' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.namespace.name, 'Shared Lab 2');
  assert.equal(updated.body.namespace.description, null);

  addNamespaceMembership(hub.db, {
    namespaceId: bobNs.body.namespaceId,
    userId: 'alice',
    role: 'namespace_admin',
    createdBy: 'bob',
  });
  const memberAddKey = 'g3-member-add-idempotent-01';
  const adminAddsMember = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/members`, {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: memberAddKey,
    body: { username: 'charlie', role: 'member' },
  });
  assert.equal(adminAddsMember.status, 201);
  const adminAddsMemberReplay = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/members`, {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: memberAddKey,
    body: { username: 'charlie', role: 'member' },
  });
  assert.equal(adminAddsMemberReplay.status, 201);
  assert.deepEqual(adminAddsMemberReplay.body, adminAddsMember.body);
  const adminPromotesMember = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/members/charlie`, {
    method: 'PATCH',
    headers: { 'remote-user': 'alice' },
    body: { role: 'namespace_admin' },
  });
  assert.equal(adminPromotesMember.status, 403);
  const adminRemovesOwner = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/members/bob`, {
    method: 'DELETE',
    headers: { 'remote-user': 'alice' },
  });
  assert.equal(adminRemovesOwner.status, 403);
  const lastOwner = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/members/bob`, {
    method: 'PATCH',
    headers: { 'remote-user': 'bob' },
    body: { role: 'member' },
  });
  assert.equal(lastOwner.status, 409);
  assert.equal(lastOwner.body.error.code, 'LAST_OWNER');

  const revealed = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/registry-key/reveal`, {
    method: 'POST',
    headers: {
      'remote-user': 'alice',
      'user-agent': 'G3 audit test agent',
      'x-forwarded-for': '203.0.113.18',
    },
    body: {},
  });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.body.registryKey, bobNs.body.registryKey);

  const rotateDenied = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/rotate`, {
    method: 'POST',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: 'g3-alice-rotate-denied',
    body: { expectedVersion: 1 },
  });
  assert.equal(rotateDenied.status, 403);

  const rotated = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/rotate`, {
    method: 'POST',
    headers: { 'remote-user': 'bob' },
    idempotencyKey: 'g3-bob-rotate-registry-key01',
    body: { expectedVersion: 1, reason: 'test rotate' },
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.version, 2);
  assert.match(rotated.body.registryKey, /^dhk_/);

  const audit = await jsonRequest(baseUrl, `/api/namespaces/${bobNs.body.namespaceId}/audit?limit=200&action=namespace.registry.reveal`, {
    headers: { 'remote-user': 'bob' },
  });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.every((item) => item.action === 'namespace.registry.reveal'));
  assert.equal(JSON.stringify(audit.body).includes(bobNs.body.registryKey), false);
  assert.equal(audit.body.items[0].details.clientIpSummary.length, 16);
  assert.equal(audit.body.items[0].details.userAgentSummary.length, 16);
  assert.equal(JSON.stringify(audit.body).includes('203.0.113.18'), false);
  assert.equal(JSON.stringify(audit.body).includes('G3 audit test agent'), false);
});

test('membership 自降级和自移除审计保留变更前 actorScope', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapMode: 'mock' });
  ensureHubUser(hub.db, { username: 'alice' });
  ensureHubUser(hub.db, { username: 'bob' });
  ensureHubUser(hub.db, { username: 'carol' });
  const namespace = createNamespace(hub.db, { name: 'self-scope', ownerUserId: 'alice' });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.namespaceId,
    userId: 'bob',
    role: 'namespace_owner',
    createdBy: 'alice',
  });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.namespaceId,
    userId: 'carol',
    role: 'namespace_owner',
    createdBy: 'alice',
  });

  const selfDowngrade = await jsonRequest(baseUrl, `/api/namespaces/${namespace.namespaceId}/members/alice`, {
    method: 'PATCH',
    headers: { 'remote-user': 'alice' },
    idempotencyKey: 'self-downgrade-scope-0001',
    body: { role: 'member' },
  });
  assert.equal(selfDowngrade.status, 200);
  const selfRemove = await jsonRequest(baseUrl, `/api/namespaces/${namespace.namespaceId}/members/bob`, {
    method: 'DELETE',
    headers: { 'remote-user': 'bob' },
    idempotencyKey: 'self-remove-scope-000001',
  });
  assert.equal(selfRemove.status, 204);

  const rows = hub.db.prepare(`
    SELECT target_user_id, details FROM audit_events
     WHERE namespace_id=? AND action IN ('namespace.member.update', 'namespace.member.remove')
     ORDER BY time, id
  `).all(namespace.namespaceId);
  assert.deepEqual(rows.map((row) => [row.target_user_id, JSON.parse(row.details).actorScope]), [
    ['alice', 'namespace_owner'],
    ['bob', 'namespace_owner'],
  ]);
});

test('Portal API 返回角色能力投影，普通用户无 all scope 且 member/viewer 无实例管理动作', async (t) => {
  const { hub, baseUrl } = await startHub(t, { devAuthUser: null, lldapMode: 'mock' });
  ensureHubUser(hub.db, { username: 'alice' });
  ensureHubUser(hub.db, { username: 'bob' });
  ensureHubUser(hub.db, { username: 'viewer' });
  const namespace = createNamespace(hub.db, { name: 'capabilities', ownerUserId: 'owner' });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.namespaceId,
    userId: 'alice',
    role: 'namespace_admin',
    createdBy: 'owner',
  });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.namespaceId,
    userId: 'bob',
    role: 'member',
    createdBy: 'owner',
  });
  addNamespaceMembership(hub.db, {
    namespaceId: namespace.namespaceId,
    userId: 'viewer',
    role: 'viewer',
    createdBy: 'owner',
  });
  registerInstance(hub.db, {
    namespaceId: namespace.namespaceId,
    installationId: `insl_${'a'.repeat(22)}`,
    delivery: 'plugin',
    deploymentMode: 'remote',
  });

  const adminDetail = await jsonRequest(baseUrl, `/api/namespaces/${namespace.namespaceId}`, {
    headers: { 'remote-user': 'alice' },
  });
  assert.equal(adminDetail.status, 200);
  assert.deepEqual(adminDetail.body.namespace.capabilities.allowedMemberRoles, ['viewer', 'member']);
  assert.deepEqual(adminDetail.body.namespace.capabilities.allowedInviteRoles, ['viewer', 'member']);

  const memberAll = await jsonRequest(baseUrl, '/api/namespaces?scope=all', {
    headers: { 'remote-user': 'bob' },
  });
  assert.equal(memberAll.status, 403);
  const memberPortal = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'bob' } });
  assert.equal(memberPortal.status, 200);
  assert.equal(memberPortal.body.me.capabilities.canListUsers, false);
  const memberInstance = memberPortal.body.instances[0];
  assert.equal(memberInstance.capabilities.canIssueReplacementGrant, false);
  assert.equal(memberInstance.capabilities.canRevoke, false);
  assert.equal(memberInstance.capabilities.canRecover, false);
  assert.equal(memberInstance.capabilities.canOpen, true);

  const viewerPortal = await jsonRequest(baseUrl, '/api/portal', { headers: { 'remote-user': 'viewer' } });
  assert.equal(viewerPortal.status, 200);
  assert.equal(viewerPortal.body.instances[0].capabilities.canOpen, false);
  assert.equal(viewerPortal.body.instances[0].capabilities.canIssueReplacementGrant, false);
});

test('registry key 可重复入伙、更新后旧 key 仅能重放且既有 token 仍可建 tunnel', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'namespace-create-key-0001',
    body: { name: 'team' },
  });
  assert.equal(namespace.status, 201);

  const registryKey = namespace.body.registryKey;
  const firstRequest = {
    registryKey,
    installationId: makeInstallationId(),
    delivery: 'agent',
    hostname: 'first-host',
    clientVersion: '0.1.0',
    dshVersion: null,
  };
  const firstIdempotencyKey = 'register-first-installation-0001';
  const first = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST', idempotencyKey: firstIdempotencyKey, body: firstRequest,
  });
  const second = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'register-second-installation-001',
    body: { ...firstRequest, installationId: makeInstallationId(), hostname: 'second-host' },
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.notEqual(first.body.instanceId, second.body.instanceId);

  const rotated = await jsonRequest(
    baseUrl,
    `/api/namespaces/${namespace.body.namespaceId}/rotate`,
    { method: 'POST', idempotencyKey: 'registry-rotate-key-000001', body: { expectedVersion: 1 } },
  );
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.version, 2);

  const rejected = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'register-after-rotation-00001',
    body: { ...firstRequest, installationId: makeInstallationId() },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, 'INVALID_REGISTRY_KEY');

  const replay = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST', idempotencyKey: firstIdempotencyKey, body: firstRequest,
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, first.body);

  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/agent');
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    instanceId: first.body.instanceId,
    installationId: firstRequest.installationId,
    token: first.body.instanceToken,
    delivery: 'agent',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: DEFAULT_LIMITS,
  }));
  const [message] = await once(ws, 'message');
  assert.equal(JSON.parse(message.toString()).type, 'welcome');
  ws.close();
  await once(ws, 'close');
  for (let attempt = 0; attempt < 20 && hub.tunnels.get(first.body.instanceId); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(hub.tunnels.get(first.body.instanceId), null);
});

test('G13 register 和 tunnel hello 记录 deploymentMode，invalid hello 不清空既有模式', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'namespace-create-g13-mode-001',
    body: { name: 'team-g13' },
  });
  assert.equal(namespace.status, 201);

  const installationId = makeInstallationId();
  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'register-g13-mode-000000001',
    body: {
      registryKey: namespace.body.registryKey,
      installationId,
      delivery: 'plugin',
      deploymentMode: 'hosted',
      hostname: 'hosted-dsh',
      clientVersion: SERVICE_PACKAGE_VERSION,
      dshVersion: null,
    },
  });
  assert.equal(joined.status, 201);

  let listed = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/instances`);
  assert.equal(listed.body.items[0].deploymentMode, 'hosted');

  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/agent');
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    instanceId: joined.body.instanceId,
    installationId,
    token: joined.body.instanceToken,
    delivery: 'plugin',
    deploymentMode: 'not-a-mode',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: DEFAULT_LIMITS,
  }));
  const [message] = await once(ws, 'message');
  assert.equal(JSON.parse(message.toString()).type, 'welcome');
  ws.close();
  await once(ws, 'close');
  for (let attempt = 0; attempt < 20 && hub.tunnels.get(joined.body.instanceId); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  listed = await jsonRequest(baseUrl, `/api/namespaces/${namespace.body.namespaceId}/instances`);
  assert.equal(listed.body.items[0].deploymentMode, 'hosted');
});

test('token rotate 支持幂等重放且不同 key 不能分叉', async (t) => {
  const { baseUrl } = await startHub(t);
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'rotate' });

  const rotated = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/tokens/rotate`, {
    method: 'POST',
    idempotencyKey: 'token-rotate-idempotency-0001',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.instanceToken, /^dht_/);
  assert.notEqual(rotated.body.instanceToken, joined.instanceToken);
  assert.ok(rotated.body.overlapUntil);

  const replay = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/tokens/rotate`, {
    method: 'POST',
    idempotencyKey: 'token-rotate-idempotency-0001',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, rotated.body);

  const fork = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/tokens/rotate`, {
    method: 'POST',
    idempotencyKey: 'token-rotate-idempotency-0002',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(fork.status, 409);
  assert.equal(fork.body.error.code, 'TOKEN_ALREADY_ROTATED');
});

test('grace 内过期 token 可轮换，超过 renewalUntil 后失败', async (t) => {
  const { baseUrl } = await startHub(t, {
    instanceTokenTtlMs: 25,
    instanceTokenRenewalGraceMs: 80,
  });
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'grace' });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const graceRotate = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/tokens/rotate`, {
    method: 'POST',
    idempotencyKey: 'token-grace-rotate-000000001',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(graceRotate.status, 200);
  assert.ok(Date.parse(graceRotate.body.overlapUntil) <= Date.now());

  const { joined: expired } = await createJoinedInstance(baseUrl, { idSuffix: 'expired' });
  await new Promise((resolve) => setTimeout(resolve, 130));
  const rejected = await jsonRequest(baseUrl, `/api/instances/${expired.instanceId}/tokens/rotate`, {
    method: 'POST',
    idempotencyKey: 'token-expired-rotate-00000001',
    headers: { authorization: `Bearer ${expired.instanceToken}` },
  });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.body.error.code, 'TOKEN_EXPIRED');
});

test('replacement grant supersede 旧授权、消费保持 instanceId 且只能一次', async (t) => {
  const { baseUrl } = await startHub(t);
  const installationId = makeInstallationId();
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'replace', installationId });

  const firstGrant = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/replacement-grants`, {
    method: 'POST',
    idempotencyKey: 'replacement-grant-create-0001',
    body: { reason: 'first approval' },
  });
  assert.equal(firstGrant.status, 201);
  assert.match(firstGrant.body.replacementGrant, /^dhr_/);

  const secondGrant = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/replacement-grants`, {
    method: 'POST',
    idempotencyKey: 'replacement-grant-create-0002',
    body: { reason: 'second approval' },
  });
  assert.equal(secondGrant.status, 201);
  assert.notEqual(secondGrant.body.replacementGrant, firstGrant.body.replacementGrant);

  const oldRejected = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'replacement-consume-old-000001',
    body: {
      replacementGrant: firstGrant.body.replacementGrant,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(oldRejected.status, 401);
  assert.equal(oldRejected.body.error.code, 'INVALID_REPLACEMENT_GRANT');

  const restored = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'replacement-consume-new-000001',
    body: {
      replacementGrant: secondGrant.body.replacementGrant,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(restored.status, 201);
  assert.equal(restored.body.instanceId, joined.instanceId);
  assert.notEqual(restored.body.instanceToken, joined.instanceToken);

  const replay = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'replacement-consume-new-000001',
    body: {
      replacementGrant: secondGrant.body.replacementGrant,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, restored.body);

  const secondUse = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'replacement-consume-new-000002',
    body: {
      replacementGrant: secondGrant.body.replacementGrant,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(secondUse.status, 401);
  assert.equal(secondUse.body.error.code, 'INVALID_REPLACEMENT_GRANT');
});

test('self revoke 使用 Bearer token 吊销并允许重试收敛', async (t) => {
  const { baseUrl } = await startHub(t);
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'leave' });

  const first = await fetch(`${baseUrl}/api/instances/${joined.instanceId}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(first.status, 204);

  const retry = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${joined.instanceToken}` },
  });
  assert.equal(retry.status, 403);
  assert.equal(retry.body.error.code, 'TOKEN_REVOKED');
});

test('可信代理校验拒绝非受信来源伪造身份头', async (t) => {
  const { baseUrl } = await startHub(t, {
    ...splitHosts(),
    devAuthUser: null,
    trustedProxyCidrs: '10.0.0.0/8',
    trustedProxyRanges: [{ family: 4, bytes: Buffer.from([10, 0, 0, 0]), bits: 8 }],
  });

  const rejected = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'GET',
    host: 'hub.localhost',
    headers: { 'remote-user': 'owner' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'UNTRUSTED_PROXY');
});

test('可信代理身份头必须唯一且使用配置的规范头', async (t) => {
  const { baseUrl } = await startHub(t, { ...splitHosts(), devAuthUser: null });
  const duplicate = await rawHttpRequest(baseUrl, '/api/namespaces', {
    headers: {
      host: 'hub.localhost',
      'remote-user': ['owner', 'other'],
    },
  });
  assert.equal(duplicate.status, 400);
  assert.equal(duplicate.body.error.code, 'BAD_IDENTITY_HEADER');

  const wrongHeader = await rawHttpRequest(baseUrl, '/api/namespaces', {
    headers: {
      host: 'hub.localhost',
      'x-authenticated-user': 'owner',
    },
  });
  assert.equal(wrongHeader.status, 400);
  assert.equal(wrongHeader.body.error.code, 'BAD_IDENTITY_HEADER');
});

test('Host 解析严格拒绝畸形 bracket，仅接受合法 IPv6 bracket', async (t) => {
  const { baseUrl } = await startHub(t);

  const ipv6Loopback = await rawHttpRequest(baseUrl, '/healthz', {
    headers: { host: '[::1]:8081' },
  });
  assert.equal(ipv6Loopback.status, 200);

  for (const host of ['[control.localhost]junk', '[hub.localhost]', '[::1]junk', '[::1]:99999', 'bad..host']) {
    const rejected = await rawHttpRequest(baseUrl, '/healthz', { headers: { host } });
    assert.equal(rejected.status, 400, host);
    assert.equal(rejected.body.error.code, 'BAD_HOST', host);
  }
});

test('三 host 分域：control 不提供 Portal，portal 不接受控制面注册', async (t) => {
  const { baseUrl } = await startHub(t, splitHosts());

  const controlRoot = await rawHttpRequest(baseUrl, '/', { headers: { host: 'control.localhost' } });
  assert.equal(controlRoot.status, 404);

  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    host: 'hub.localhost',
    idempotencyKey: 'split-host-namespace-000001',
    body: { name: 'split-host' },
  });
  assert.equal(namespace.status, 201);

  const portalRegister = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    host: 'hub.localhost',
    idempotencyKey: 'split-host-register-portal1',
    body: {
      registryKey: namespace.body.registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(portalRegister.status, 404);
  assert.equal(portalRegister.body.error.code, 'NOT_FOUND');

  const controlRegister = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    host: 'control.localhost',
    idempotencyKey: 'split-host-register-control',
    body: {
      registryKey: namespace.body.registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(controlRegister.status, 201);
});

test('TLS ask 端点仅允许受管域名和已注册实例域名', async (t) => {
  const { baseUrl } = await startHub(t, {
    baseDomain: 'hub.example.com',
    portalHost: 'hub.example.com',
    controlHost: 'control.hub.example.com',
    instanceBaseDomain: 'instances.hub.example.com',
    publicScheme: 'http',
  });
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    host: 'hub.example.com',
    idempotencyKey: 'tls-ask-namespace-0000000001',
    body: { name: 'tls ask' },
  });
  assert.equal(namespace.status, 201);
  const installationId = makeInstallationId();
  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    host: 'control.hub.example.com',
    idempotencyKey: 'tls-ask-register-0000000001',
    body: {
      registryKey: namespace.body.registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(joined.status, 201);

  for (const domain of [
    'hub.example.com',
    'control.hub.example.com',
    'auth.hub.example.com',
    `${joined.body.instanceId}.instances.hub.example.com`,
    `${joined.body.instanceId}.instances.hub.example.com.`,
  ]) {
    const allowed = await rawHttpRequest(baseUrl, `/api/tls/ask?domain=${encodeURIComponent(domain)}`);
    assert.equal(allowed.status, 200, domain);
  }

  const publicAsk = await rawHttpRequest(baseUrl, `/api/tls/ask?domain=${encodeURIComponent(`${joined.body.instanceId}.instances.hub.example.com`)}`, {
    headers: { host: 'control.hub.example.com' },
  });
  assert.equal(publicAsk.status, 403);
  assert.equal(publicAsk.body.error.code, 'FORBIDDEN_HOST');

  for (const domain of [
    'evil.example',
    '*.instances.hub.example.com',
    'bad.instances.hub.example.com',
    'inst-aaaaaaaaaaaaaaaaaaaaaaaaaa.instances.hub.example.com',
    'inst-aaaaaaaaaaaaaaaaaaaaaaaaaa.instances.hub.example.com:443',
    'inst-aaaaaaaaaaaaaaaaaaaaaaaaaa.instances.hub.example.com/path',
  ]) {
    const rejected = await rawHttpRequest(baseUrl, `/api/tls/ask?domain=${encodeURIComponent(domain)}`);
    assert.notEqual(rejected.status, 200, domain);
  }
});

test('M3B metrics 仅内部 loopback 直连可读且不暴露秘密', async (t) => {
  const { baseUrl } = await startHub(t, {
    baseDomain: 'hub.example.com',
    portalHost: 'hub.example.com',
    controlHost: 'control.hub.example.com',
    instanceBaseDomain: 'instances.hub.example.com',
    publicScheme: 'http',
  });

  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers['content-type'], /^text\/plain; version=0\.0\.4/);
  assert.equal(metrics.headers['cache-control'], 'no-store');
  assert.match(metrics.body, /^# HELP dsh_hub_build_info/m);
  assert.match(metrics.body, new RegExp(`^dsh_hub_build_info\\{version="${SERVICE_PACKAGE_VERSION.replaceAll('.', '\\.')}"} 1$`, 'm'));
  assert.match(metrics.body, /^dsh_hub_tunnels_active 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_sessions_active 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_sessions_by_type\{type="http"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_queued_bytes\{direction="browser_to_instance",statistic="sum"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_uncredited_bytes\{direction="instance_to_browser",statistic="max"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_downstream_buffered_bytes\{transport="tunnel_websocket",statistic="sum"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_relay_credit_waiters\{stream="req",statistic="sum"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_tunnels_by_delivery\{delivery="agent"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_tunnels_dsh_reachable\{state="unknown"\} 0$/m);
  assert.match(metrics.body, /^dsh_hub_heartbeat_sent_at_age_seconds_count 0$/m);
  assert.match(metrics.body, /^dsh_hub_process_resident_memory_bytes \d+$/m);
  assert.match(metrics.body, /^dsh_hub_event_loop_delay_seconds\{statistic="mean"\} [0-9.]+$/m);
  assert.doesNotMatch(metrics.body, /dhr_|dht_|dshrk_|registryKey|instanceToken|authorization|inst-[a-z2-7]{26}|ns_[0-9a-f]{16}/i);

  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    host: 'hub.example.com',
    idempotencyKey: 'metrics-namespace-0000000001',
    body: { name: 'metrics' },
  });
  assert.equal(namespace.status, 201);
  const installationId = makeInstallationId();
  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    host: 'control.hub.example.com',
    idempotencyKey: 'metrics-register-0000000001',
    body: {
      registryKey: namespace.body.registryKey,
      installationId,
      delivery: 'plugin',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(joined.status, 201);
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/agent', {
    headers: { host: 'control.hub.example.com' },
  });
  await once(ws, 'open');
  ws.send(JSON.stringify({
    type: 'hello',
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    instanceId: joined.body.instanceId,
    installationId,
    token: joined.body.instanceToken,
    delivery: 'plugin',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: DEFAULT_LIMITS,
  }));
  const [welcome] = await once(ws, 'message');
  assert.equal(JSON.parse(welcome.toString()).type, 'welcome');
  const activeMetrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(activeMetrics.body, /^dsh_hub_tunnels_active 1$/m);
  assert.match(activeMetrics.body, /^dsh_hub_tunnels_by_delivery\{delivery="plugin"\} 1$/m);
  assert.match(activeMetrics.body, /^dsh_hub_tunnels_dsh_reachable\{state="unknown"\} 1$/m);
  assert.match(activeMetrics.body, /^dsh_hub_sqlite_write_seconds_count\{operation="namespace_create"\} 1$/m);
  assert.match(activeMetrics.body, /^dsh_hub_sqlite_write_seconds_count\{operation="instance_register"\} 1$/m);
  assert.doesNotMatch(activeMetrics.body, /dhr_|dht_|dshrk_|registryKey|instanceToken|authorization|inst-[a-z2-7]{26}|ns_[0-9a-f]{16}/i);
  ws.close();
  await once(ws, 'close');

  for (const host of [
    'hub.example.com',
    'control.hub.example.com',
    'auth.hub.example.com',
    `${joined.body.instanceId}.instances.hub.example.com`,
  ]) {
    const publicMetrics = await rawHttpRequest(baseUrl, '/metrics', { headers: { host } });
    assert.equal(publicMetrics.status, 403, host);
    assert.equal(publicMetrics.body.error.code, 'FORBIDDEN_HOST', host);
  }
});

test('instance 请求在创建 relay session 前执行 Origin 和 Fetch Metadata 策略', async (t) => {
  const { baseUrl } = await startHub(t, splitHosts());
  const namespace = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    host: 'hub.localhost',
    idempotencyKey: 'origin-namespace-0000000001',
    body: { name: 'origin' },
  });
  assert.equal(namespace.status, 201);
  const joinedResponse = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    host: 'control.localhost',
    idempotencyKey: 'origin-register-0000000001',
    body: {
      registryKey: namespace.body.registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });
  assert.equal(joinedResponse.status, 201);
  const joined = joinedResponse.body;
  const host = `${joined.instanceId}.instances.localhost`;

  const missingOrigin = await jsonRequest(baseUrl, '/api/change', {
    method: 'POST',
    host,
    headers: { 'sec-fetch-site': 'same-origin' },
    body: { ok: true },
  });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.body.error.code, 'FORBIDDEN_ORIGIN');

  const crossSite = await rawHttpRequest(baseUrl, '/', {
    headers: {
      host,
      'sec-fetch-site': 'same-origin, cross-site',
    },
  });
  assert.equal(crossSite.status, 403);

  const badOrigin = await rawHttpRequest(baseUrl, '/', {
    headers: {
      host,
      origin: `http://evil.example`,
    },
  });
  assert.equal(badOrigin.status, 403);

  const absoluteTarget = await rawHttpRequest(baseUrl, 'http://evil.example/path', {
    headers: { host },
  });
  assert.equal(absoluteTarget.status, 400);
  assert.equal(absoluteTarget.body.error.code, 'BAD_TARGET');

  for (const path of ['/bad%0dpath', '/bad%zzpath', '/bad\\path', '/bad#fragment']) {
    const rejected = await rawHttpRequest(baseUrl, path, { headers: { host } });
    assert.equal(rejected.status, 400, path);
    assert.equal(rejected.body.error.code, 'BAD_TARGET', path);
  }
});

test('instance WebSocket 在 101 前拒绝非法 Connection 动态头', async (t) => {
  const { baseUrl } = await startHub(t);
  const { joined, installationId } = await createJoinedInstance(baseUrl, { idSuffix: 'ws-header' });
  const tunnel = new WebSocket(baseUrl.replace(/^http/, 'ws') + '/agent');
  await once(tunnel, 'open');
  tunnel.send(JSON.stringify({
    type: 'hello',
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    instanceId: joined.instanceId,
    installationId,
    token: joined.instanceToken,
    delivery: 'agent',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: DEFAULT_LIMITS,
  }));
  const [message] = await once(tunnel, 'message');
  assert.equal(JSON.parse(message.toString()).type, 'welcome');
  t.after(() => {
    try { tunnel.close(); } catch { /* noop */ }
  });

  const host = `${joined.instanceId}.localhost`;
  const response = await rawTcpRequest(baseUrl, [
    'GET /api/events.mux HTTP/1.1',
    `Host: ${host}`,
    `Origin: http://${host}`,
    'Upgrade: websocket',
    'Connection: Upgrade, bad token',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'));
  assert.match(response, /^HTTP\/1\.1 400 Bad Request/);
  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(metrics.body, /^dsh_hub_ws_upgrade_rejections_total\{status="400"\} 1$/m);
});

test('Portal 页面使用严格 CSP、安全头和安全 DOM 渲染结构', async (t) => {
  const { baseUrl } = await startHub(t);
  const response = await fetch(`${baseUrl}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'nonce-/);
  assert.match(csp, /style-src 'nonce-/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(html, /innerHTML|onclick=|allow-popups|allow-modals/);
  assert.match(html, /sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"/);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source));
});

test('Portal 页面由拆分模块组装为单 HTML、单 nonce style 和单 nonce script', () => {
  const html = portalHtml({ nonce: 'test-nonce' });
  assert.equal((html.match(/<style nonce="test-nonce">/g) || []).length, 1);
  assert.equal((html.match(/<script nonce="test-nonce">/g) || []).length, 1);
  assert.equal(html.includes(portalStyles.trim()), true);
  assert.equal(html.includes(portalApiScript.trim()), true);
  assert.equal(html.includes(portalUiScript.trim()), true);
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  assert.equal(scripts.length, 1);
  assert.equal((scripts[0].match(/lines\.join\('\\n'\)/g) || []).length, 2);
  assert.equal(scripts[0].includes("lines.join('\\\\n')"), false);
  assert.doesNotThrow(() => new vm.Script(scripts[0]));
});

test('Portal owner 写接口要求精确 Origin 和 CSRF，且校验 schema', async (t) => {
  const { baseUrl } = await startHub(t);
  await assertPortalWriteSecurity(baseUrl, '/api/namespaces', {
    idempotencyKey: 'csrf-create',
    body: { name: 'csrf-team' },
  });

  const portal = await jsonRequest(baseUrl, '/api/portal');
  const missingIdempotency = await rawHttpRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: {
      origin: baseUrl,
      'x-csrf-token': portal.body.csrfToken,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'missing-idempotency' }),
  });
  assert.equal(missingIdempotency.status, 400);
  assert.equal(missingIdempotency.body.error.code, 'IDEMPOTENCY_REQUIRED');

  const extraField = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'csrf-extra-field-000000001',
    body: { name: 'csrf-team', extra: true },
  });
  assert.equal(extraField.status, 400);
  assert.equal(extraField.body.error.code, 'BAD_REQUEST');

  const created = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'csrf-valid-create-00000001',
    body: { name: 'csrf-team' },
  });
  assert.equal(created.status, 201);

  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'csrf-routes' });
  await assertPortalWriteSecurity(baseUrl, `/api/namespaces/${created.body.namespaceId}/rotate`, {
    idempotencyKey: 'csrf-rotate',
    body: { expectedVersion: 1 },
  });
  await assertPortalWriteSecurity(baseUrl, `/api/instances/${joined.instanceId}/revoke`, {
    body: { reason: 'security check' },
  });
  await assertPortalWriteSecurity(baseUrl, `/api/instances/${joined.instanceId}/replacement-grants`, {
    idempotencyKey: 'csrf-replacement',
    body: { reason: 'security check' },
  });
});

test('owner 列表使用 cursor 分页、字段最小化和 DSH stale 语义', async (t) => {
  const { hub, baseUrl } = await startHub(t, { healthStaleAfterMs: 10 });
  const names = ['page-a', 'page-b', 'page-c'];
  const namespaces = [];
  for (const name of names) {
    const created = await jsonRequest(baseUrl, '/api/namespaces', {
      method: 'POST',
      idempotencyKey: `page-${name}`.padEnd(32, '0'),
      body: { name },
    });
    assert.equal(created.status, 201);
    namespaces.push(created.body);
  }
  const firstPage = await jsonRequest(baseUrl, '/api/namespaces?limit=2');
  assert.equal(firstPage.status, 200);
  assert.equal(firstPage.body.items.length, 2);
  assert.ok(firstPage.body.nextCursor);
  assert.equal(Object.hasOwn(firstPage.body.items[0], 'owner_user_id'), false);
  assert.equal(Object.hasOwn(firstPage.body.items[0], 'digest'), false);

  const secondPage = await jsonRequest(baseUrl, `/api/namespaces?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`);
  assert.equal(secondPage.status, 200);
  assert.equal(secondPage.body.items.length, 1);

  const badCursor = await jsonRequest(baseUrl, '/api/namespaces?cursor=bad');
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.body.error.code, 'BAD_CURSOR');

  const joined = await jsonRequest(baseUrl, '/api/register', {
    method: 'POST',
    idempotencyKey: 'page-register-instance-00001',
    body: {
      registryKey: namespaces[0].registryKey,
      installationId: makeInstallationId(),
      delivery: 'agent',
      hostname: '<img src=x onerror=alert(1)>',
      clientVersion: '0.1.0',
      dshVersion: '<script>alert(1)</script>',
    },
  });
  assert.equal(joined.status, 201);
  hub.db.prepare(`
    UPDATE instances
       SET last_dsh_online=1, last_dsh_observed_at=?
     WHERE id=?
  `).run(Date.now() - 60_000, joined.body.instanceId);

  const instances = await jsonRequest(baseUrl, `/api/namespaces/${namespaces[0].namespaceId}/instances?limit=1`);
  assert.equal(instances.status, 200);
  assert.equal(instances.body.items.length, 1);
  const item = instances.body.items[0];
  assert.equal(item.instanceId, joined.body.instanceId);
  assert.equal(item.connectionState, 'offline');
  assert.equal(item.dshHealth.freshness, 'stale');
  assert.equal(Object.hasOwn(item, 'id'), false);
  assert.equal(Object.hasOwn(item, 'status'), false);
  assert.equal(Object.hasOwn(item, 'installation_id'), false);
  assert.equal(Object.hasOwn(item, 'digest'), false);
  assert.equal(Object.hasOwn(item, 'pepper_key_id'), false);
});

test('Portal 首屏返回 namespace 分页游标，避免超过首屏数量时无法翻页', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  for (let i = 0; i < 51; i += 1) {
    createNamespace(hub.db, { name: `portal-page-${String(i).padStart(2, '0')}`, ownerUserId: 'owner' });
  }

  const portal = await jsonRequest(baseUrl, '/api/portal');
  assert.equal(portal.status, 200);
  assert.equal(portal.body.namespaces.length, 50);
  assert.ok(portal.body.namespaceNextCursor);

  const nextPage = await jsonRequest(baseUrl, `/api/namespaces?limit=50&cursor=${encodeURIComponent(portal.body.namespaceNextCursor)}`);
  assert.equal(nextPage.status, 200);
  assert.equal(nextPage.body.items.length, 1);
});

test('G3 实例连接筛选在数据库分页前生效，并返回 namespace 在线实例数', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const newestOffline = await createJoinedInstance(baseUrl, { idSuffix: 'g3-filter-newest' });
  const olderOffline = await createJoinedInstance(baseUrl, { idSuffix: 'g3-filter-older' });
  const oldestOnline = await createJoinedInstance(baseUrl, { idSuffix: 'g3-filter-online' });
  hub.db.prepare('UPDATE instances SET created_at=? WHERE id=?').run(300, newestOffline.joined.instanceId);
  hub.db.prepare('UPDATE instances SET created_at=? WHERE id=?').run(200, olderOffline.joined.instanceId);
  hub.db.prepare('UPDATE instances SET created_at=? WHERE id=?').run(100, oldestOnline.joined.instanceId);
  hub.tunnels.set({
    instanceId: oldestOnline.joined.instanceId,
    alive: true,
    markDead() {},
    closeSessions() {},
  });

  const online = await jsonRequest(baseUrl, '/api/instances?status=online&access=active&limit=1');
  assert.equal(online.status, 200);
  assert.deepEqual(online.body.items.map((item) => item.instanceId), [oldestOnline.joined.instanceId]);
  assert.equal(online.body.nextCursor, null);

  const offlineFirst = await jsonRequest(baseUrl, '/api/instances?connection=offline&limit=1');
  assert.equal(offlineFirst.status, 200);
  assert.equal(offlineFirst.body.items.length, 1);
  assert.ok(offlineFirst.body.nextCursor);
  const offlineSecond = await jsonRequest(
    baseUrl,
    `/api/instances?connection=offline&limit=1&cursor=${encodeURIComponent(offlineFirst.body.nextCursor)}`,
  );
  assert.equal(offlineSecond.status, 200);
  assert.equal(offlineSecond.body.items.length, 1);
  assert.notEqual(offlineFirst.body.items[0].instanceId, offlineSecond.body.items[0].instanceId);

  const namespace = await jsonRequest(baseUrl, `/api/namespaces/${oldestOnline.namespace.namespaceId}`);
  assert.equal(namespace.status, 200);
  assert.equal(namespace.body.namespace.onlineInstanceCount, 1);

  const invalid = await jsonRequest(baseUrl, '/api/instances?status=unknown');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, 'BAD_REQUEST');
});

test('M3A diagnostics API 对离线实例返回只读摘要且未知实例不泄露', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'm3a-offline' });

  const diagnostics = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/diagnostics`);
  assert.equal(diagnostics.status, 200);
  assert.equal(diagnostics.body.instance.instanceId, joined.instanceId);
  assert.equal(diagnostics.body.relay.connectionState, 'offline');
  assert.equal(diagnostics.body.dshApi.sessionList.transportError, 'instance offline');
  assert.equal(diagnostics.body.websocket.eventsMux.error, 'instance offline');
  assert.ok(diagnostics.body.recommendations.some((item) => item.code === 'INSTANCE_OFFLINE'));
  assert.equal(Object.hasOwn(diagnostics.body.instance, 'installation_id'), false);
  assert.equal(Object.hasOwn(diagnostics.body.instance, 'digest'), false);

  const unknown = await jsonRequest(baseUrl, '/api/instances/inst-aaaaaaaaaaaaaaaaaaaaaaaaaa/diagnostics');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'INSTANCE_NOT_FOUND');

  hub.db.prepare("UPDATE namespace_memberships SET status='removed' WHERE namespace_id=? AND user_id=?").run(joined.namespaceId, 'owner');
  hub.db.prepare('DELETE FROM system_admins WHERE user_id=?').run('owner');
  const nonOwner = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/diagnostics`);
  assert.equal(nonOwner.status, 404);
  assert.equal(nonOwner.body.error.code, 'INSTANCE_NOT_FOUND');
});

test('owner revoke 要求 reason 并写结构化审计', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'owner-reason' });

  const missingReason = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/revoke`, {
    method: 'POST',
    body: {},
  });
  assert.equal(missingReason.status, 400);
  assert.equal(missingReason.body.error.code, 'BAD_REQUEST');

  const revoked = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/revoke`, {
    method: 'POST',
    body: { reason: 'operator approved revoke' },
  });
  assert.equal(revoked.status, 204);

  const audit = hub.db.prepare(`
    SELECT * FROM audit_events
     WHERE action='instance.revoke' AND instance_id=?
     ORDER BY time DESC
     LIMIT 1
  `).get(joined.instanceId);
  assert.ok(audit);
  assert.equal(audit.actor_type, 'user');
  assert.equal(audit.actor_id, 'owner');
  assert.equal(JSON.parse(audit.details).reason, 'operator approved revoke');
});

test('owner revoke 审计失败时回滚状态变更', async (t) => {
  const { hub, baseUrl } = await startHub(t);
  const { joined } = await createJoinedInstance(baseUrl, { idSuffix: 'owner-audit-rollback' });
  hub.db.exec(`
    CREATE TRIGGER fail_owner_revoke_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action = 'instance.revoke'
      BEGIN
        SELECT RAISE(FAIL, 'audit write failed');
      END;
  `);

  const rejected = await jsonRequest(baseUrl, `/api/instances/${joined.instanceId}/revoke`, {
    method: 'POST',
    body: { reason: 'operator approved revoke' },
  });
  assert.equal(rejected.status, 500);

  const instance = hub.db.prepare('SELECT state FROM instances WHERE id=?').get(joined.instanceId);
  assert.equal(instance.state, 'active');
  const revokedTokens = hub.db.prepare(`
    SELECT count(*) AS n
      FROM instance_tokens
     WHERE instance_id=? AND revoked_at IS NOT NULL
  `).get(joined.instanceId);
  assert.equal(revokedTokens.n, 0);
});

test('Portal 写操作限流返回 429 并写审计', async (t) => {
  const { hub, baseUrl } = await startHub(t, {
    portalWriteRateLimitMax: 1,
    rateLimitWindowMs: 60_000,
  });
  const first = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'rate-limit-first-00000001',
    body: { name: 'rate-first' },
  });
  assert.equal(first.status, 201);
  const second = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'rate-limit-second-0000001',
    body: { name: 'rate-second' },
  });
  const third = await jsonRequest(baseUrl, '/api/namespaces', {
    method: 'POST',
    idempotencyKey: 'rate-limit-third-00000001',
    body: { name: 'rate-third' },
  });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'RATE_LIMITED');
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'RATE_LIMITED');
  assert.ok(second.headers['retry-after']);
  const audit = hub.db.prepare(`
    SELECT count(*) AS n FROM audit_events
     WHERE action='namespace.create' AND result='rate_limited'
  `).get();
  assert.equal(audit.n, 1);
  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(metrics.body, /^dsh_hub_rate_limit_rejections_total\{action="namespace_create"\} 2$/m);
  assert.match(metrics.body, /^dsh_hub_limit_rejections_total\{kind="rate_limit"\} 2$/m);
  assert.match(metrics.body, /^dsh_hub_audit_suppressed_total\{action="namespace_create"\} 1$/m);
  assert.match(metrics.body, /^dsh_hub_http_errors_total\{code="RATE_LIMITED",status="429"\} 2$/m);
});

test('M3B metrics 统计控制面 body 超限为稳定 LIMIT_EXCEEDED', async (t) => {
  const { baseUrl } = await startHub(t);
  const tooLarge = await rawHttpRequest(baseUrl, '/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: 'x'.repeat(20 * 1024) }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error.code, 'LIMIT_EXCEEDED');
  assert.equal(tooLarge.headers.connection, 'close');

  const rawTooLarge = await rawTcpRequest(baseUrl, [
    'POST /api/register HTTP/1.1',
    'Host: 127.0.0.1',
    'Content-Type: application/json',
    'Content-Length: 1048576',
    'Connection: keep-alive',
    '',
    `{"payload":"${'x'.repeat(20 * 1024)}`,
  ].join('\r\n'));
  assert.match(rawTooLarge, /^HTTP\/1\.1 413 /);
  assert.match(rawTooLarge, /^Connection: close$/im);
  assert.match(rawTooLarge, /"code":"LIMIT_EXCEEDED"/);

  const metrics = await rawTextRequest(baseUrl, '/metrics');
  assert.match(metrics.body, /^dsh_hub_http_errors_total\{code="LIMIT_EXCEEDED",status="413"\} 2$/m);
  assert.match(metrics.body, /^dsh_hub_limit_rejections_total\{kind="http"\} 2$/m);
});
