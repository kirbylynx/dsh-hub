import assert from 'node:assert/strict';
import fs from 'node:fs';
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
