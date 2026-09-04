import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  addNamespaceMembership,
  countActiveSystemAdmins,
  createNamespace,
  createInvite,
  createInvitePowChallenge,
  beginInviteConsumption,
  consumeInvitePowChallenge,
  ensureHubUser,
  findInviteByToken,
  findRegistryKey,
  getMigrationInfo,
  getNamespaceRole,
  getSchemaVersion,
  getUser,
  isSystemAdmin,
  issueInstanceToken,
  listInvites,
  listNamespaces,
  listUsers,
  markInviteFailed,
  openDb,
  registerInstance,
  revealRegistryKey,
  rotateRegistryKey,
  updateNamespace,
  validateInstanceToken,
} from '../src/db.js';
import { makeInstallationId } from '../src/security.js';
import { createLegacyPrototype, securityOptions, tempDatabase } from './test-helpers.js';

test('fresh schema 使用版本化 migration 且 registry key 可 reveal、token 只保存摘要', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());

  assert.equal(getSchemaVersion(db).version, 4);
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });
  assert.match(ns.registryKey, /^dhk_[A-Za-z0-9_-]{32}$/);
  assert.equal(findRegistryKey(db, ns.registryKey)?.namespace_id, ns.namespaceId);
  assert.equal(findRegistryKey(db, `${ns.registryKey}x`), null);

  const columns = db.prepare('PRAGMA table_info(registry_keys)').all().map((row) => row.name);
  assert.equal(columns.includes('secret'), true);
  assert.equal(columns.includes('secret_available'), true);
  assert.equal(columns.includes('digest'), true);
  const instanceColumns = db.prepare('PRAGMA table_info(instances)').all().map((row) => row.name);
  assert.equal(instanceColumns.includes('deployment_mode'), true);
  const membershipColumns = db.prepare('PRAGMA table_info(namespace_memberships)').all().map((row) => row.name);
  assert.equal(membershipColumns.includes('role'), true);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_namespaces_owner_normalized_name'").get().n,
    1,
  );
  assert.equal(db.prepare('SELECT typeof(digest) AS type FROM registry_keys').get().type, 'blob');
  const registryRow = db.prepare('SELECT secret, secret_available FROM registry_keys WHERE namespace_id=?').get(ns.namespaceId);
  assert.equal(registryRow.secret, ns.registryKey);
  assert.equal(registryRow.secret_available, 1);
  assert.equal(getUser(db, 'owner').status, 'active');
  assert.equal(isSystemAdmin(db, 'owner'), true);
  assert.equal(countActiveSystemAdmins(db), 1);
  assert.equal(getNamespaceRole(db, 'owner', ns.namespaceId), 'namespace_owner');
  assert.equal(revealRegistryKey(db, ns.namespaceId).registryKey, ns.registryKey);
});

test('G3 namespace 名称按 owner 大小写不敏感唯一，不同 owner 可同名', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());

  const ownerOne = createNamespace(db, { name: ' MacMini ', ownerUserId: 'owner' });
  assert.equal(ownerOne.name, 'MacMini');
  assert.throws(
    () => createNamespace(db, { name: 'macmini', ownerUserId: 'owner' }),
    (error) => error.code === 'NAMESPACE_NAME_CONFLICT',
  );

  const alice = createNamespace(db, { name: 'macmini', ownerUserId: 'alice' });
  assert.notEqual(alice.namespaceId, ownerOne.namespaceId);
  assert.equal(listNamespaces(db, 'owner', { scope: 'mine' }).some((row) => row.id === ownerOne.namespaceId), true);
  assert.equal(listNamespaces(db, 'alice', { scope: 'mine' }).some((row) => row.id === alice.namespaceId), true);
  const aliceOther = createNamespace(db, { name: 'desk', ownerUserId: 'alice' });

  assert.throws(
    () => updateNamespace(db, { namespaceId: aliceOther.namespaceId, name: 'MacMini', updatedBy: 'alice' }),
    (error) => error.code === 'NAMESPACE_NAME_CONFLICT',
  );
});

test('G3 用户列表游标与同时间戳排序保持一致', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  for (const username of ['alice', 'bob', 'carol']) ensureHubUser(db, { username });
  db.prepare('UPDATE users SET created_at=?').run(100);

  const first = listUsers(db, { limit: 2 });
  assert.deepEqual(first.map((row) => row.id), ['owner', 'carol']);
  const second = listUsers(db, {
    limit: 2,
    cursor: { createdAt: first[1].created_at, id: first[1].id },
  });
  assert.deepEqual(second.map((row) => row.id), ['bob', 'alice']);
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
  assert.equal(revealRegistryKey(db, ns.namespaceId).registryKey, rotated.registryKey);
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
    deploymentMode: 'hosted',
    hostname: 'host',
    clientVersion: '0.1.0',
    dshVersion: '0.1.0-rc.7',
  });
  assert.match(installationId, /^insl_[A-Za-z0-9_-]{22}$/);
  assert.match(instance.id, /^inst-[a-z2-7]{26}$/);
  assert.equal(instance.deployment_mode, 'hosted');
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

test('prototype migration 先备份、保留 namespace/key、归档 legacy instance 并清除主库 instance token 明文', (t) => {
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
  assert.equal(db.prepare("SELECT secret_available FROM registry_keys WHERE namespace_id='ns_legacy'").get().secret_available, 1);

  db.pragma('wal_checkpoint(TRUNCATE)');
  const mainBytes = fs.readFileSync(dbPath);
  assert.equal(mainBytes.includes(Buffer.from(legacy.registryKey)), true);
  assert.equal(mainBytes.includes(Buffer.from(legacy.instanceToken)), false);
  const backupBytes = fs.readFileSync(migration.backupPath);
  assert.equal(backupBytes.includes(Buffer.from(legacy.registryKey)), true);
});

test('prototype migration 遇到同 owner 同名 namespace 时保留旧数据并跳过唯一索引', (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-legacy-duplicate-');
  createLegacyPrototype(dbPath);
  const legacy = new Database(dbPath);
  legacy.prepare('INSERT INTO namespaces VALUES (?,?,?,?)').run('ns_legacy_duplicate', 'Legacy', 'owner', 2);
  legacy.prepare('INSERT INTO registry_keys VALUES (?,?,?,?,?,NULL)')
    .run('rk_legacy_duplicate', 'ns_legacy_duplicate', 'dhk_legacy-registry-secret-duplicate', 'active', 3);
  legacy.close();

  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());

  assert.equal(getMigrationInfo(db).kind, 'legacy');
  assert.equal(db.prepare("SELECT count(*) AS n FROM namespaces WHERE owner_user_id='owner' AND normalized_name='legacy'").get().n, 2);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_namespaces_owner_normalized_name'").get().n,
    0,
  );
  assert.throws(
    () => createNamespace(db, { name: 'legacy', ownerUserId: 'owner' }),
    (error) => error.code === 'NAMESPACE_NAME_CONFLICT',
  );
});

test('v3 fixture migration 升级到 v4，回填 G3 字段、生成 0600 备份且二次打开幂等', (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-v3-');
  createSchemaV3Fixture(dbPath);

  const db = openDb(dbPath, securityOptions());
  assert.equal(getMigrationInfo(db).kind, 'v3-to-v4');
  assert.equal(getSchemaVersion(db).version, 4);
  const migration = getMigrationInfo(db);
  assert.equal(fs.existsSync(migration.backupPath), true);
  assert.equal(fs.statSync(migration.backupPath).mode & 0o777, 0o600);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_namespaces_owner_normalized_name'").get().n,
    1,
  );
  const namespace = db.prepare("SELECT * FROM namespaces WHERE id='ns_v3_owner'").get();
  assert.equal(namespace.description, null);
  assert.equal(namespace.normalized_name, 'team');
  assert.equal(namespace.updated_at, namespace.created_at);
  assert.equal(namespace.updated_by, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM users WHERE id IN (?,?)').get('owner', 'alice').n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM system_admins WHERE user_id='owner'").get().n, 1);
  assert.equal(db.prepare("SELECT role FROM namespace_memberships WHERE id='nm_v3_owner'").get().role, 'namespace_owner');
  const registry = db.prepare("SELECT secret, secret_available, version FROM registry_keys WHERE id='rk_v3_owner'").get();
  assert.equal(registry.secret, null);
  assert.equal(registry.secret_available, 0);
  assert.equal(registry.version, 1);
  assert.equal(db.prepare("SELECT deployment_mode FROM instances WHERE id='inst-v3'").get().deployment_mode, 'remote');
  const instanceToken = db.prepare("SELECT * FROM instance_tokens WHERE id='it_v3_owner'").get();
  assert.deepEqual(Buffer.from(instanceToken.digest), Buffer.alloc(32, 4));
  assert.equal(instanceToken.instance_id, 'inst-v3');
  assert.equal(instanceToken.pepper_key_id, 'pepper-v1');
  assert.equal(instanceToken.prefix, 'dit_v3');
  assert.equal(instanceToken.expires_at, 3600);
  const acl = db.prepare("SELECT * FROM instance_acl WHERE id='acl_v3_owner_alice'").get();
  assert.equal(acl.instance_id, 'inst-v3');
  assert.equal(acl.user_id, 'alice');
  assert.equal(acl.permission, 'view');
  assert.equal(acl.status, 'active');
  const invite = db.prepare("SELECT * FROM invites WHERE id='inv_v3_owner'").get();
  assert.deepEqual(Buffer.from(invite.token_digest), Buffer.alloc(32, 5));
  assert.equal(invite.token_pepper_key_id, 'pepper-v1');
  assert.equal(invite.token_prefix, 'dhi_v3');
  assert.equal(invite.namespace_id, 'ns_v3_owner');
  assert.equal(invite.role, 'member');
  assert.equal(invite.status, 'active');
  const challenge = db.prepare("SELECT * FROM invite_pow_challenges WHERE id='pow_v3_owner'").get();
  assert.deepEqual(Buffer.from(challenge.invite_digest), Buffer.alloc(32, 5));
  assert.equal(challenge.challenge, 'pow-challenge-v3');
  assert.equal(challenge.difficulty, 4);
  const replacement = db.prepare("SELECT * FROM replacement_grants WHERE id='rg_v3_owner'").get();
  assert.deepEqual(Buffer.from(replacement.digest), Buffer.alloc(32, 6));
  assert.equal(replacement.instance_id, 'inst-v3');
  assert.equal(replacement.status, 'outstanding');
  const idempotency = db.prepare("SELECT * FROM idempotency_records WHERE actor_scope='user:owner'").get();
  assert.deepEqual(Buffer.from(idempotency.key_digest), Buffer.alloc(32, 7));
  assert.deepEqual(Buffer.from(idempotency.request_digest), Buffer.alloc(32, 8));
  assert.deepEqual(Buffer.from(idempotency.encrypted_response), Buffer.from('v3-idempotency-response'));
  assert.equal(idempotency.status_code, 201);
  assert.equal(idempotency.encryption_key_id, 'idem-v1');
  const legacyArchive = db.prepare("SELECT * FROM legacy_instance_archive WHERE legacy_id='legacy-v3-owner'").get();
  assert.equal(legacyArchive.namespace_id, 'ns_v3_owner');
  assert.equal(legacyArchive.reason, 'fixture coverage');
  const audit = db.prepare("SELECT * FROM audit_events WHERE id='aud_v3_owner'").get();
  assert.equal(audit.target_user_id, 'alice');
  assert.equal(audit.invite_id, 'inv_v3_owner');
  assert.deepEqual(JSON.parse(audit.details), { fixture: 'v3', preserved: true });
  db.close();

  const backup = new Database(migration.backupPath, { readonly: true });
  try {
    assert.equal(backup.prepare('SELECT version FROM schema_migration').get().version, 3);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM users WHERE id IN ('owner','alice')").get().n, 2);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM system_admins WHERE user_id='owner'").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM namespace_memberships WHERE id='nm_v3_owner'").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM instance_tokens WHERE id='it_v3_owner'").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM invites WHERE id='inv_v3_owner'").get().n, 1);
    assert.equal(backup.prepare("SELECT count(*) AS n FROM idempotency_records WHERE actor_scope='user:owner'").get().n, 1);
  } finally {
    backup.close();
  }

  const reopened = openDb(dbPath, securityOptions());
  t.after(() => reopened.close());
  assert.equal(getMigrationInfo(reopened).kind, 'none');
  assert.equal(getSchemaVersion(reopened).version, 4);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM schema_migration WHERE version=4").get().n, 1);
  assert.equal(fs.readdirSync(path.join(path.dirname(dbPath), 'backups')).filter((name) => name.includes('pre-migration')).length, 1);
});

test('v3 fixture migration 遇到同 owner 规范化重名时保留数据并跳过唯一索引', (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-v3-duplicate-');
  createSchemaV3Fixture(dbPath, { duplicateOwnerName: true });

  const db = openDb(dbPath, securityOptions());
  assert.equal(getMigrationInfo(db).kind, 'v3-to-v4');
  assert.equal(db.prepare("SELECT count(*) AS n FROM namespaces WHERE owner_user_id='owner' AND normalized_name='team'").get().n, 2);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_namespaces_owner_normalized_name'").get().n,
    0,
  );
  assert.throws(
    () => createNamespace(db, { name: ' TEAM ', ownerUserId: 'owner' }),
    (error) => error.code === 'NAMESPACE_NAME_CONFLICT',
  );
  db.close();

  const reopened = openDb(dbPath, securityOptions());
  t.after(() => reopened.close());
  assert.equal(getMigrationInfo(reopened).kind, 'none');
  assert.equal(
    reopened.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND name='uq_namespaces_owner_normalized_name'").get().n,
    0,
  );
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

test('G2 用户、成员和邀请凭据使用摘要并保留 pepper key 信息', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });
  ensureHubUser(db, { username: 'alice', email: 'alice@example.com', displayName: 'Alice' });

  const member = addNamespaceMembership(db, {
    namespaceId: ns.namespaceId,
    userId: 'alice',
    role: 'member',
    createdBy: 'owner',
  });
  assert.equal(member.role, 'member');
  assert.equal(getNamespaceRole(db, 'alice', ns.namespaceId), 'member');

  const invite = createInvite(db, {
    namespaceId: ns.namespaceId,
    role: 'viewer',
    emailHint: 'viewer@example.com',
    createdBy: 'owner',
  });
  assert.match(invite.token, /^dhi_[A-Za-z0-9_-]{32}$/);
  const inviteRow = db.prepare('SELECT token_digest, token_pepper_key_id, token_prefix FROM invites WHERE id=?').get(invite.inviteId);
  assert.equal(inviteRow.token_digest.includes(invite.token), false);
  assert.equal(inviteRow.token_pepper_key_id, 'pepper-v1');
  assert.equal(invite.token.startsWith(inviteRow.token_prefix), true);
  assert.equal(findInviteByToken(db, invite.token)?.id, invite.inviteId);
  assert.equal(findInviteByToken(db, `${invite.token}x`), null);

  const challenge = createInvitePowChallenge(db, { inviteToken: invite.token, difficulty: 0 });
  consumeInvitePowChallenge(db, { challengeId: challenge.id, inviteToken: invite.token });
  assert.throws(
    () => consumeInvitePowChallenge(db, { challengeId: challenge.id, inviteToken: invite.token }),
    (error) => error.code === 'POW_INVALID',
  );
});

test('G2 可重试或卡住的邀请过期后会归档为 expired', (t) => {
  const { dbPath } = tempDatabase(t);
  const db = openDb(dbPath, securityOptions());
  t.after(() => db.close());
  const ns = createNamespace(db, { name: 'team', ownerUserId: 'owner' });

  const retryable = createInvite(db, {
    namespaceId: ns.namespaceId,
    role: 'member',
    createdBy: 'owner',
  });
  db.prepare('UPDATE invites SET expires_at=? WHERE id=?').run(Date.now() - 1, retryable.inviteId);
  markInviteFailed(db, retryable.inviteId, 'LLDAP_TIMEOUT');

  const staleConsuming = createInvite(db, {
    namespaceId: ns.namespaceId,
    role: 'viewer',
    createdBy: 'owner',
  });
  beginInviteConsumption(db, { token: staleConsuming.token });
  db.prepare('UPDATE invites SET expires_at=?, consuming_until=? WHERE id=?')
    .run(Date.now() - 1, Date.now() - 1, staleConsuming.inviteId);

  const statuses = new Map(listInvites(db, ns.namespaceId).map((row) => [row.id, row]));
  assert.equal(statuses.get(retryable.inviteId).status, 'expired');
  assert.equal(statuses.get(staleConsuming.inviteId).status, 'expired');
  assert.equal(statuses.get(staleConsuming.inviteId).failure_code, 'CONSUME_TIMEOUT');
  assert.equal(findInviteByToken(db, retryable.token), null);
  assert.equal(findInviteByToken(db, staleConsuming.token), null);
});

function createSchemaV3Fixture(dbPath, { duplicateOwnerName = false } = {}) {
  const db = new Database(dbPath);
  const checksum = crypto.createHash('sha256').update('dsh-hub-g2-schema-v3').digest('hex');
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE schema_migration (
      version       INTEGER PRIMARY KEY,
      applied_at    INTEGER NOT NULL,
      checksum      TEXT NOT NULL
    );
    CREATE TABLE namespaces (
      id             TEXT PRIMARY KEY,
      owner_user_id  TEXT NOT NULL,
      name           TEXT NOT NULL,
      created_at     INTEGER NOT NULL
    );
    CREATE TABLE users (
      id                 TEXT PRIMARY KEY,
      external_provider  TEXT NOT NULL,
      external_subject   TEXT NOT NULL,
      username           TEXT NOT NULL,
      email              TEXT,
      display_name       TEXT,
      status             TEXT NOT NULL CHECK(status IN ('active', 'disabled')),
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      UNIQUE(external_provider, external_subject),
      UNIQUE(username)
    );
    CREATE TABLE system_admins (
      user_id     TEXT PRIMARY KEY REFERENCES users(id),
      created_at  INTEGER NOT NULL,
      created_by  TEXT,
      reason      TEXT
    );
    CREATE TABLE namespace_memberships (
      id            TEXT PRIMARY KEY,
      namespace_id  TEXT NOT NULL REFERENCES namespaces(id),
      user_id       TEXT NOT NULL REFERENCES users(id),
      role          TEXT NOT NULL CHECK(role IN ('namespace_owner', 'namespace_admin', 'member', 'viewer')),
      status        TEXT NOT NULL CHECK(status IN ('active', 'removed')),
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      created_by    TEXT,
      removed_at    INTEGER,
      removed_by    TEXT,
      UNIQUE(namespace_id, user_id)
    );
    CREATE INDEX idx_namespace_memberships_user
      ON namespace_memberships(user_id, status);
    CREATE INDEX idx_namespace_memberships_namespace
      ON namespace_memberships(namespace_id, status);
    CREATE TABLE invites (
      id                   TEXT PRIMARY KEY,
      token_digest          BLOB NOT NULL UNIQUE,
      token_pepper_key_id   TEXT,
      token_prefix          TEXT,
      namespace_id          TEXT NOT NULL REFERENCES namespaces(id),
      role                  TEXT NOT NULL CHECK(role IN ('namespace_admin', 'member', 'viewer')),
      email_hint            TEXT,
      status                TEXT NOT NULL CHECK(status IN ('active', 'consuming', 'consumed', 'revoked', 'expired', 'failed_retryable', 'failed_needs_admin')),
      expires_at            INTEGER NOT NULL,
      created_at            INTEGER NOT NULL,
      created_by            TEXT NOT NULL REFERENCES users(id),
      consumed_at           INTEGER,
      consumed_by_user_id   TEXT REFERENCES users(id),
      revoked_at            INTEGER,
      revoked_by            TEXT REFERENCES users(id),
      attempt_id            TEXT,
      consuming_until       INTEGER,
      failure_code          TEXT
    );
    CREATE INDEX idx_invites_namespace
      ON invites(namespace_id, status, created_at);
    CREATE INDEX idx_invites_prefix
      ON invites(token_prefix);
    CREATE TABLE invite_pow_challenges (
      id             TEXT PRIMARY KEY,
      invite_digest  BLOB NOT NULL,
      challenge      TEXT NOT NULL,
      difficulty     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL,
      consumed_at    INTEGER,
      created_at     INTEGER NOT NULL,
      ip_hash        TEXT
    );
    CREATE INDEX idx_invite_pow_challenges_digest
      ON invite_pow_challenges(invite_digest, expires_at);
    CREATE TABLE instance_acl (
      id           TEXT PRIMARY KEY,
      instance_id  TEXT NOT NULL REFERENCES instances(id),
      user_id      TEXT NOT NULL REFERENCES users(id),
      permission   TEXT NOT NULL,
      status       TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
      created_at   INTEGER NOT NULL,
      created_by   TEXT,
      UNIQUE(instance_id, user_id, permission)
    );
    CREATE TABLE registry_keys (
      id             TEXT PRIMARY KEY,
      namespace_id   TEXT NOT NULL REFERENCES namespaces(id),
      digest         BLOB NOT NULL,
      pepper_key_id  TEXT NOT NULL,
      prefix         TEXT NOT NULL,
      version        INTEGER NOT NULL CHECK(version > 0),
      status         TEXT NOT NULL CHECK(status IN ('active', 'rotated')),
      issued_at      INTEGER NOT NULL,
      rotated_at     INTEGER,
      rotated_by     TEXT,
      UNIQUE(namespace_id, version)
    );
    CREATE INDEX idx_registry_keys_prefix ON registry_keys(prefix);
    CREATE UNIQUE INDEX uq_registry_keys_one_active
      ON registry_keys(namespace_id) WHERE status = 'active';
    CREATE TABLE instances (
      id                    TEXT PRIMARY KEY,
      namespace_id          TEXT NOT NULL REFERENCES namespaces(id),
      installation_id       TEXT NOT NULL,
      delivery              TEXT NOT NULL CHECK(delivery IN ('agent', 'plugin')),
      deployment_mode       TEXT CHECK(deployment_mode IN ('hosted', 'remote') OR deployment_mode IS NULL),
      hostname              TEXT,
      client_version        TEXT,
      dsh_version           TEXT,
      state                 TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
      last_seen_at          INTEGER,
      last_dsh_online       INTEGER,
      last_dsh_observed_at  INTEGER,
      created_at            INTEGER NOT NULL,
      UNIQUE(namespace_id, installation_id)
    );
    CREATE INDEX idx_instances_namespace ON instances(namespace_id);
    CREATE TABLE instance_tokens (
      id                    TEXT PRIMARY KEY,
      instance_id           TEXT NOT NULL REFERENCES instances(id),
      digest                BLOB NOT NULL,
      pepper_key_id         TEXT NOT NULL,
      prefix                TEXT NOT NULL,
      issued_at             INTEGER NOT NULL,
      expires_at            INTEGER NOT NULL,
      renewal_until         INTEGER NOT NULL,
      rotated_at            INTEGER,
      rotated_to_token_id   TEXT REFERENCES instance_tokens(id),
      overlap_until         INTEGER,
      revoked_at            INTEGER,
      revoke_reason         TEXT
    );
    CREATE INDEX idx_instance_tokens_lookup
      ON instance_tokens(instance_id, prefix);
    CREATE TABLE replacement_grants (
      id               TEXT PRIMARY KEY,
      instance_id      TEXT NOT NULL REFERENCES instances(id),
      installation_id  TEXT NOT NULL,
      digest           BLOB NOT NULL,
      pepper_key_id    TEXT NOT NULL,
      prefix           TEXT NOT NULL,
      status           TEXT NOT NULL CHECK(status IN ('outstanding', 'used', 'superseded')),
      expires_at       INTEGER NOT NULL,
      used_at          INTEGER,
      superseded_at    INTEGER,
      issued_by        TEXT NOT NULL,
      reason           TEXT NOT NULL,
      created_at       INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX uq_replacement_grants_one_outstanding
      ON replacement_grants(instance_id) WHERE status = 'outstanding';
    CREATE TABLE idempotency_records (
      actor_scope            TEXT NOT NULL,
      operation              TEXT NOT NULL,
      key_digest             BLOB NOT NULL,
      request_digest         BLOB NOT NULL,
      status_code            INTEGER NOT NULL,
      encrypted_response     BLOB,
      encryption_key_id      TEXT,
      response_expires_at    INTEGER NOT NULL,
      tombstone_expires_at   INTEGER NOT NULL,
      created_at             INTEGER NOT NULL,
      PRIMARY KEY(actor_scope, operation, key_digest)
    );
    CREATE INDEX idx_idempotency_tombstone
      ON idempotency_records(tombstone_expires_at);
    CREATE TABLE legacy_instance_archive (
      legacy_id       TEXT PRIMARY KEY,
      namespace_id    TEXT NOT NULL REFERENCES namespaces(id),
      delivery        TEXT,
      hostname        TEXT,
      dsh_version     TEXT,
      last_seen_at    INTEGER,
      archived_at     INTEGER NOT NULL,
      reason          TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      id            TEXT PRIMARY KEY,
      time          INTEGER NOT NULL,
      actor_type    TEXT NOT NULL,
      actor_id      TEXT,
      namespace_id  TEXT,
      instance_id   TEXT,
      target_user_id TEXT,
      invite_id     TEXT,
      action        TEXT NOT NULL,
      result        TEXT NOT NULL,
      request_id    TEXT,
      details       TEXT
    );
  `);
  db.prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?,?,?)')
    .run(3, 100, checksum);
  const insertUser = db.prepare(`
    INSERT INTO users
      (id, external_provider, external_subject, username, email, display_name, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  insertUser.run('owner', 'authelia', 'owner', 'owner', 'owner@example.com', 'Owner', 'active', 100, 100);
  insertUser.run('alice', 'authelia', 'alice', 'alice', 'alice@example.com', 'Alice', 'active', 101, 101);
  db.prepare('INSERT INTO system_admins (user_id, created_at, created_by, reason) VALUES (?,?,?,?)')
    .run('owner', 100, 'bootstrap', 'fixture');
  const insertNamespace = db.prepare('INSERT INTO namespaces (id, owner_user_id, name, created_at) VALUES (?,?,?,?)');
  insertNamespace.run('ns_v3_owner', 'owner', ' Team ', 110);
  insertNamespace.run('ns_v3_alice', 'alice', 'team', 111);
  if (duplicateOwnerName) insertNamespace.run('ns_v3_owner_duplicate', 'owner', 'team', 112);
  const insertMembership = db.prepare(`
    INSERT INTO namespace_memberships
      (id, namespace_id, user_id, role, status, created_at, updated_at, created_by)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  insertMembership.run('nm_v3_owner', 'ns_v3_owner', 'owner', 'namespace_owner', 'active', 110, 110, 'owner');
  insertMembership.run('nm_v3_alice', 'ns_v3_alice', 'alice', 'namespace_owner', 'active', 111, 111, 'alice');
  if (duplicateOwnerName) {
    insertMembership.run('nm_v3_owner_duplicate', 'ns_v3_owner_duplicate', 'owner', 'namespace_owner', 'active', 112, 112, 'owner');
  }
  const insertRegistryKey = db.prepare(`
    INSERT INTO registry_keys
      (id, namespace_id, digest, pepper_key_id, prefix, version, status, issued_at, rotated_at, rotated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  insertRegistryKey.run('rk_v3_owner', 'ns_v3_owner', Buffer.alloc(32, 1), 'pepper-v1', 'dhk_v3', 1, 'active', 110, null, null);
  insertRegistryKey.run('rk_v3_alice', 'ns_v3_alice', Buffer.alloc(32, 2), 'pepper-v1', 'dhk_v3a', 1, 'active', 111, null, null);
  if (duplicateOwnerName) {
    insertRegistryKey.run('rk_v3_owner_duplicate', 'ns_v3_owner_duplicate', Buffer.alloc(32, 3), 'pepper-v1', 'dhk_v3d', 1, 'active', 112, null, null);
  }
  db.prepare(`
    INSERT INTO instances
      (id, namespace_id, installation_id, delivery, deployment_mode, hostname, client_version, dsh_version, state, last_seen_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `).run('inst-v3', 'ns_v3_owner', 'insl_v3', 'plugin', 'remote', 'macmini', '0.1.5', '0.1.0', 'active', 120, 110);
  db.prepare(`
    INSERT INTO instance_tokens
      (id, instance_id, digest, pepper_key_id, prefix, issued_at, expires_at, renewal_until,
       rotated_at, rotated_to_token_id, overlap_until, revoked_at, revoke_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run('it_v3_owner', 'inst-v3', Buffer.alloc(32, 4), 'pepper-v1', 'dit_v3', 120, 3600, 7200, null, null, null, null, null);
  db.prepare(`
    INSERT INTO instance_acl
      (id, instance_id, user_id, permission, status, created_at, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run('acl_v3_owner_alice', 'inst-v3', 'alice', 'view', 'active', 121, 'owner');
  db.prepare(`
    INSERT INTO invites
      (id, token_digest, token_pepper_key_id, token_prefix, namespace_id, role, email_hint, status,
       expires_at, created_at, created_by, consumed_at, consumed_by_user_id, revoked_at, revoked_by,
       attempt_id, consuming_until, failure_code)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'inv_v3_owner',
    Buffer.alloc(32, 5),
    'pepper-v1',
    'dhi_v3',
    'ns_v3_owner',
    'member',
    'alice@example.com',
    'active',
    86_400,
    122,
    'owner',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  );
  db.prepare(`
    INSERT INTO invite_pow_challenges
      (id, invite_digest, challenge, difficulty, expires_at, consumed_at, created_at, ip_hash)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('pow_v3_owner', Buffer.alloc(32, 5), 'pow-challenge-v3', 4, 180, null, 123, 'iphash-v3');
  db.prepare(`
    INSERT INTO replacement_grants
      (id, instance_id, installation_id, digest, pepper_key_id, prefix, status, expires_at,
       used_at, superseded_at, issued_by, reason, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'rg_v3_owner',
    'inst-v3',
    'insl_v3_replacement',
    Buffer.alloc(32, 6),
    'pepper-v1',
    'drg_v3',
    'outstanding',
    86_400,
    null,
    null,
    'owner',
    'fixture replacement',
    124,
  );
  db.prepare(`
    INSERT INTO idempotency_records
      (actor_scope, operation, key_digest, request_digest, status_code, encrypted_response,
       encryption_key_id, response_expires_at, tombstone_expires_at, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    'user:owner',
    'invite.create',
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 8),
    201,
    Buffer.from('v3-idempotency-response'),
    'idem-v1',
    9_999_999_999_000,
    9_999_999_999_999,
    125,
  );
  db.prepare(`
    INSERT INTO legacy_instance_archive
      (legacy_id, namespace_id, delivery, hostname, dsh_version, last_seen_at, archived_at, reason)
    VALUES (?,?,?,?,?,?,?,?)
  `).run('legacy-v3-owner', 'ns_v3_owner', 'agent', 'legacy-host', '0.0.1', 99, 126, 'fixture coverage');
  db.prepare(`
    INSERT INTO audit_events
      (id, time, actor_type, actor_id, namespace_id, instance_id, target_user_id, invite_id,
       action, result, request_id, details)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'aud_v3_owner',
    127,
    'user',
    'owner',
    'ns_v3_owner',
    'inst-v3',
    'alice',
    'inv_v3_owner',
    'invite_create',
    'ok',
    'req-v3',
    JSON.stringify({ fixture: 'v3', preserved: true }),
  );
  db.close();
}
