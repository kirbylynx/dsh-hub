import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  createNamespace,
  findRegistryKey,
  getMigrationInfo,
  getSchemaVersion,
  issueInstanceToken,
  openDb,
  registerInstance,
  rotateRegistryKey,
  validateInstanceToken,
} from '../src/db.js';
import { makeInstallationId } from '../src/security.js';
import { createLegacyPrototype, securityOptions, tempDatabase } from './test-helpers.js';

test('fresh schema 使用版本化 migration 且凭据只保存摘要', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());

  assert.equal(getSchemaVersion(db).version, 1);
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });
  assert.match(ns.registryKey, /^dhk_[A-Za-z0-9_-]{32}$/);
  assert.equal(findRegistryKey(db, ns.registryKey)?.namespace_id, ns.namespaceId);
  assert.equal(findRegistryKey(db, `${ns.registryKey}x`), null);

  const columns = db.prepare('PRAGMA table_info(registry_keys)').all().map((row) => row.name);
  assert.equal(columns.includes('secret'), false);
  assert.equal(columns.includes('digest'), true);
  assert.equal(db.prepare('SELECT typeof(digest) AS type FROM registry_keys').get().type, 'blob');
});

test('registry key 更新使用 expectedVersion 且不影响旧提交结果', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });
  const existing = registerInstance(db, {
    namespaceId: ns.namespaceId,
    installationId: makeInstallationId(),
    delivery: 'agent',
  });
  const existingToken = issueInstanceToken(db, existing.id);

  const rotated = rotateRegistryKey(db, ns.namespaceId, { expectedVersion: 1, rotatedBy: 'owner' });
  assert.equal(rotated.version, 2);
  assert.equal(findRegistryKey(db, ns.registryKey), null);
  assert.equal(findRegistryKey(db, ns.registryKey, { includeInactive: true }).status, 'rotated');
  assert.equal(findRegistryKey(db, rotated.registryKey).status, 'active');
  assert.throws(
    () => rotateRegistryKey(db, ns.namespaceId, { expectedVersion: 1, rotatedBy: 'owner' }),
    (error) => error.code === 'REGISTRY_VERSION_CONFLICT',
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM registry_keys WHERE status='active'").get().n, 1);
  assert.equal(validateInstanceToken(db, existing.id, existingToken.instanceToken), true);
});

test('新实例使用稳定 installation ID、DNS-safe instance ID 和摘要 token', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });
  const installationId = makeInstallationId();
  const instance = registerInstance(db, {
    namespaceId: ns.namespaceId,
    installationId,
    delivery: 'agent',
    hostname: 'host',
    clientVersion: '0.1.0',
    dshVersion: '0.1.0-rc.7',
  });
  assert.match(installationId, /^insl_[A-Za-z0-9_-]{22}$/);
  assert.match(instance.id, /^inst-[a-z2-7]{26}$/);
  assert.throws(
    () => registerInstance(db, { namespaceId: ns.namespaceId, installationId, delivery: 'agent' }),
    (error) => error.code === 'INSTANCE_ALREADY_BOUND',
  );

  const token = issueInstanceToken(db, instance.id);
  assert.equal(validateInstanceToken(db, instance.id, token.instanceToken), true);
  assert.equal(validateInstanceToken(db, instance.id, `${token.instanceToken}x`), false);
  assert.equal(token.renewalUntil > token.expiresAt, true);
  const columns = db.prepare('PRAGMA table_info(instance_tokens)').all().map((row) => row.name);
  assert.equal(columns.includes('secret'), false);

  const second = registerInstance(db, {
    namespaceId: ns.namespaceId,
    installationId: makeInstallationId(),
    delivery: 'agent',
  });
  assert.notEqual(second.id, instance.id);
});

test('prototype migration 先备份、保留 namespace/key、归档 legacy instance 并清除主库明文', (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-legacy-');
  const legacy = createLegacyPrototype(dbPath);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());

  const migration = getMigrationInfo(db);
  assert.equal(migration.kind, 'legacy');
  assert.equal(migration.archivedInstances, 1);
  assert.equal(fs.existsSync(migration.backupPath), true);
  assert.equal(fs.statSync(migration.backupPath).mode & 0o777, 0o600);
  assert.equal(findRegistryKey(db, legacy.registryKey)?.namespace_id, 'ns_legacy');
  assert.equal(db.prepare('SELECT count(*) AS n FROM instances').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM legacy_instance_archive').get().n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE sql LIKE '% secret %'").get().n, 0);

  db.pragma('wal_checkpoint(TRUNCATE)');
  const mainBytes = fs.readFileSync(dbPath);
  assert.equal(mainBytes.includes(Buffer.from(legacy.registryKey)), false);
  assert.equal(mainBytes.includes(Buffer.from(legacy.instanceToken)), false);
  const backupBytes = fs.readFileSync(migration.backupPath);
  assert.equal(backupBytes.includes(Buffer.from(legacy.registryKey)), true);
});

test('prototype 迁移拒绝不一致 key 状态且不会改写源库', (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-legacy-invalid-');
  createLegacyPrototype(dbPath);
  const before = new Database(dbPath);
  before.prepare("UPDATE registry_keys SET status='rotated'").run();
  before.close();

  assert.throws(() => openDb(dbPath, securityOptions()), /恰好有一个 active registry key/);

  const after = new Database(dbPath, { readonly: true });
  assert.equal(after.prepare("SELECT status, secret FROM registry_keys").get().status, 'rotated');
  assert.equal(after.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='schema_migration'").get().n, 0);
  after.close();
});
