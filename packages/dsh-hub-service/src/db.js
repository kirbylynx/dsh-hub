import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  canonicalJson,
  credentialDigest,
  credentialPrefix,
  decryptJson,
  encryptJson,
  makeCredential,
  makeInstanceId,
  sha256,
  validateIdempotencyKey,
  verifyCredential,
} from './security.js';
import { now, rid } from './util.js';

const SCHEMA_VERSION_V1 = 1;
const SCHEMA_CHECKSUM_V1 = crypto.createHash('sha256').update('dsh-hub-m1a1-schema-v1').digest('hex');
const SCHEMA_VERSION_V2 = 2;
const SCHEMA_CHECKSUM_V2 = crypto.createHash('sha256').update('dsh-hub-g13-schema-v2').digest('hex');
const SCHEMA_VERSION = 3;
const SCHEMA_CHECKSUM = crypto.createHash('sha256').update('dsh-hub-g2-schema-v3').digest('hex');
const DB_CONTEXT = new WeakMap();
const DEPLOYMENT_MODES = new Set(['hosted', 'remote']);
const NAMESPACE_ROLES = new Set(['namespace_owner', 'namespace_admin', 'member', 'viewer']);

const TARGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migration (
  version       INTEGER PRIMARY KEY,
  applied_at    INTEGER NOT NULL,
  checksum      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS namespaces (
  id             TEXT PRIMARY KEY,
  owner_user_id  TEXT NOT NULL,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS system_admins (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  created_by  TEXT,
  reason      TEXT
);

CREATE TABLE IF NOT EXISTS namespace_memberships (
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
CREATE INDEX IF NOT EXISTS idx_namespace_memberships_user
  ON namespace_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS idx_namespace_memberships_namespace
  ON namespace_memberships(namespace_id, status);

CREATE TABLE IF NOT EXISTS invites (
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
CREATE INDEX IF NOT EXISTS idx_invites_namespace
  ON invites(namespace_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_invites_prefix
  ON invites(token_prefix);

CREATE TABLE IF NOT EXISTS invite_pow_challenges (
  id             TEXT PRIMARY KEY,
  invite_digest  BLOB NOT NULL,
  challenge      TEXT NOT NULL,
  difficulty     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  consumed_at    INTEGER,
  created_at     INTEGER NOT NULL,
  ip_hash        TEXT
);
CREATE INDEX IF NOT EXISTS idx_invite_pow_challenges_digest
  ON invite_pow_challenges(invite_digest, expires_at);

CREATE TABLE IF NOT EXISTS instance_acl (
  id           TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL REFERENCES instances(id),
  user_id      TEXT NOT NULL REFERENCES users(id),
  permission   TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  created_at   INTEGER NOT NULL,
  created_by   TEXT,
  UNIQUE(instance_id, user_id, permission)
);

CREATE TABLE IF NOT EXISTS registry_keys (
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
CREATE INDEX IF NOT EXISTS idx_registry_keys_prefix ON registry_keys(prefix);
CREATE UNIQUE INDEX IF NOT EXISTS uq_registry_keys_one_active
  ON registry_keys(namespace_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS instances (
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
CREATE INDEX IF NOT EXISTS idx_instances_namespace ON instances(namespace_id);

CREATE TABLE IF NOT EXISTS instance_tokens (
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
CREATE INDEX IF NOT EXISTS idx_instance_tokens_lookup
  ON instance_tokens(instance_id, prefix);

CREATE TABLE IF NOT EXISTS replacement_grants (
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_replacement_grants_one_outstanding
  ON replacement_grants(instance_id) WHERE status = 'outstanding';

CREATE TABLE IF NOT EXISTS idempotency_records (
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
CREATE INDEX IF NOT EXISTS idx_idempotency_tombstone
  ON idempotency_records(tombstone_expires_at);

CREATE TABLE IF NOT EXISTS legacy_instance_archive (
  legacy_id       TEXT PRIMARY KEY,
  namespace_id    TEXT NOT NULL REFERENCES namespaces(id),
  delivery        TEXT,
  hostname        TEXT,
  dsh_version     TEXT,
  last_seen_at    INTEGER,
  archived_at     INTEGER NOT NULL,
  reason          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
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
`;

export class DbError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.status = status;
  }
}

export function normalizeDeploymentMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return DEPLOYMENT_MODES.has(text) ? text : null;
}

export function publicDeploymentMode(value) {
  return normalizeDeploymentMode(value) ?? 'unknown';
}

export function openDb(dbPath, options) {
  validateDbOptions(options);
  const absolutePath = dbPath === ':memory:' ? dbPath : path.resolve(dbPath);
  if (absolutePath !== ':memory:') fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

  const db = new Database(absolutePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  db.pragma('secure_delete = ON');
  if (absolutePath !== ':memory:') fs.chmodSync(absolutePath, 0o600);

  const context = {
    ...options,
    dbPath: absolutePath,
    migration: { kind: 'none', backupPath: null, archivedInstances: 0 },
  };
  DB_CONTEXT.set(db, context);
  try {
    migrate(db, context);
    ensureG2Bootstrap(db, context);
    pruneIdempotencyRecords(db);
    return db;
  } catch (error) {
    DB_CONTEXT.delete(db);
    db.close();
    throw error;
  }
}

function validateDbOptions(options) {
  if (!options?.tokenPepperKeyring?.has(options.currentTokenPepperKeyId)) {
    throw new Error('缺少有效的 token pepper keyring/current key ID');
  }
  if (!options?.idempotencyEncryptionKeyring?.has(options.currentIdempotencyEncryptionKeyId)) {
    throw new Error('缺少有效的 idempotency encryption keyring/current key ID');
  }
}

function migrate(db, context) {
  const hasNamespaces = tableExists(db, 'namespaces');
  const hasRegistryKeys = tableExists(db, 'registry_keys');
  const registryColumns = hasRegistryKeys ? columnNames(db, 'registry_keys') : new Set();
  const isLegacy = hasNamespaces && hasRegistryKeys && registryColumns.has('secret');

  if (isLegacy) {
    context.migration = migrateLegacyPrototype(db, context);
    return;
  }

  if (!hasNamespaces && !hasRegistryKeys) {
    db.transaction(() => {
      db.exec(TARGET_SCHEMA);
      db.prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?,?,?)')
        .run(SCHEMA_VERSION, now(), SCHEMA_CHECKSUM);
    })();
    context.migration = { kind: 'fresh', backupPath: null, archivedInstances: 0 };
    return;
  }

  if (!tableExists(db, 'schema_migration')) {
    throw new Error('数据库不是可识别的 prototype 或版本化 schema，拒绝猜测迁移');
  }
  const latest = db.prepare('SELECT version, checksum FROM schema_migration ORDER BY version DESC LIMIT 1').get();
  if (latest?.version === SCHEMA_VERSION_V1 && latest.checksum === SCHEMA_CHECKSUM_V1) {
    context.migration = migrateSchemaV1ToV2(db);
    context.migration = migrateSchemaV2ToV3(db, { from: context.migration.kind });
    return;
  }
  if (latest?.version === SCHEMA_VERSION_V2 && latest.checksum === SCHEMA_CHECKSUM_V2) {
    context.migration = migrateSchemaV2ToV3(db);
    return;
  }
  if (!latest || latest.version !== SCHEMA_VERSION || latest.checksum !== SCHEMA_CHECKSUM) {
    throw new Error(`不支持的数据库 schema version: ${latest?.version ?? 'unknown'}`);
  }
  db.exec(TARGET_SCHEMA);
}

function migrateSchemaV1ToV2(db) {
  const appliedAt = now();
  db.transaction(() => {
    const instanceColumns = columnNames(db, 'instances');
    if (!instanceColumns.has('deployment_mode')) {
      db.exec("ALTER TABLE instances ADD COLUMN deployment_mode TEXT CHECK(deployment_mode IN ('hosted', 'remote') OR deployment_mode IS NULL)");
    }
    db.prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?,?,?)')
      .run(SCHEMA_VERSION_V2, appliedAt, SCHEMA_CHECKSUM_V2);
    db.exec(TARGET_SCHEMA);
  })();
  return { kind: 'v1-to-v2', backupPath: null, archivedInstances: 0 };
}

function migrateSchemaV2ToV3(db, { from = null } = {}) {
  const appliedAt = now();
  db.transaction(() => {
    db.exec(TARGET_SCHEMA);
    addColumnIfMissing(db, 'audit_events', 'target_user_id', 'TEXT');
    addColumnIfMissing(db, 'audit_events', 'invite_id', 'TEXT');
    addColumnIfMissing(db, 'invites', 'token_pepper_key_id', 'TEXT');
    addColumnIfMissing(db, 'invites', 'token_prefix', 'TEXT');
    const existing = db.prepare('SELECT 1 FROM schema_migration WHERE version=?').get(SCHEMA_VERSION);
    if (!existing) {
      db.prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?,?,?)')
        .run(SCHEMA_VERSION, appliedAt, SCHEMA_CHECKSUM);
    }
  })();
  return { kind: from ? `${from}-to-v3` : 'v2-to-v3', backupPath: null, archivedInstances: 0 };
}

function migrateLegacyPrototype(db, context) {
  const namespaceRows = db.prepare('SELECT * FROM namespaces ORDER BY created_at, id').all();
  const registryRows = db.prepare('SELECT * FROM registry_keys ORDER BY namespace_id, created_at, id').all();
  const instanceRows = tableExists(db, 'instances')
    ? db.prepare('SELECT * FROM instances ORDER BY created_at, id').all()
    : [];

  for (const ns of namespaceRows) {
    const activeCount = registryRows.filter((row) => row.namespace_id === ns.id && row.status === 'active').length;
    if (activeCount !== 1) {
      throw new Error(`namespace ${ns.id} 必须恰好有一个 active registry key，实际为 ${activeCount}，迁移已拒绝`);
    }
  }

  const backupPath = createMigrationBackup(db, context.dbPath);
  const appliedAt = now();
  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec('ALTER TABLE namespaces RENAME TO legacy_namespaces_source');
      db.exec('ALTER TABLE registry_keys RENAME TO legacy_registry_keys_source');
      if (tableExists(db, 'instance_tokens')) {
        db.exec('ALTER TABLE instance_tokens RENAME TO legacy_instance_tokens_source');
      }
      if (tableExists(db, 'instances')) db.exec('ALTER TABLE instances RENAME TO legacy_instances_source');

      db.exec(TARGET_SCHEMA);
      const insertNs = db.prepare(
        'INSERT INTO namespaces (id, owner_user_id, name, created_at) VALUES (?,?,?,?)',
      );
      for (const ns of namespaceRows) insertNs.run(ns.id, ns.owner_user_id, ns.name, ns.created_at);

      const insertRegistry = db.prepare(`
        INSERT INTO registry_keys
          (id, namespace_id, digest, pepper_key_id, prefix, version, status, issued_at, rotated_at, rotated_by)
        VALUES (?,?,?,?,?,?,?,?,?,NULL)
      `);
      const key = context.tokenPepperKeyring.get(context.currentTokenPepperKeyId);
      const versions = new Map();
      for (const row of registryRows) {
        const version = (versions.get(row.namespace_id) ?? 0) + 1;
        versions.set(row.namespace_id, version);
        insertRegistry.run(
          row.id,
          row.namespace_id,
          credentialDigest(key, 'registry', row.secret),
          context.currentTokenPepperKeyId,
          credentialPrefix(row.secret),
          version,
          row.status === 'active' ? 'active' : 'rotated',
          row.created_at,
          row.rotated_at ?? null,
        );
      }

      const archive = db.prepare(`
        INSERT INTO legacy_instance_archive
          (legacy_id, namespace_id, delivery, hostname, dsh_version, last_seen_at, archived_at, reason)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      for (const instance of instanceRows) {
        archive.run(
          instance.id,
          instance.namespace_id,
          instance.delivery ?? null,
          instance.hostname ?? null,
          instance.dsh_version ?? null,
          instance.last_seen ?? null,
          appliedAt,
          'prototype instance lacked DNS-safe ID, installation ID, and bounded token lifecycle',
        );
      }

      if (tableExists(db, 'legacy_instance_tokens_source')) db.exec('DROP TABLE legacy_instance_tokens_source');
      if (tableExists(db, 'legacy_instances_source')) db.exec('DROP TABLE legacy_instances_source');
      db.exec('DROP TABLE legacy_registry_keys_source');
      db.exec('DROP TABLE legacy_namespaces_source');
      db.prepare('INSERT INTO schema_migration (version, applied_at, checksum) VALUES (?,?,?)')
        .run(SCHEMA_VERSION, appliedAt, SCHEMA_CHECKSUM);
      db.prepare(`
        INSERT INTO audit_events
          (id, time, actor_type, actor_id, namespace_id, instance_id, target_user_id, invite_id, action, result, request_id, details)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        `aud_${rid(8)}`,
        appliedAt,
        'system',
        'migration',
        null,
        null,
        null,
        null,
        'prototype_migration',
        'success',
        null,
        JSON.stringify({ archivedInstances: instanceRows.length, preservedNamespaces: namespaceRows.length }),
      );
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }

  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { kind: 'legacy', backupPath, archivedInstances: instanceRows.length };
}

function createMigrationBackup(db, dbPath) {
  if (dbPath === ':memory:') throw new Error('不能对内存 prototype 数据库执行破坏性迁移');
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${path.basename(dbPath)}.pre-m1a1-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(backupPath);
  fs.chmodSync(backupPath, 0o600);
  return backupPath;
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumnIfMissing(db, table, column, definition) {
  if (!tableExists(db, table)) return;
  if (columnNames(db, table).has(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function getMigrationInfo(db) {
  return { ...contextFor(db).migration };
}

export function getSchemaVersion(db) {
  return db.prepare('SELECT version, applied_at AS appliedAt, checksum FROM schema_migration ORDER BY version DESC LIMIT 1').get();
}

export function createNamespace(db, { name, ownerUserId }) {
  const context = contextFor(db);
  const owner = ensureHubUser(db, { username: ownerUserId, createdBy: 'system', allowReserved: true });
  const namespaceId = `ns_${rid(8)}`;
  const registryId = `rk_${rid(8)}`;
  const registryKey = makeCredential('registry');
  const issuedAt = now();
  const digest = credentialDigest(
    context.tokenPepperKeyring.get(context.currentTokenPepperKeyId),
    'registry',
    registryKey,
  );
  db.transaction(() => {
    db.prepare('INSERT INTO namespaces (id, name, owner_user_id, created_at) VALUES (?,?,?,?)')
      .run(namespaceId, name, owner.id, issuedAt);
    db.prepare(`
      INSERT INTO registry_keys
        (id, namespace_id, digest, pepper_key_id, prefix, version, status, issued_at)
      VALUES (?,?,?,?,?,1,'active',?)
    `).run(
      registryId,
      namespaceId,
      digest,
      context.currentTokenPepperKeyId,
      credentialPrefix(registryKey),
      issuedAt,
    );
    upsertNamespaceMembershipStatement(db, {
      namespaceId,
      userId: owner.id,
      role: 'namespace_owner',
      createdBy: owner.id,
      at: issuedAt,
    });
  })();
  return {
    namespaceId,
    name,
    registryKey,
    prefix: credentialPrefix(registryKey),
    version: 1,
    createdAt: issuedAt,
  };
}

export function getNamespace(db, id) {
  return db.prepare('SELECT * FROM namespaces WHERE id = ?').get(id) ?? null;
}

export function listNamespaces(db, userId, { limit = 100, cursor = null } = {}) {
  const systemAdmin = isSystemAdmin(db, userId);
  const where = systemAdmin
    ? '1=1'
    : "EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = n.id AND m.user_id = ? AND m.status = 'active')";
  const args = systemAdmin ? [] : [userId];
  return db.prepare(`
    SELECT n.*, r.prefix AS registry_key_prefix, r.version AS registry_key_version,
           r.issued_at AS registry_key_issued_at,
           ${systemAdmin ? "'system_admin'" : "(SELECT m.role FROM namespace_memberships m WHERE m.namespace_id = n.id AND m.user_id = ? AND m.status = 'active')"} AS membership_role
      FROM namespaces n
      LEFT JOIN registry_keys r ON r.namespace_id = n.id AND r.status = 'active'
     WHERE ${where}
       AND (? IS NULL OR n.created_at < ? OR (n.created_at = ? AND n.id < ?))
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?
  `).all(
    ...(systemAdmin ? [] : [userId]),
    ...args,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit,
  );
}

export function findRegistryKey(db, raw, { includeInactive = false } = {}) {
  const context = contextFor(db);
  const prefix = credentialPrefix(raw);
  const rows = db.prepare(`
    SELECT * FROM registry_keys
     WHERE prefix = ? ${includeInactive ? '' : "AND status = 'active'"}
     ORDER BY version DESC
  `).all(prefix);
  return rows.find((row) => verifyCredential({
    raw,
    type: 'registry',
    digest: row.digest,
    pepperKeyId: row.pepper_key_id,
    keyring: context.tokenPepperKeyring,
  })) ?? null;
}

export function rotateRegistryKey(db, namespaceId, { expectedVersion, rotatedBy }) {
  const context = contextFor(db);
  return db.transaction(() => {
    const current = db.prepare(
      "SELECT * FROM registry_keys WHERE namespace_id = ? AND status = 'active'",
    ).get(namespaceId);
    if (!current) throw new DbError('REGISTRY_KEY_NOT_FOUND', 'active registry key not found', 404);
    if (current.version !== expectedVersion) {
      throw new DbError('REGISTRY_VERSION_CONFLICT', 'registry key version changed', 409);
    }
    const registryKey = makeCredential('registry');
    const issuedAt = now();
    const nextVersion = current.version + 1;
    db.prepare(`
      UPDATE registry_keys
         SET status='rotated', rotated_at=?, rotated_by=?
       WHERE id=? AND status='active'
    `).run(issuedAt, rotatedBy, current.id);
    db.prepare(`
      INSERT INTO registry_keys
        (id, namespace_id, digest, pepper_key_id, prefix, version, status, issued_at)
      VALUES (?,?,?,?,?,?,'active',?)
    `).run(
      `rk_${rid(8)}`,
      namespaceId,
      credentialDigest(
        context.tokenPepperKeyring.get(context.currentTokenPepperKeyId),
        'registry',
        registryKey,
      ),
      context.currentTokenPepperKeyId,
      credentialPrefix(registryKey),
      nextVersion,
      issuedAt,
    );
    return {
      registryKey,
      prefix: credentialPrefix(registryKey),
      version: nextVersion,
      rotatedAt: issuedAt,
    };
  })();
}

export function registerInstance(db, {
  namespaceId,
  installationId,
  delivery,
  deploymentMode,
  hostname,
  clientVersion,
  dshVersion,
}) {
  if (!/^insl_[A-Za-z0-9_-]{22}$/.test(installationId)) {
    throw new DbError('BAD_INSTALLATION_ID', 'installationId is invalid', 400);
  }
  const normalizedDeploymentMode = normalizeDeploymentMode(deploymentMode);
  const createdAt = now();
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = makeInstanceId();
    try {
      db.prepare(`
        INSERT INTO instances
          (id, namespace_id, installation_id, delivery, deployment_mode, hostname, client_version, dsh_version, state, created_at)
        VALUES (?,?,?,?,?,?,?,?,'active',?)
      `).run(
        id,
        namespaceId,
        installationId,
        delivery,
        normalizedDeploymentMode,
        hostname ?? null,
        clientVersion ?? null,
        dshVersion ?? null,
        createdAt,
      );
      return getInstance(db, id);
    } catch (error) {
      if (String(error.message).includes('instances.namespace_id, instances.installation_id')) {
        throw new DbError('INSTANCE_ALREADY_BOUND', 'installation is already bound', 409);
      }
      if (!String(error.message).includes('instances.id')) throw error;
    }
  }
  throw new Error('生成唯一 instance ID 失败');
}

export function getInstance(db, id) {
  return db.prepare('SELECT * FROM instances WHERE id = ?').get(id) ?? null;
}

export function listInstances(db, userId, { namespaceId = null, limit = 100, cursor = null, includeViewers = true } = {}) {
  const systemAdmin = isSystemAdmin(db, userId);
  const membershipPredicate = includeViewers
    ? "m.status = 'active'"
    : "m.status = 'active' AND m.role <> 'viewer'";
  const where = systemAdmin
    ? '1=1'
    : `EXISTS (SELECT 1 FROM namespace_memberships m WHERE m.namespace_id = n.id AND m.user_id = ? AND ${membershipPredicate})`;
  const args = systemAdmin ? [] : [userId];
  return db.prepare(`
    SELECT i.*, n.name AS namespace_name,
           ${systemAdmin ? "'system_admin'" : "(SELECT m.role FROM namespace_memberships m WHERE m.namespace_id = n.id AND m.user_id = ? AND m.status = 'active')"} AS membership_role,
           (
             SELECT t.expires_at
               FROM instance_tokens t
              WHERE t.instance_id = i.id AND t.revoked_at IS NULL
              ORDER BY t.issued_at DESC, t.id DESC
              LIMIT 1
           ) AS latest_token_expires_at,
           (
             SELECT t.renewal_until
               FROM instance_tokens t
              WHERE t.instance_id = i.id AND t.revoked_at IS NULL
              ORDER BY t.issued_at DESC, t.id DESC
              LIMIT 1
           ) AS latest_token_renewal_until
      FROM instances i
      JOIN namespaces n ON n.id = i.namespace_id
     WHERE ${where}
       AND (? IS NULL OR i.namespace_id = ?)
       AND (? IS NULL OR i.created_at < ? OR (i.created_at = ? AND i.id < ?))
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ?
  `).all(
    ...(systemAdmin ? [] : [userId]),
    ...args,
    namespaceId,
    namespaceId,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit,
  );
}

export function normalizeUsername(value, { allowReserved = false } = {}) {
  const username = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{1,30}[a-z0-9])$/.test(username)) {
    throw new DbError('BAD_USERNAME', 'username is invalid', 400);
  }
  if (username.includes('..')) throw new DbError('BAD_USERNAME', 'username is invalid', 400);
  if (!allowReserved && ['root', 'admin', 'system', 'authelia', 'lldap'].includes(username)) {
    throw new DbError('BAD_USERNAME', 'username is reserved', 400);
  }
  return username;
}

export function validatePassword(value, { username = '', email = '', displayName = '' } = {}) {
  const password = String(value ?? '');
  if (password.length < 12 || password.length > 256) {
    throw new DbError('WEAK_PASSWORD', 'password does not meet policy', 400);
  }
  if (/^(.)\1+$/.test(password)) throw new DbError('WEAK_PASSWORD', 'password does not meet policy', 400);
  const lower = password.toLowerCase();
  for (const token of [username, email?.split('@')[0], displayName].filter(Boolean)) {
    const normalized = String(token).trim().toLowerCase();
    if (normalized.length >= 3 && lower.includes(normalized)) {
      throw new DbError('WEAK_PASSWORD', 'password does not meet policy', 400);
    }
  }
  return true;
}

export function ensureHubUser(db, {
  username,
  email = null,
  displayName = null,
  externalProvider = 'lldap',
  externalSubject = null,
  status = 'active',
  createdBy = null,
  allowReserved = false,
} = {}) {
  const normalized = username === 'owner' ? 'owner' : normalizeUsername(username, { allowReserved });
  const subject = externalSubject ?? normalized;
  const at = now();
  db.prepare(`
    INSERT INTO users
      (id, external_provider, external_subject, username, email, display_name, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      email=COALESCE(excluded.email, users.email),
      display_name=COALESCE(excluded.display_name, users.display_name),
      updated_at=excluded.updated_at
  `).run(normalized, externalProvider, subject, normalized, email, displayName, status, at, at);
  return getUser(db, normalized);
}

export function getUser(db, userId) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(userId) ?? null;
}

export function getUserByUsername(db, username) {
  const normalized = String(username ?? '').trim().toLowerCase();
  return db.prepare('SELECT * FROM users WHERE username=?').get(normalized) ?? null;
}

export function getActiveUserByUsername(db, username) {
  const user = getUserByUsername(db, username);
  return user?.status === 'active' ? user : null;
}

export function isSystemAdmin(db, userId) {
  return !!db.prepare('SELECT 1 FROM system_admins WHERE user_id=?').get(userId);
}

export function countActiveSystemAdmins(db, { excludeUserId = null } = {}) {
  return db.prepare(`
    SELECT COUNT(*) AS count
      FROM system_admins s
      JOIN users u ON u.id = s.user_id
     WHERE u.status='active'
       AND (? IS NULL OR u.id != ?)
  `).get(excludeUserId, excludeUserId).count;
}

export function ensureSystemAdmin(db, userId, { createdBy = 'system', reason = 'bootstrap' } = {}) {
  const at = now();
  const user = ensureHubUser(db, { username: userId, createdBy, allowReserved: true });
  db.prepare(`
    INSERT OR IGNORE INTO system_admins (user_id, created_at, created_by, reason)
    VALUES (?,?,?,?)
  `).run(user.id, at, createdBy, reason);
}

export function listUsers(db, { limit = 100 } = {}) {
  return db.prepare(`
    SELECT u.id, u.username, u.email, u.display_name, u.status, u.created_at, u.updated_at,
           EXISTS(SELECT 1 FROM system_admins s WHERE s.user_id = u.id) AS is_system_admin
      FROM users u
     ORDER BY u.created_at DESC, u.username ASC
     LIMIT ?
  `).all(limit);
}

export function setUserStatus(db, userId, status) {
  if (status !== 'active' && status !== 'disabled') {
    throw new DbError('BAD_REQUEST', 'invalid user status', 400);
  }
  const result = db.prepare('UPDATE users SET status=?, updated_at=? WHERE id=?').run(status, now(), userId);
  if (!result.changes) throw new DbError('USER_NOT_FOUND', 'user not found', 404);
  return getUser(db, userId);
}

export function getNamespaceRole(db, userId, namespaceId) {
  return db.prepare(`
    SELECT role FROM namespace_memberships
     WHERE user_id=? AND namespace_id=? AND status='active'
  `).get(userId, namespaceId)?.role ?? null;
}

export function listNamespaceMembers(db, namespaceId) {
  return db.prepare(`
    SELECT m.id, m.namespace_id, m.user_id, m.role, m.status, m.created_at, m.updated_at,
           m.created_by, m.removed_at, m.removed_by,
           u.username, u.email, u.display_name, u.status AS user_status
      FROM namespace_memberships m
      JOIN users u ON u.id = m.user_id
     WHERE m.namespace_id=?
     ORDER BY m.status ASC, m.role ASC, u.username ASC
  `).all(namespaceId);
}

export function addNamespaceMembership(db, { namespaceId, userId, role, createdBy }) {
  if (!NAMESPACE_ROLES.has(role)) throw new DbError('BAD_ROLE', 'role is invalid', 400);
  const user = getUser(db, userId);
  if (!user || user.status !== 'active') throw new DbError('USER_NOT_FOUND', 'user not found', 404);
  const ns = getNamespace(db, namespaceId);
  if (!ns) throw new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404);
  return db.transaction(() => upsertNamespaceMembershipStatement(db, {
    namespaceId,
    userId,
    role,
    createdBy,
    at: now(),
  }))();
}

export function updateNamespaceMembershipRole(db, { namespaceId, userId, role, updatedBy }) {
  if (!NAMESPACE_ROLES.has(role)) throw new DbError('BAD_ROLE', 'role is invalid', 400);
  return db.transaction(() => {
    const current = activeMembership(db, namespaceId, userId);
    if (!current) throw new DbError('MEMBERSHIP_NOT_FOUND', 'member not found', 404);
    if (current.role === 'namespace_owner' && role !== 'namespace_owner') {
      ensureNotLastOwner(db, namespaceId, userId);
    }
    db.prepare(`
      UPDATE namespace_memberships
         SET role=?, updated_at=?, removed_at=NULL, removed_by=NULL
       WHERE namespace_id=? AND user_id=? AND status='active'
    `).run(role, now(), namespaceId, userId);
    return activeMembership(db, namespaceId, userId);
  })();
}

export function removeNamespaceMembership(db, { namespaceId, userId, removedBy }) {
  return db.transaction(() => {
    const current = activeMembership(db, namespaceId, userId);
    if (!current) throw new DbError('MEMBERSHIP_NOT_FOUND', 'member not found', 404);
    if (current.role === 'namespace_owner') ensureNotLastOwner(db, namespaceId, userId);
    const at = now();
    db.prepare(`
      UPDATE namespace_memberships
         SET status='removed', updated_at=?, removed_at=?, removed_by=?
       WHERE namespace_id=? AND user_id=? AND status='active'
    `).run(at, at, removedBy, namespaceId, userId);
    return { removed: true };
  })();
}

export function createInvite(db, { namespaceId, role, emailHint = null, createdBy, ttlMs = 24 * 60 * 60 * 1000 }) {
  if (!['namespace_admin', 'member', 'viewer'].includes(role)) {
    throw new DbError('BAD_ROLE', 'role is invalid', 400);
  }
  const context = contextFor(db);
  const token = makeCredential('invite');
  const at = now();
  const expiresAt = at + ttlMs;
  const id = `inv_${rid(8)}`;
  const pepperKeyId = context.currentTokenPepperKeyId;
  const digest = credentialDigest(context.tokenPepperKeyring.get(pepperKeyId), 'invite', token);
  const prefix = credentialPrefix(token);
  db.prepare(`
    INSERT INTO invites
      (id, token_digest, token_pepper_key_id, token_prefix, namespace_id, role, email_hint, status, expires_at, created_at, created_by)
    VALUES (?,?,?,?,?,?,?,'active',?,?,?)
  `).run(id, digest, pepperKeyId, prefix, namespaceId, role, emailHint, expiresAt, at, createdBy);
  return { inviteId: id, token, role, emailHint, expiresAt, createdAt: at };
}

export function listInvites(db, namespaceId, { limit = 100 } = {}) {
  markExpiredInvites(db);
  return db.prepare(`
    SELECT i.id, i.namespace_id, i.role, i.email_hint, i.status, i.expires_at,
           i.created_at, i.created_by, i.consumed_at, i.consumed_by_user_id,
           i.revoked_at, i.revoked_by, i.failure_code
      FROM invites i
     WHERE i.namespace_id=?
     ORDER BY i.created_at DESC, i.id DESC
     LIMIT ?
  `).all(namespaceId, limit);
}

export function findInviteByToken(db, token, { includeInactive = false } = {}) {
  markExpiredInvites(db);
  const context = contextFor(db);
  const prefix = credentialPrefix(token);
  const rows = db.prepare(`
    SELECT i.*, n.name AS namespace_name
      FROM invites i
      JOIN namespaces n ON n.id = i.namespace_id
     WHERE (i.token_prefix = ? OR i.token_prefix IS NULL)
       ${includeInactive ? '' : "AND i.status='active'"}
  `).all(prefix);
  for (const row of rows) {
    const pepperKeyId = row.token_pepper_key_id ?? context.currentTokenPepperKeyId;
    if (verifyCredential({
      raw: token,
      type: 'invite',
      digest: row.token_digest,
      pepperKeyId,
      keyring: context.tokenPepperKeyring,
    })) {
      const tokenDigest = credentialDigest(context.tokenPepperKeyring.get(pepperKeyId), 'invite', token);
      return { ...row, tokenDigest };
    }
  }
  return null;
}

export function revokeInvite(db, { inviteId, revokedBy }) {
  const at = now();
  const result = db.prepare(`
    UPDATE invites
       SET status='revoked', revoked_at=?, revoked_by=?
     WHERE id=? AND status='active'
  `).run(at, revokedBy, inviteId);
  if (!result.changes) throw new DbError('INVITE_NOT_FOUND', 'invite not found', 404);
  return { revoked: true, revokedAt: at };
}

export function createInvitePowChallenge(db, { inviteToken, difficulty, ttlMs = 5 * 60 * 1000, ipHash = null }) {
  const invite = findInviteByToken(db, inviteToken);
  if (!invite) throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
  const at = now();
  const row = {
    id: `pow_${rid(8)}`,
    challenge: crypto.randomBytes(18).toString('base64url'),
    difficulty,
    expiresAt: at + ttlMs,
  };
  db.prepare(`
    INSERT INTO invite_pow_challenges
      (id, invite_digest, challenge, difficulty, expires_at, created_at, ip_hash)
    VALUES (?,?,?,?,?,?,?)
  `).run(row.id, invite.tokenDigest, row.challenge, difficulty, row.expiresAt, at, ipHash);
  return row;
}

export function getInvitePowChallenge(db, { challengeId, inviteToken }) {
  const invite = findInviteByToken(db, inviteToken);
  if (!invite) throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
  const row = db.prepare(`
    SELECT * FROM invite_pow_challenges
     WHERE id=? AND consumed_at IS NULL
  `).get(challengeId);
  if (!row || now() > row.expires_at || !Buffer.from(row.invite_digest).equals(Buffer.from(invite.tokenDigest))) {
    throw new DbError('POW_INVALID', 'proof of work is invalid', 400);
  }
  return row;
}

export function consumeInvitePowChallenge(db, { challengeId, inviteToken }) {
  const row = getInvitePowChallenge(db, { challengeId, inviteToken });
  const result = db.prepare('UPDATE invite_pow_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(now(), row.id);
  if (!result.changes) throw new DbError('POW_INVALID', 'proof of work is invalid', 400);
  return row;
}

export function consumeInvite(db, {
  token,
  username,
  email = null,
  displayName = null,
  createdBy = null,
}) {
  const normalizedUsername = normalizeUsername(username);
  const locked = beginInviteConsumption(db, { token });
  return completeInviteConsumption(db, {
    inviteId: locked.id,
    username: normalizedUsername,
    email,
    displayName,
    createdBy,
  });
}

export function markInviteFailed(db, token, failureCode, { needsAdmin = false } = {}) {
  const invite = String(token ?? '').startsWith('inv_')
    ? db.prepare('SELECT * FROM invites WHERE id=?').get(token)
    : findInviteByToken(db, token, { includeInactive: true });
  if (!invite) return;
  db.prepare(`
    UPDATE invites
       SET status=?, failure_code=?
     WHERE id=? AND status IN ('active', 'consuming', 'failed_retryable')
  `).run(needsAdmin ? 'failed_needs_admin' : 'failed_retryable', String(failureCode ?? 'unknown').slice(0, 80), invite.id);
}

export function beginInviteConsumption(db, { token }) {
  const invite = findInviteByToken(db, token);
  if (!invite) throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
  const at = now();
  return db.transaction(() => {
    const lock = db.prepare(`
      UPDATE invites
         SET status='consuming', attempt_id=?, consuming_until=?
       WHERE id=? AND status='active' AND expires_at > ?
    `).run(`att_${rid(8)}`, at + 30_000, invite.id, at);
    if (!lock.changes) throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
    return db.prepare(`
      SELECT i.*, n.name AS namespace_name
        FROM invites i
        JOIN namespaces n ON n.id = i.namespace_id
       WHERE i.id=?
    `).get(invite.id);
  })();
}

export function completeInviteConsumption(db, {
  inviteId,
  username,
  email = null,
  displayName = null,
  createdBy = null,
}) {
  const normalizedUsername = normalizeUsername(username);
  if (getUserByUsername(db, normalizedUsername)) {
    throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
  }
  const at = now();
  return db.transaction(() => {
    const invite = db.prepare('SELECT * FROM invites WHERE id=? AND status=?').get(inviteId, 'consuming');
    if (!invite) throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
    const user = ensureHubUser(db, {
      username: normalizedUsername,
      email,
      displayName,
      createdBy,
    });
    upsertNamespaceMembershipStatement(db, {
      namespaceId: invite.namespace_id,
      userId: user.id,
      role: invite.role,
      createdBy: invite.created_by,
      at,
    });
    db.prepare(`
      UPDATE invites
         SET status='consumed', consumed_at=?, consumed_by_user_id=?
       WHERE id=?
    `).run(at, user.id, invite.id);
    return { inviteId: invite.id, namespaceId: invite.namespace_id, role: invite.role, user, consumedAt: at };
  })();
}

function activeMembership(db, namespaceId, userId) {
  return db.prepare(`
    SELECT * FROM namespace_memberships
     WHERE namespace_id=? AND user_id=? AND status='active'
  `).get(namespaceId, userId) ?? null;
}

function ensureNotLastOwner(db, namespaceId, userId) {
  const count = db.prepare(`
    SELECT count(*) AS n FROM namespace_memberships
     WHERE namespace_id=? AND role='namespace_owner' AND status='active' AND user_id <> ?
  `).get(namespaceId, userId).n;
  if (count < 1) throw new DbError('LAST_OWNER', 'cannot remove or downgrade last namespace owner', 409);
}

function upsertNamespaceMembershipStatement(db, { namespaceId, userId, role, createdBy, at }) {
  const existing = db.prepare(`
    SELECT * FROM namespace_memberships WHERE namespace_id=? AND user_id=?
  `).get(namespaceId, userId);
  if (!existing) {
    db.prepare(`
      INSERT INTO namespace_memberships
        (id, namespace_id, user_id, role, status, created_at, updated_at, created_by)
      VALUES (?,?,?,?, 'active', ?, ?, ?)
    `).run(`mem_${rid(8)}`, namespaceId, userId, role, at, at, createdBy ?? null);
  } else {
    db.prepare(`
      UPDATE namespace_memberships
         SET role=?, status='active', updated_at=?, removed_at=NULL, removed_by=NULL
       WHERE namespace_id=? AND user_id=?
    `).run(role, at, namespaceId, userId);
  }
  return activeMembership(db, namespaceId, userId);
}

function markExpiredInvites(db) {
  db.prepare("UPDATE invites SET status='expired' WHERE status='active' AND expires_at <= ?").run(now());
}

function ensureG2Bootstrap(db, context) {
  if (!tableExists(db, 'users') || !tableExists(db, 'namespace_memberships')) return;
  const at = now();
  const ownerRows = db.prepare('SELECT id, owner_user_id FROM namespaces').all();
  for (const row of ownerRows) {
    const owner = ensureHubUser(db, { username: row.owner_user_id || 'owner', createdBy: 'migration', allowReserved: true });
    upsertNamespaceMembershipStatement(db, {
      namespaceId: row.id,
      userId: owner.id,
      role: 'namespace_owner',
      createdBy: 'migration',
      at,
    });
  }
  const bootstrap = String(context.bootstrapSystemAdminUsername || context.devAuthUser || 'owner').trim().toLowerCase();
  ensureSystemAdmin(db, bootstrap, { createdBy: 'bootstrap', reason: 'bootstrap system admin' });
}

export function recordAudit(db, {
  actorType,
  actorId = null,
  namespaceId = null,
  instanceId = null,
  targetUserId = null,
  inviteId = null,
  action,
  result,
  requestId = null,
  details = null,
}) {
  db.prepare(`
    INSERT INTO audit_events
      (id, time, actor_type, actor_id, namespace_id, instance_id, target_user_id, invite_id, action, result, request_id, details)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    `aud_${rid(8)}`,
    now(),
    actorType,
    actorId,
    namespaceId,
    instanceId,
    targetUserId,
    inviteId,
    action,
    result,
    requestId,
    details ? JSON.stringify(details) : null,
  );
}

export function listAuditEvents(db, namespaceId, { limit = 100, cursor = null } = {}) {
  return db.prepare(`
    SELECT *
      FROM audit_events
     WHERE namespace_id = ?
       AND (? IS NULL OR time < ? OR (time = ? AND id < ?))
     ORDER BY time DESC, id DESC
     LIMIT ?
  `).all(
    namespaceId,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    limit,
  );
}

export function issueInstanceToken(db, instanceId) {
  const context = contextFor(db);
  const instanceToken = makeCredential('instance');
  const issuedAt = now();
  const expiresAt = issuedAt + (context.instanceTokenTtlMs ?? 30 * 24 * 60 * 60 * 1000);
  const renewalUntil = expiresAt
    + (context.instanceTokenRenewalGraceMs ?? 7 * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO instance_tokens
      (id, instance_id, digest, pepper_key_id, prefix, issued_at, expires_at, renewal_until)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(
    `tok_${rid(8)}`,
    instanceId,
    credentialDigest(
      context.tokenPepperKeyring.get(context.currentTokenPepperKeyId),
      'instance',
      instanceToken,
    ),
    context.currentTokenPepperKeyId,
    credentialPrefix(instanceToken),
    issuedAt,
    expiresAt,
    renewalUntil,
  );
  const row = findInstanceToken(db, instanceId, instanceToken, { includeExpiredRenewable: true });
  return { tokenId: row.id, instanceToken, issuedAt, expiresAt, renewalUntil };
}

export function validateInstanceToken(db, instanceId, raw, at = now()) {
  return !!findInstanceToken(db, instanceId, raw, { at });
}

export function getInstanceToken(db, tokenId) {
  return db.prepare('SELECT * FROM instance_tokens WHERE id=?').get(tokenId) ?? null;
}

export function findInstanceToken(db, instanceId, raw, {
  at = now(),
  includeExpiredRenewable = false,
  includeRotated = false,
} = {}) {
  const context = contextFor(db);
  const instance = getInstance(db, instanceId);
  if (!instance || instance.state !== 'active') return null;
  const rows = db.prepare(`
    SELECT * FROM instance_tokens
     WHERE instance_id = ? AND prefix = ? AND revoked_at IS NULL
  `).all(instanceId, credentialPrefix(raw));
  return rows.find((row) => {
    if (at > row.expires_at && !includeExpiredRenewable) return false;
    if (!includeRotated && row.rotated_at !== null && at >= row.overlap_until) return false;
    return verifyCredential({
      raw,
      type: 'instance',
      digest: row.digest,
      pepperKeyId: row.pepper_key_id,
      keyring: context.tokenPepperKeyring,
    });
  }) ?? null;
}

export function diagnoseInstanceToken(db, instanceId, raw, { at = now() } = {}) {
  const context = contextFor(db);
  const instance = getInstance(db, instanceId);
  if (!instance) return { ok: false, code: 'UNAUTHORIZED', message: 'invalid instance token' };
  if (instance.state !== 'active') return { ok: false, code: 'TOKEN_REVOKED', message: 'token revoked' };
  const rows = db.prepare(`
    SELECT * FROM instance_tokens
     WHERE instance_id = ? AND prefix = ?
  `).all(instanceId, credentialPrefix(raw));
  const row = rows.find((candidate) => verifyCredential({
    raw,
    type: 'instance',
    digest: candidate.digest,
    pepperKeyId: candidate.pepper_key_id,
    keyring: context.tokenPepperKeyring,
  }));
  if (!row) return { ok: false, code: 'UNAUTHORIZED', message: 'invalid instance token' };
  if (row.revoked_at !== null) return { ok: false, code: 'TOKEN_REVOKED', message: 'token revoked' };
  if (at > row.expires_at) return { ok: false, code: 'TOKEN_EXPIRED', message: 'token expired' };
  if (row.rotated_at !== null && at >= row.overlap_until) {
    return { ok: false, code: 'TOKEN_ROTATED', message: 'token rotated' };
  }
  return { ok: true, row };
}

export function revokeInstanceToken(db, instanceId, reason = 'owner_revoked') {
  const revokedAt = now();
  return db.transaction(() => revokeInstanceTokenStatements(db, instanceId, reason, revokedAt))();
}

export function revokeInstanceTokenWithAudit(db, instanceId, reason, auditEvent) {
  const revokedAt = now();
  return db.transaction(() => {
    const revoked = revokeInstanceTokenStatements(db, instanceId, reason, revokedAt);
    recordAudit(db, auditEvent);
    return revoked;
  })();
}

export function recoverInstance(db, instanceId) {
  const result = db.prepare("UPDATE instances SET state='active' WHERE id=? AND state='revoked'").run(instanceId);
  if (!result.changes) throw new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404);
  return getInstance(db, instanceId);
}

function revokeInstanceTokenStatements(db, instanceId, reason, revokedAt) {
  db.prepare("UPDATE instances SET state='revoked' WHERE id=?").run(instanceId);
  return db.prepare(`
    UPDATE instance_tokens
       SET revoked_at=?, revoke_reason=?
     WHERE instance_id=? AND revoked_at IS NULL
  `).run(revokedAt, reason, instanceId).changes;
}

export function rotateInstanceToken(db, { instanceId, rawToken, tokenId }) {
  const context = contextFor(db);
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT * FROM instance_tokens
       WHERE id=? AND instance_id=? AND revoked_at IS NULL
    `).get(tokenId, instanceId);
    if (!current) throw new DbError('TOKEN_REVOKED', 'token revoked', 403);
    const at = now();
    if (at > current.renewal_until) throw new DbError('TOKEN_EXPIRED', 'token expired', 401);
    if (current.rotated_to_token_id) {
      throw new DbError('TOKEN_ALREADY_ROTATED', 'token already rotated', 409);
    }
    if (!verifyCredential({
      raw: rawToken,
      type: 'instance',
      digest: current.digest,
      pepperKeyId: current.pepper_key_id,
      keyring: context.tokenPepperKeyring,
    })) {
      throw new DbError('TOKEN_INVALID', 'token invalid', 401);
    }

    const next = issueInstanceToken(db, instanceId);
    const overlapUntil = at > current.expires_at
      ? at
      : Math.min(at + (context.instanceTokenOverlapMs ?? 5 * 60 * 1000), current.expires_at);
    db.prepare(`
      UPDATE instance_tokens
         SET rotated_at=?, rotated_to_token_id=?, overlap_until=?
       WHERE id=? AND rotated_to_token_id IS NULL
    `).run(at, next.tokenId, overlapUntil, current.id);
    return { ...next, overlapUntil, previousTokenId: current.id };
  })();
}

export function issueReplacementGrant(db, { instanceId, issuedBy, reason }) {
  const context = contextFor(db);
  const grant = makeCredential('replacement');
  const createdAt = now();
  const expiresAt = createdAt + (context.replacementGrantTtlMs ?? 10 * 60 * 1000);
  return db.transaction(() => {
    const inst = getInstance(db, instanceId);
    if (!inst) throw new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404);
    db.prepare(`
      UPDATE replacement_grants
         SET status='superseded', superseded_at=?
       WHERE instance_id=? AND status='outstanding'
    `).run(createdAt, instanceId);
    db.prepare(`
      INSERT INTO replacement_grants
        (id, instance_id, installation_id, digest, pepper_key_id, prefix, status,
         expires_at, issued_by, reason, created_at)
      VALUES (?,?,?,?,?,?,'outstanding',?,?,?,?)
    `).run(
      `rg_${rid(8)}`,
      instanceId,
      inst.installation_id,
      credentialDigest(
        context.tokenPepperKeyring.get(context.currentTokenPepperKeyId),
        'replacement',
        grant,
      ),
      context.currentTokenPepperKeyId,
      credentialPrefix(grant),
      expiresAt,
      issuedBy,
      reason,
      createdAt,
    );
    const row = findReplacementGrant(db, grant, { includeInactive: true });
    return { grantId: row.id, replacementGrant: grant, expiresAt };
  })();
}

export function findReplacementGrant(db, raw, { includeInactive = false } = {}) {
  const context = contextFor(db);
  const rows = db.prepare(`
    SELECT * FROM replacement_grants
     WHERE prefix = ? ${includeInactive ? '' : "AND status = 'outstanding'"}
     ORDER BY created_at DESC
  `).all(credentialPrefix(raw));
  return rows.find((row) => verifyCredential({
    raw,
    type: 'replacement',
    digest: row.digest,
    pepperKeyId: row.pepper_key_id,
    keyring: context.tokenPepperKeyring,
  })) ?? null;
}

export function consumeReplacementGrant(db, {
  grantId,
  rawGrant,
  installationId,
  delivery,
  deploymentMode,
  hostname,
  clientVersion,
  dshVersion,
}) {
  const context = contextFor(db);
  const normalizedDeploymentMode = normalizeDeploymentMode(deploymentMode);
  return db.transaction(() => {
    const grant = db.prepare('SELECT * FROM replacement_grants WHERE id=?').get(grantId);
    if (!grant || grant.status !== 'outstanding' || now() > grant.expires_at) {
      throw new DbError('INVALID_REPLACEMENT_GRANT', 'invalid replacement grant', 401);
    }
    if (grant.installation_id !== installationId) {
      throw new DbError('INVALID_REPLACEMENT_GRANT', 'invalid replacement grant', 401);
    }
    if (!verifyCredential({
      raw: rawGrant,
      type: 'replacement',
      digest: grant.digest,
      pepperKeyId: grant.pepper_key_id,
      keyring: context.tokenPepperKeyring,
    })) {
      throw new DbError('INVALID_REPLACEMENT_GRANT', 'invalid replacement grant', 401);
    }
    db.prepare(`
      UPDATE instances
         SET state='active', delivery=?, deployment_mode=COALESCE(?, deployment_mode),
             hostname=?, client_version=?, dsh_version=?
       WHERE id=?
    `).run(
      delivery,
      normalizedDeploymentMode,
      hostname ?? null,
      clientVersion ?? null,
      dshVersion ?? null,
      grant.instance_id,
    );
    db.prepare(`
      UPDATE instance_tokens
         SET revoked_at=?, revoke_reason=?
       WHERE instance_id=? AND revoked_at IS NULL
    `).run(now(), 'replacement_grant_consumed', grant.instance_id);
    const token = issueInstanceToken(db, grant.instance_id);
    db.prepare(`
      UPDATE replacement_grants
         SET status='used', used_at=?
       WHERE id=? AND status='outstanding'
    `).run(now(), grant.id);
    const inst = getInstance(db, grant.instance_id);
    return { instance: inst, token, grant };
  })();
}

export function setInstanceConnection(db, instanceId, { lastSeen, dshOnline, deploymentMode }) {
  const observedAt = dshOnline === undefined ? null : now();
  const normalizedDeploymentMode = normalizeDeploymentMode(deploymentMode);
  db.prepare(`
    UPDATE instances
       SET last_seen_at=COALESCE(?, last_seen_at),
           deployment_mode=COALESCE(?, deployment_mode),
           last_dsh_online=COALESCE(?, last_dsh_online),
           last_dsh_observed_at=COALESCE(?, last_dsh_observed_at)
     WHERE id=?
  `).run(
    lastSeen ?? null,
    normalizedDeploymentMode,
    dshOnline === undefined ? null : (dshOnline ? 1 : 0),
    observedAt,
    instanceId,
  );
}

export function runIdempotent(db, {
  actorScope,
  operation,
  idempotencyKey,
  request,
  mutate,
}) {
  if (!idempotencyKey) {
    throw new DbError('IDEMPOTENCY_REQUIRED', 'Idempotency-Key is required', 400);
  }
  if (!validateIdempotencyKey(idempotencyKey)) {
    throw new DbError('BAD_IDEMPOTENCY_KEY', 'Idempotency-Key is invalid', 400);
  }
  const context = contextFor(db);
  const keyDigest = sha256(idempotencyKey);
  const requestDigest = sha256(canonicalJson(request));

  const outcome = db.transaction(() => {
    const existing = db.prepare(`
      SELECT * FROM idempotency_records
       WHERE actor_scope=? AND operation=? AND key_digest=?
    `).get(actorScope, operation, keyDigest);
    if (existing) return { kind: 'replay', row: existing };

    const result = mutate();
    const statusCode = result.statusCode ?? 200;
    const response = { statusCode, body: result.body };
    const createdAt = now();
    const responseExpiresAt = createdAt + (context.idempotencyResponseTtlMs ?? 24 * 60 * 60 * 1000);
    const tombstoneExpiresAt = createdAt
      + (context.idempotencyTombstoneTtlMs ?? 30 * 24 * 60 * 60 * 1000);
    const encryptionKeyId = context.currentIdempotencyEncryptionKeyId;
    const aad = idempotencyAad(actorScope, operation, keyDigest, requestDigest, statusCode);
    const encrypted = encryptJson({
      key: context.idempotencyEncryptionKeyring.get(encryptionKeyId),
      keyId: encryptionKeyId,
      value: response,
      aad,
    });
    db.prepare(`
      INSERT INTO idempotency_records
        (actor_scope, operation, key_digest, request_digest, status_code,
         encrypted_response, encryption_key_id, response_expires_at,
         tombstone_expires_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      actorScope,
      operation,
      keyDigest,
      requestDigest,
      statusCode,
      encrypted.payload,
      encrypted.keyId,
      responseExpiresAt,
      tombstoneExpiresAt,
      createdAt,
    );
    return { kind: 'created', response: { ...response, replayed: false } };
  })();

  // 重放校验放在写事务之外：过期响应降级为墓碑后即使抛错，更新也不会被事务回滚。
  if (outcome.kind === 'replay') {
    return replayIdempotent(context, db, outcome.row, requestDigest);
  }
  return outcome.response;
}

function replayIdempotent(context, db, row, requestDigest) {
  const storedDigest = Buffer.from(row.request_digest);
  if (storedDigest.length !== requestDigest.length || !crypto.timingSafeEqual(storedDigest, requestDigest)) {
    throw new DbError('IDEMPOTENCY_CONFLICT', 'Idempotency-Key was used for a different request', 409);
  }
  if (!row.encrypted_response || now() > row.response_expires_at) {
    if (row.encrypted_response) {
      db.prepare(`
        UPDATE idempotency_records
           SET encrypted_response=NULL, encryption_key_id=NULL
         WHERE actor_scope=? AND operation=? AND key_digest=?
      `).run(row.actor_scope, row.operation, row.key_digest);
    }
    throw new DbError('IDEMPOTENCY_RESULT_EXPIRED', 'Idempotency result has expired', 409);
  }
  const key = context.idempotencyEncryptionKeyring.get(row.encryption_key_id);
  if (!key) throw new DbError('IDEMPOTENCY_KEY_UNAVAILABLE', 'Idempotency result key is unavailable', 500);
  const aad = idempotencyAad(
    row.actor_scope,
    row.operation,
    Buffer.from(row.key_digest),
    storedDigest,
    row.status_code,
  );
  let result;
  try {
    result = decryptJson({ key, payload: row.encrypted_response, aad });
  } catch {
    throw new DbError('IDEMPOTENCY_RESULT_INVALID', 'Idempotency result authentication failed', 500);
  }
  return { ...result, replayed: true };
}

function idempotencyAad(actorScope, operation, keyDigest, requestDigest, statusCode) {
  return canonicalJson({
    actorScope,
    operation,
    keyDigest: Buffer.from(keyDigest).toString('base64url'),
    requestDigest: Buffer.from(requestDigest).toString('base64url'),
    statusCode,
  });
}

export function pruneIdempotencyRecords(db, at = now()) {
  db.prepare(`
    UPDATE idempotency_records
       SET encrypted_response=NULL, encryption_key_id=NULL
     WHERE response_expires_at < ? AND encrypted_response IS NOT NULL
  `).run(at);
  return db.prepare('DELETE FROM idempotency_records WHERE tombstone_expires_at < ?').run(at).changes;
}

function contextFor(db) {
  const context = DB_CONTEXT.get(db);
  if (!context) throw new Error('数据库未通过 openDb 初始化');
  return context;
}
