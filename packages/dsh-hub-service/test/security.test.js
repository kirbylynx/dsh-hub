import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { parseConfig } from '../src/config.js';
import {
  beginIdempotentOperation,
  clearPendingIdempotentOperation,
  completeIdempotentOperation,
  createNamespace,
  openDb,
  recordAudit,
  runIdempotent,
} from '../src/db.js';
import { canonicalJson, makeInstanceId, parseKeyring } from '../src/security.js';
import { forwardHeaders, forwardRespHeaders, normalizeHeaders } from '../src/util.js';
import { securityOptions, tempDatabase } from './test-helpers.js';

test('keyring 拒绝缺失、短 key 和非法 current key', () => {
  assert.throws(() => parseKeyring(null, { name: 'TEST' }), /必须是非空/);
  assert.throws(
    () => parseKeyring(JSON.stringify({ short: Buffer.alloc(8).toString('base64url') }), { name: 'TEST' }),
    /至少 32/,
  );
});

test('service 配置要求两套独立 keyring 且 current key 存在', () => {
  const token = Buffer.alloc(32, 0x11).toString('base64url');
  const idempotency = Buffer.alloc(32, 0x22).toString('base64url');
  const base = {
    TOKEN_PEPPER_KEYRING: JSON.stringify({ current: token }),
    CURRENT_TOKEN_PEPPER_KEY_ID: 'current',
    IDEMPOTENCY_ENCRYPTION_KEYRING: JSON.stringify({ current: idempotency }),
    CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'current',
  };
  const config = parseConfig([], base);
  assert.equal(config.tokenPepperKeyring.get('current').length, 32);
  assert.equal(config.portalHost, 'localhost');
  assert.equal(config.controlHost, 'localhost');
  assert.equal(config.instanceBaseDomain, 'localhost');
  assert.throws(
    () => parseConfig([], { ...base, CURRENT_TOKEN_PEPPER_KEY_ID: 'missing' }),
    /必须引用 keyring 中存在的 key ID/,
  );
  assert.throws(
    () => parseConfig([], {
      ...base,
      IDEMPOTENCY_ENCRYPTION_KEYRING: JSON.stringify({ current: token }),
    }),
    /不得复用/,
  );
});

test('service 配置支持通过 *_FILE 读取部署 secret', (t) => {
  const dir = fs.mkdtempSync('/tmp/dshhub-secret-file-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = Buffer.alloc(32, 0x11).toString('base64url');
  const idempotency = Buffer.alloc(32, 0x22).toString('base64url');
  const tokenFile = `${dir}/token.json`;
  const idempotencyFile = `${dir}/idempotency.json`;
  const proxyFile = `${dir}/proxy-key`;
  fs.writeFileSync(tokenFile, JSON.stringify({ current: token }));
  fs.writeFileSync(idempotencyFile, JSON.stringify({ current: idempotency }));
  fs.writeFileSync(proxyFile, 'proxy-secret\n');

  const config = parseConfig([], {
    TOKEN_PEPPER_KEYRING_FILE: tokenFile,
    CURRENT_TOKEN_PEPPER_KEY_ID: 'current',
    IDEMPOTENCY_ENCRYPTION_KEYRING_FILE: idempotencyFile,
    CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'current',
    DSH_HUB_PROXY_KEY_FILE: proxyFile,
  });
  assert.equal(config.tokenPepperKeyring.get('current').length, 32);
  assert.equal(config.proxyKey, 'proxy-secret');
  assert.throws(
    () => parseConfig([], {
      TOKEN_PEPPER_KEYRING: JSON.stringify({ current: token }),
      TOKEN_PEPPER_KEYRING_FILE: tokenFile,
      CURRENT_TOKEN_PEPPER_KEY_ID: 'current',
      IDEMPOTENCY_ENCRYPTION_KEYRING_FILE: idempotencyFile,
      CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'current',
    }),
    /cannot both be set/,
  );
});

test('service 配置支持三 host 和可信代理 CIDR', () => {
  const token = Buffer.alloc(32, 0x11).toString('base64url');
  const idempotency = Buffer.alloc(32, 0x22).toString('base64url');
  const config = parseConfig([
    '--base-domain', 'hub.example.com',
    '--portal-host', 'hub.example.com',
    '--control-host', 'control.hub.example.com',
    '--instance-base-domain', 'instances.hub.example.com',
    '--public-scheme', 'https',
    '--trusted-proxy-cidrs', '127.0.0.1/32,::1/128',
  ], {
    TOKEN_PEPPER_KEYRING: JSON.stringify({ current: token }),
    CURRENT_TOKEN_PEPPER_KEY_ID: 'current',
    IDEMPOTENCY_ENCRYPTION_KEYRING: JSON.stringify({ current: idempotency }),
    CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID: 'current',
  });
  assert.equal(config.portalHost, 'hub.example.com');
  assert.equal(config.controlHost, 'control.hub.example.com');
  assert.equal(config.instanceBaseDomain, 'instances.hub.example.com');
  assert.equal(config.publicScheme, 'https');
  assert.equal(config.trustedProxyRanges.length, 2);
});

test('relay 请求和响应头清洗不会透传中心凭据或代理身份', () => {
  const headers = forwardHeaders(normalizeHeaders({
    host: 'inst.instances.localhost',
    cookie: 'sid=center',
    authorization: 'Bearer center',
    'remote-user': 'owner',
    'x-forwarded-for': '203.0.113.10',
    forwarded: 'for=203.0.113.10',
    origin: 'http://inst.instances.localhost',
    referer: 'http://inst.instances.localhost/',
    connection: 'X-Dynamic, keep-alive',
    'x-dynamic': 'strip-me',
    accept: 'text/html',
    'sec-websocket-protocol': 'secret-proto',
  }), { hostHeader: '127.0.0.1:3080' });
  assert.deepEqual(headers, {
    accept: ['text/html'],
    host: ['127.0.0.1:3080'],
  });

  const response = forwardRespHeaders({
    'set-cookie': ['dsh=sid'],
    connection: ['X-Internal'],
    'x-internal': ['strip'],
    'x-forwarded-host': ['proxy'],
    'content-type': ['text/html'],
    'content-length': ['999'],
  });
  assert.deepEqual(response, { 'content-type': ['text/html'] });
});

test('非法 Connection 动态头名被拒绝', () => {
  assert.throws(
    () => forwardHeaders(normalizeHeaders({ connection: 'bad token' }), { hostHeader: '127.0.0.1:3080' }),
    (error) => error.code === 'BAD_HEADER',
  );
});

test('instance ID 是固定长度 DNS-safe base32', () => {
  for (let i = 0; i < 100; i++) assert.match(makeInstanceId(), /^inst-[a-z2-7]{26}$/);
});

test('canonical JSON 对 object key 顺序稳定', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test('幂等响应可安全重放，同 key 异请求冲突且幂等记录不含明文响应', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  let mutations = 0;
  const idempotencyKey = 'a'.repeat(32);
  const execute = (name) => runIdempotent(db, {
    actorScope: 'user:owner',
    operation: 'namespace.create',
    idempotencyKey,
    request: { name },
    mutate: () => {
      mutations++;
      return { statusCode: 201, body: createNamespace(db, { name, ownerUserId: 'owner' }) };
    },
  });

  const first = execute('team');
  const replay = execute('team');
  assert.equal(mutations, 1);
  assert.deepEqual(replay.body, first.body);
  assert.equal(replay.replayed, true);
  assert.throws(() => execute('different'), (error) => error.code === 'IDEMPOTENCY_CONFLICT');

  db.pragma('wal_checkpoint(TRUNCATE)');
  const main = fs.readFileSync(dbPath);
  assert.equal(main.includes(Buffer.from(first.body.registryKey)), true);
  const idem = db.prepare('SELECT typeof(encrypted_response) AS type, encrypted_response FROM idempotency_records').get();
  assert.equal(idem.type, 'blob');
  assert.equal(idem.encrypted_response.includes(first.body.registryKey), false);
});

test('幂等密文被篡改时拒绝重放', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const args = {
    actorScope: 'user:owner', operation: 'namespace.create', idempotencyKey: 'b'.repeat(32),
    request: { name: 'team' },
    mutate: () => ({ statusCode: 201, body: { registryKey: 'dhk_fake-secret' } }),
  };
  runIdempotent(db, args);
  const row = db.prepare('SELECT rowid, encrypted_response FROM idempotency_records').get();
  const tampered = Buffer.from(row.encrypted_response);
  tampered[tampered.length - 1] ^= 0xff;
  db.prepare('UPDATE idempotency_records SET encrypted_response=? WHERE rowid=?').run(tampered, row.rowid);
  assert.throws(() => runIdempotent(db, args), (error) => error.code === 'IDEMPOTENCY_RESULT_INVALID');
});

test('审计详情集中脱敏凭据并补充 actor scope', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  recordAudit(db, {
    actorType: 'user',
    actorId: 'owner',
    action: 'security.review',
    result: 'success',
    actorScope: 'explicit-scope',
    details: {
      registryKey: 'dhk_fake-secret-value',
      note: 'Bearer token-value',
      providerApiKey: 'plain-api-key-without-secret-prefix',
      rawCredential: { value: 'plain-credential-without-secret-prefix' },
      reason: 'cookie: session-secret\nAuthorization: Bearer auth-secret\nplain dit_secret-token',
      nested: {
        headers: ['Cookie: nested-cookie', 'proxy-authorization: Bearer proxy-secret'],
      },
    },
  });
  const row = db.prepare("SELECT details FROM audit_events WHERE action='security.review'").get();
  assert.equal(row.details.includes('dhk_fake-secret-value'), false);
  assert.equal(row.details.includes('token-value'), false);
  assert.equal(row.details.includes('session-secret'), false);
  assert.equal(row.details.includes('auth-secret'), false);
  assert.equal(row.details.includes('dit_secret-token'), false);
  assert.equal(row.details.includes('plain-api-key-without-secret-prefix'), false);
  assert.equal(row.details.includes('plain-credential-without-secret-prefix'), false);
  assert.equal(row.details.includes('nested-cookie'), false);
  assert.equal(row.details.includes('proxy-secret'), false);
  const parsed = JSON.parse(row.details);
  assert.equal(parsed.registryKey, '[redacted-secret]');
  assert.equal(parsed.note, 'Bearer [redacted-secret]');
  assert.equal(parsed.providerApiKey, '[redacted-secret]');
  assert.equal(parsed.rawCredential, '[redacted-secret]');
  assert.equal(parsed.reason.includes('[redacted'), true);
  assert.equal(parsed.nested.headers.every((value) => value.includes('[redacted')), true);
  assert.equal(parsed.actorScope, 'explicit-scope');
});

test('响应过期后只保留墓碑且不重复 mutation', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions({ idempotencyResponseTtlMs: 1 }));
  t.after(() => db.close());
  let mutations = 0;
  const args = {
    actorScope: 'user:owner', operation: 'namespace.create', idempotencyKey: 'c'.repeat(32),
    request: { name: 'team' }, mutate: () => ({ statusCode: 201, body: { n: ++mutations } }),
  };
  runIdempotent(db, args);
  db.prepare('UPDATE idempotency_records SET response_expires_at=0').run();
  assert.throws(() => runIdempotent(db, args), (error) => error.code === 'IDEMPOTENCY_RESULT_EXPIRED');
  assert.equal(mutations, 1);
  assert.equal(db.prepare('SELECT encrypted_response FROM idempotency_records').get().encrypted_response, null);
});

test('异步幂等 reservation 支持 pending、完成重放和同 key 异请求冲突', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const args = {
    actorScope: 'user:owner',
    operation: 'user.disable',
    idempotencyKey: 'd'.repeat(32),
    request: { userId: 'alice', reason: 'maintenance' },
  };
  const reserved = beginIdempotentOperation(db, args);
  assert.equal(reserved.kind, 'reserved');
  assert.throws(() => beginIdempotentOperation(db, args), (error) => error.code === 'IDEMPOTENCY_PENDING');
  assert.throws(
    () => beginIdempotentOperation(db, { ...args, request: { userId: 'alice', reason: 'other' } }),
    (error) => error.code === 'IDEMPOTENCY_CONFLICT',
  );

  const completed = completeIdempotentOperation(db, reserved.reservation, () => ({
    statusCode: 200,
    body: { ok: true, groupSync: 'ok' },
  }));
  assert.equal(completed.replayed, false);
  const replay = beginIdempotentOperation(db, args);
  assert.equal(replay.kind, 'replay');
  assert.equal(replay.response.replayed, true);
  assert.deepEqual(replay.response.body, completed.body);
});

test('异步幂等 stale pending 可在重启后安全重新 reservation', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  const args = {
    actorScope: 'user:owner',
    operation: 'user.restore',
    idempotencyKey: 'e'.repeat(32),
    request: { userId: 'alice', reason: 'retry after restart' },
    pendingTtlMs: 1,
  };
  const first = beginIdempotentOperation(db, args);
  assert.equal(first.kind, 'reserved');
  db.prepare('UPDATE idempotency_records SET tombstone_expires_at=0, response_expires_at=0').run();
  db.close();

  const reopened = openDb(dbPath, securityOptions());
  t.after(() => reopened.close());
  const retried = beginIdempotentOperation(reopened, args);
  assert.equal(retried.kind, 'reserved');
  const completed = completeIdempotentOperation(reopened, retried.reservation, () => ({
    statusCode: 200,
    body: { ok: true },
  }));
  assert.deepEqual(completed.body, { ok: true });
});

test('异步幂等 stale pending 被接管后旧 reservation 不能清除或完成新占位', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const args = {
    actorScope: 'user:owner',
    operation: 'user.restore',
    idempotencyKey: 'f'.repeat(32),
    request: { userId: 'alice', reason: 'stale takeover' },
    pendingTtlMs: 1,
  };
  const first = beginIdempotentOperation(db, args);
  assert.equal(first.kind, 'reserved');
  db.prepare('UPDATE idempotency_records SET tombstone_expires_at=0, response_expires_at=0').run();

  const second = beginIdempotentOperation(db, args);
  assert.equal(second.kind, 'reserved');
  assert.notEqual(first.reservation.pendingToken, second.reservation.pendingToken);
  assert.equal(clearPendingIdempotentOperation(db, first.reservation), 0);
  assert.throws(
    () => completeIdempotentOperation(db, first.reservation, () => ({
      statusCode: 200,
      body: { ok: false },
    })),
    (error) => error.code === 'IDEMPOTENCY_NOT_PENDING',
  );

  const completed = completeIdempotentOperation(db, second.reservation, () => ({
    statusCode: 200,
    body: { ok: true },
  }));
  assert.deepEqual(completed.body, { ok: true });
  assert.equal(
    db.prepare('SELECT status_code FROM idempotency_records WHERE actor_scope=? AND operation=?').get(args.actorScope, args.operation).status_code,
    200,
  );
});
