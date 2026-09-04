#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  createNamespace,
  getSchemaVersion,
  issueInstanceToken,
  listInstances,
  listNamespaces,
  openDb,
  registerInstance,
} from '../../packages/dsh-hub-service/src/db.js';
import { makeInstallationId } from '../../packages/dsh-hub-service/src/security.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const runbookPath = path.join(repoRoot, 'docs/ops/m3-recovery-runbook.md');
const readmePath = path.join(repoRoot, 'deploy/m3-recovery/README.md');
const existingCaddyComposePath = path.join(repoRoot, 'deploy/m2-existing-caddy/docker-compose.yml');

const requiredRunbookHeadings = [
  '## 1. Scope and prohibited actions',
  '## 2. Backup baseline',
  '## 3. Restore rehearsal',
  '## 4. Upgrade procedure',
  '## 5. Rollback procedure',
  '## 6. Acceptance evidence',
];

const requiredReadmePhrases = [
  'npm run deploy:m3:recovery:check',
  'does not connect production services',
  'VACUUM INTO',
  'existing-Caddy',
];

const forbiddenDocPatterns = [
  /rm\s+-rf\s+\//i,
  /\bTOKEN_PEPPER_KEYRING\s*=\s*['"]?\{/,
  /\bIDEMPOTENCY_ENCRYPTION_KEYRING\s*=\s*['"]?\{/,
  /\bdhk_[A-Za-z0-9_-]+/,
  /\bdht_[A-Za-z0-9_-]+/,
  /\bdhr_[A-Za-z0-9_-]+/,
];

const requiredManifestFields = [
  'schema',
  'kind',
  'createdAt',
  'source',
  'backup',
  'restore',
  'upgrade',
  'rollback',
  'checks',
];

try {
  checkDocs();
  const evidence = runSqliteRecoverySmoke();
  console.log(JSON.stringify({
    ok: true,
    docs: {
      runbook: path.relative(repoRoot, runbookPath),
      readme: path.relative(repoRoot, readmePath),
    },
    sqliteRecoverySmoke: evidence,
  }, null, 2));
} catch (err) {
  console.error('M3 recovery check failed:', err?.stack || err);
  process.exit(1);
}

function checkDocs() {
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const existingCaddyCompose = fs.readFileSync(existingCaddyComposePath, 'utf8');

  for (const heading of requiredRunbookHeadings) {
    if (!runbook.includes(heading)) throw new Error(`runbook missing heading: ${heading}`);
  }
  for (const phrase of requiredReadmePhrases) {
    if (!readme.includes(phrase)) throw new Error(`README missing phrase: ${phrase}`);
  }
  for (const pattern of forbiddenDocPatterns) {
    if (pattern.test(runbook) || pattern.test(readme)) {
      throw new Error(`recovery docs contain forbidden secret/destructive pattern: ${pattern}`);
    }
  }
  if (!/-\s+--db\s*\n\s+-\s+\/data\/hub\.db/.test(existingCaddyCompose)) {
    throw new Error('existing-Caddy compose no longer declares --db /data/hub.db');
  }
  if (!/-\s+hub_data:\/data\b/.test(existingCaddyCompose)) {
    throw new Error('existing-Caddy compose no longer mounts hub_data:/data');
  }
  if (!runbook.includes('/data/hub.db') || !runbook.includes('hub_data:/data')) {
    throw new Error('runbook must describe the existing-Caddy named volume and /data/hub.db path');
  }
  if (runbook.includes('/var/lib/dsh-hub/hub.db')) {
    throw new Error('runbook must not use a host bind-mount DB path for the existing-Caddy profile');
  }
  for (const phrase of ['set -eu', 'hub.db.restore.tmp', 'test -r "$backup"', 'mv /data/hub.db.restore.tmp /data/hub.db']) {
    if (!runbook.includes(phrase)) throw new Error(`runbook restore command missing safety phrase: ${phrase}`);
  }
  if (/`integrity_check=\$\{integrity\}`/.test(runbook)) {
    throw new Error('runbook restore command must not use JS template literals inside sh -lc node -e snippets');
  }
  if (!runbook.includes('throw new Error(\\"integrity_check=\\" + integrity)')) {
    throw new Error('runbook restore command must use shell-safe integrity_check string concatenation');
  }

  const manifest = exampleManifest();
  for (const field of requiredManifestFields) {
    if (!Object.hasOwn(manifest, field)) throw new Error(`manifest missing field: ${field}`);
  }
  assert.equal(manifest.schema, 'dsh-hub.m3.recovery-rehearsal.v1');
  assert.equal(manifest.kind, 'local-rehearsal');
  assert.equal(manifest.source.dbPath, '/data/hub.db');
  assert.equal(manifest.source.dockerVolume, 'hub_data');
  assert.ok(manifest.rollback.decisionWindowMinutes > 0);
  assert.ok(manifest.checks.every((check) => check.name && check.status));
}

function runSqliteRecoverySmoke() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshhub-m3-recovery-'));
  try {
    const sourceDbPath = path.join(tempDir, 'source', 'hub.db');
    const backupPath = path.join(tempDir, 'backups', 'hub.backup.db');
    const restoredDbPath = path.join(tempDir, 'restored', 'hub.db');
    fs.mkdirSync(path.dirname(sourceDbPath), { recursive: true });
    fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(restoredDbPath), { recursive: true });

    const options = securityOptions();
    const source = openDb(sourceDbPath, options);
    const namespace = createNamespace(source, { name: 'm3-recovery', ownerUserId: 'owner' });
    const instance = registerInstance(source, {
      namespaceId: namespace.namespaceId,
      installationId: makeInstallationId(),
      delivery: 'plugin',
      hostname: 'recovery-host',
      clientVersion: '0.1.0',
      dshVersion: '0.1.0-rc.7',
    });
    issueInstanceToken(source, instance.id);
    const sourceSchema = getSchemaVersion(source);
    assert.ok(fs.existsSync(`${sourceDbPath}-wal`), 'source should still have an active WAL file before online backup');

    createSqliteBackup(sourceDbPath, backupPath);
    source.close();
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);

    fs.copyFileSync(backupPath, restoredDbPath);
    fs.chmodSync(restoredDbPath, 0o600);
    const restored = openDb(restoredDbPath, options);
    const restoredSchema = getSchemaVersion(restored);
    const namespaces = listNamespaces(restored, 'owner', { limit: 10 });
    const instances = listInstances(restored, 'owner', { namespaceId: namespace.namespaceId, limit: 10 });
    const tokenCount = restored.prepare('SELECT count(*) AS count FROM instance_tokens WHERE instance_id = ? AND revoked_at IS NULL')
      .get(instance.id).count;
    const instanceTokenSecretColumns = restored.prepare(`
      SELECT name
        FROM pragma_table_info('instance_tokens')
       WHERE lower(name) LIKE '%secret%'
    `).all();
    const registrySecretAvailable = restored.prepare(`
      SELECT 1 AS ok
        FROM pragma_table_info('registry_keys')
       WHERE name='secret_available'
    `).get();
    restored.close();

    assert.equal(restoredSchema.version, sourceSchema.version);
    assert.equal(namespaces.length, 1);
    assert.equal(namespaces[0].id, namespace.namespaceId);
    assert.equal(instances.length, 1);
    assert.equal(instances[0].id, instance.id);
    assert.equal(instances[0].state, 'active');
    assert.equal(tokenCount, 1);
    assert.equal(instanceTokenSecretColumns.length, 0);
    assert.equal(registrySecretAvailable.ok, 1);

    const manifest = exampleManifest({
      sourceDbPath,
      backupPath,
      restoredDbPath,
      namespaceId: namespace.namespaceId,
      instanceId: instance.id,
    });
    validateEvidenceManifest(manifest);

    return {
      schemaVersion: restoredSchema.version,
      namespaceCount: namespaces.length,
      instanceCount: instances.length,
      activeTokenCount: tokenCount,
      backupMode: '0600',
      sourceConnectionOpenDuringBackup: true,
      manifestSchema: manifest.schema,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createSqliteBackup(sourceDbPath, backupPath) {
  const db = new Database(sourceDbPath, { fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    assert.equal(integrity, 'ok');
    db.prepare('VACUUM INTO ?').run(backupPath);
  } finally {
    db.close();
  }
  fs.chmodSync(backupPath, 0o600);
}

function validateEvidenceManifest(manifest) {
  for (const field of requiredManifestFields) {
    assert.ok(Object.hasOwn(manifest, field), `manifest missing ${field}`);
  }
  assert.equal(manifest.schema, 'dsh-hub.m3.recovery-rehearsal.v1');
  assert.ok(manifest.source.dbPath);
  assert.ok(manifest.backup.path);
  assert.ok(manifest.restore.restoredDbPath);
  assert.ok(manifest.upgrade.fromCommit);
  assert.ok(manifest.upgrade.toCommit);
  assert.ok(manifest.rollback.toCommit);
  assert.ok(manifest.checks.length >= 4);
}

function exampleManifest(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema: 'dsh-hub.m3.recovery-rehearsal.v1',
    kind: 'local-rehearsal',
    createdAt: now,
    source: {
      profile: 'm2-existing-caddy',
      dockerVolume: 'hub_data',
      volumeMount: '/data',
      dbPath: overrides.sourceDbPath ?? '/data/hub.db',
      commitBefore: 'CURRENT_COMMIT',
    },
    backup: {
      path: overrides.backupPath ?? '/srv/dsh-hub/backups/hub.backup.YYYYMMDDHHMMSS.db',
      method: 'sqlite-vacuum-into',
      mode: '0600',
      integrityCheck: 'ok',
    },
    restore: {
      restoredDbPath: overrides.restoredDbPath ?? '/tmp/dsh-hub-restore/hub.db',
      namespaceId: overrides.namespaceId ?? 'ns_example',
      instanceId: overrides.instanceId ?? 'inst-exampleexampleexampleexamp',
    },
    upgrade: {
      fromCommit: 'CURRENT_COMMIT',
      toCommit: 'TARGET_COMMIT',
      composeProfile: 'deploy/m2-existing-caddy/docker-compose.yml',
      healthUrl: 'http://127.0.0.1:18081/healthz',
    },
    rollback: {
      toCommit: 'CURRENT_COMMIT',
      databaseAction: 'restore-pre-upgrade-backup-if-schema-or-data-changed',
      decisionWindowMinutes: 15,
    },
    checks: [
      { name: 'sqlite_integrity_check', status: 'pass' },
      { name: 'namespace_readback', status: 'pass' },
      { name: 'instance_readback', status: 'pass' },
      { name: 'healthz_after_start', status: 'manual-required-for-production' },
    ],
  };
}

function securityOptions(overrides = {}) {
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
