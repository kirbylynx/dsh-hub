import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialStore, keyringAccountForConfigDir } from '../src/credentials.js';
import { registerWithHub } from '../src/register.js';
import { revokeSelfWithHub, rotateTokenWithHub } from '../src/lifecycle.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-test-'));
}

test('keyring account 随 configDir 隔离', () => {
  const first = keyringAccountForConfigDir('/tmp/a');
  const second = keyringAccountForConfigDir('/tmp/b');
  assert.notEqual(first, second);
  assert.match(first, /^cfg-[0-9a-f]{24}$/);
});

test('file-only 模式保存凭据且安装 ID 稳定', async () => {
  const previousMode = process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
  process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = 'file';

  try {
    const dir = makeTempDir();
    const store = new CredentialStore(dir);
    const installationId = await store.ensureInstallationId();
    const secondRead = await store.ensureInstallationId();
    assert.equal(installationId, secondRead);
    assert.match(installationId, /^insl_[A-Za-z0-9_-]{22}$/);

    await store.save({
      endpoint: 'http://127.0.0.1:18081',
      instanceId: 'inst_demo',
      installationId,
      instanceToken: 'dht_secret',
      delivery: 'agent',
      target: '127.0.0.1:3080',
      hostname: 'tester',
      clientVersion: '0.1.0',
      registryKey: 'dhk_should_not_persist',
    });

    const savedRaw = JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'));
    assert.equal(savedRaw.registryKey, undefined);
    assert.equal(savedRaw.installationId, installationId);
    assert.equal((fs.statSync(path.join(dir, 'credentials.json')).mode & 0o777), 0o600);

    const loaded = await store.load();
    assert.equal(loaded.instanceToken, 'dht_secret');
    assert.equal(loaded.installationId, installationId);
    assert.equal(loaded.registryKey, undefined);
  } finally {
    if (previousMode === undefined) delete process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
    else process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = previousMode;
  }
});

test('register journal 复用幂等键且不落盘 registry key', async () => {
  const previousMode = process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = 'file';

  try {
    const dir = makeTempDir();
    const store = new CredentialStore(dir);
    const installationId = await store.ensureInstallationId();

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    await assert.rejects(
      registerWithHub({
        endpoint: 'http://127.0.0.1:18081/',
        registryKey: 'dhk_super_secret',
        delivery: 'agent',
        hostname: 'tester',
        dshVersion: '1.2.3',
        installationId,
        clientVersion: '0.1.0',
        store,
      }),
      /register failed: network down/,
    );

    const pending = await store.loadPendingRegister();
    assert.ok(pending);
    assert.equal(pending.request.endpoint, 'http://127.0.0.1:18081');
    assert.equal(pending.request.credentialKind, 'registry');
    assert.equal(pending.request.installationId, installationId);
    assert.equal(JSON.stringify(pending).includes('dhk_super_secret'), false);

    let seenHeader = null;
    let seenBody = null;
    globalThis.fetch = async (_url, options) => {
      seenHeader = options.headers['idempotency-key'];
      seenBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Headers(),
        json: async () => ({
          instanceId: 'inst_after_retry',
          instanceToken: 'dht_after_retry',
          instanceTokenExpiresAt: '2026-09-20T00:00:00.000Z',
          instanceTokenRenewalUntil: '2026-09-27T00:00:00.000Z',
        }),
      };
    };

    const body = await registerWithHub({
      endpoint: 'http://127.0.0.1:18081/',
      registryKey: 'dhk_super_secret',
      delivery: 'agent',
      hostname: 'tester',
      dshVersion: '1.2.3',
      installationId,
      clientVersion: '0.1.0',
      store,
    });

    assert.equal(seenHeader, pending.idempotencyKey);
    assert.equal(seenBody.registryKey, 'dhk_super_secret');
    assert.equal(seenBody.installationId, installationId);
    assert.equal(body.instanceId, 'inst_after_retry');
    assert.equal(await store.loadPendingRegister(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
    else process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = previousMode;
  }
});

test('rotate-token journal 不落盘旧 token 且成功后保存新 token', async () => {
  const previousMode = process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = 'file';

  try {
    const dir = makeTempDir();
    const store = new CredentialStore(dir);
    const creds = {
      endpoint: 'http://127.0.0.1:18081/',
      instanceId: 'inst_rotate',
      installationId: 'insl_abcdefghijklmnopQRSTUV',
      instanceToken: 'dht_old_secret',
      delivery: 'agent',
      target: '127.0.0.1:3080',
    };
    await store.save(creds);

    globalThis.fetch = async () => {
      throw new Error('network down');
    };
    await assert.rejects(
      rotateTokenWithHub({ creds, store }),
      /token rotate failed: network down/,
    );
    const pending = await store.loadPendingRotate();
    assert.ok(pending);
    assert.equal(JSON.stringify(pending).includes('dht_old_secret'), false);

    let seenAuth = null;
    let seenIdempotency = null;
    globalThis.fetch = async (_url, options) => {
      seenAuth = options.headers.authorization;
      seenIdempotency = options.headers['idempotency-key'];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          instanceToken: 'dht_new_secret',
          instanceTokenExpiresAt: '2026-09-20T00:00:00.000Z',
          instanceTokenRenewalUntil: '2026-09-27T00:00:00.000Z',
          overlapUntil: '2026-08-21T08:05:00.000Z',
        }),
      };
    };
    await rotateTokenWithHub({ creds, store });
    assert.equal(seenAuth, 'Bearer dht_old_secret');
    assert.equal(seenIdempotency, pending.idempotencyKey);
    assert.equal((await store.load()).instanceToken, 'dht_new_secret');
    assert.equal(await store.loadPendingRotate(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
    else process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = previousMode;
  }
});

test('leave 成功或已 revoked 响应都会清理本地凭据', async () => {
  const previousMode = process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
  const originalFetch = globalThis.fetch;
  process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = 'file';

  try {
    const dir = makeTempDir();
    const store = new CredentialStore(dir);
    const creds = {
      endpoint: 'http://127.0.0.1:18081',
      instanceId: 'inst_leave',
      installationId: 'insl_abcdefghijklmnopQRSTUV',
      instanceToken: 'dht_leave_secret',
      delivery: 'agent',
      target: '127.0.0.1:3080',
    };
    await store.save(creds);
    globalThis.fetch = async () => ({ status: 204, statusText: 'No Content' });
    const first = await revokeSelfWithHub({ creds, store });
    assert.equal(first.alreadyRevoked, false);
    assert.equal(await store.load(), null);

    await store.save(creds);
    globalThis.fetch = async () => ({
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ error: { code: 'TOKEN_REVOKED' } }),
    });
    const retry = await revokeSelfWithHub({ creds, store });
    assert.equal(retry.alreadyRevoked, true);
    assert.equal(await store.load(), null);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousMode === undefined) delete process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE;
    else process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE = previousMode;
  }
});
