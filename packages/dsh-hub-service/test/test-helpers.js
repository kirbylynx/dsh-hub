import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

export function securityOptions(overrides = {}) {
  return {
    tokenPepperKeyring: new Map([
      ['pepper-v1', Buffer.alloc(32, 0x11)],
      ['pepper-v0', Buffer.alloc(32, 0x10)],
    ]),
    currentTokenPepperKeyId: 'pepper-v1',
    idempotencyEncryptionKeyring: new Map([
      ['idem-v1', Buffer.alloc(32, 0x21)],
      ['idem-v0', Buffer.alloc(32, 0x20)],
    ]),
    currentIdempotencyEncryptionKeyId: 'idem-v1',
    busyTimeoutMs: 1000,
    instanceTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    instanceTokenRenewalGraceMs: 7 * 24 * 60 * 60 * 1000,
    idempotencyResponseTtlMs: 24 * 60 * 60 * 1000,
    idempotencyTombstoneTtlMs: 30 * 24 * 60 * 60 * 1000,
    ...overrides,
  };
}

export function tempDatabase(t, prefix = 'dshhub-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, 'hub.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath };
}

export function createLegacyPrototype(dbPath, {
  registryKey = 'dhk_legacy-registry-secret',
  instanceToken = 'dht_legacy-instance-secret',
} = {}) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE namespaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE registry_keys (
      id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL REFERENCES namespaces(id), secret TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, rotated_at INTEGER
    );
    CREATE TABLE instances (
      id TEXT PRIMARY KEY, namespace_id TEXT NOT NULL REFERENCES namespaces(id), delivery TEXT NOT NULL,
      hostname TEXT, dsh_version TEXT, status TEXT NOT NULL, connected_at INTEGER, last_seen INTEGER,
      dsh_online INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE instance_tokens (
      id TEXT PRIMARY KEY, instance_id TEXT NOT NULL REFERENCES instances(id), secret TEXT NOT NULL,
      issued_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
    );
  `);
  db.prepare('INSERT INTO namespaces VALUES (?,?,?,?)').run('ns_legacy', 'legacy', 'owner', 1);
  db.prepare('INSERT INTO registry_keys VALUES (?,?,?,?,?,NULL)')
    .run('rk_legacy', 'ns_legacy', registryKey, 'active', 2);
  db.prepare('INSERT INTO instances VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('inst_legacy', 'ns_legacy', 'agent', 'legacy-host', '0.1.0-rc.7', 'offline', null, 3, 0, 2);
  db.prepare('INSERT INTO instance_tokens VALUES (?,?,?,?,NULL,NULL)')
    .run('tok_legacy', 'inst_legacy', instanceToken, 2);
  db.close();
  return { registryKey, instanceToken };
}
