# dsh-hub self-hosted backup, restore, upgrade and rollback guide

Language: English | [简体中文](m3-recovery-runbook.zh.md)

This public guide covers the v0.1.0 self-hosted recovery baseline. Examples use
the existing-Caddy deployment template, where system Caddy owns public 80/443 and
Docker Compose manages only Authelia plus `dsh-hub-service`. In this template,
SQLite lives at `/data/hub.db` inside the service container and is provided by
the Docker named volume `hub_data:/data`.

Use the commands as templates. Replace paths, hostnames, commit IDs, and
evidence storage locations in a private operations overlay for your own
deployment.

## 1. Scope and prohibited actions

- This guide covers SQLite backups, restore rehearsals, upgrades, rollbacks, and
  evidence capture.
- Rehearse locally or in a temporary directory first. Before overwriting a real
  service, confirm the maintenance window, backup, and rollback point.
- This guide does not cover DNS automation, full Caddy replacement, Authelia user
  database reset, or real DSH instance repair.
- Do not directly copy an actively written `hub.db`/`hub.db-wal` as a backup.
  Use `VACUUM INTO` or an equivalent consistent SQLite backup.
- Do not record registry keys, replacement grants, instance tokens, pepper
  keyrings, Authelia secrets, or user passwords in chats, logs, runbooks, or
  manifests.

## 2. Backup baseline

Service pre-check:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
git rev-parse HEAD
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/healthz
```

Run the SQLite online backup while the service is healthy, using a one-off
Compose container that mounts `hub_data:/data` plus a host backup directory. Do
not assume the host has a `/var/lib/...` bind-mount path:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
mkdir -p /srv/dsh-hub/backups
chmod 700 /srv/dsh-hub/backups
docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v /srv/dsh-hub/backups:/backup \
  dsh-hub-service \
  node --input-type=module -e '
    import fs from "node:fs";
    import Database from "better-sqlite3";
    const backup = "/backup/hub.backup.YYYYMMDDHHMMSS.db";
    const db = new Database("/data/hub.db", { fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("integrity_check=" + integrity);
      db.prepare("VACUUM INTO ?").run(backup);
    } finally {
      db.close();
    }
    fs.chmodSync(backup, 0o600);
  '
chmod 600 /srv/dsh-hub/backups/hub.backup.YYYYMMDDHHMMSS.db
docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v /srv/dsh-hub/backups:/backup:ro \
  dsh-hub-service \
  node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database("/backup/hub.backup.YYYYMMDDHHMMSS.db", { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("integrity_check=" + integrity);
    } finally {
      db.close();
    }
  '
```

The commands reuse Node/better-sqlite3 from the image, so the host does not need
the `sqlite3` CLI. The script only reads `/data/hub.db` and `/backup`; it must
not print secret file contents.

Record at least the following for every backup:

- current Git commit;
- compose file path and `.env` path;
- database source: `/data/hub.db` inside Docker named volume `hub_data:/data`;
- backup file path, permissions, and size;
- `PRAGMA integrity_check` result;
- `/healthz` result before and after the backup.

## 3. Restore rehearsal

Prefer a temporary directory for restore rehearsals so the service volume is not
overwritten:

```bash
mkdir -p /tmp/dsh-hub-restore
cp /srv/dsh-hub/backups/hub.backup.YYYYMMDDHHMMSS.db /tmp/dsh-hub-restore/hub.db
chmod 600 /tmp/dsh-hub-restore/hub.db
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v /tmp/dsh-hub-restore:/restore:ro \
  dsh-hub-service \
  node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database("/restore/hub.db", { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("integrity_check=" + integrity);
      console.log(JSON.stringify({
        namespaces: db.prepare("SELECT count(*) AS count FROM namespaces").get().count,
        activeInstances: db.prepare("SELECT count(*) AS count FROM instances WHERE state = ?").get("active").count,
      }));
    } finally {
      db.close();
    }
  '
```

A temporary restore environment must use token pepper and idempotency encryption
keyrings equivalent to the target service; otherwise historical digests and
idempotent responses cannot be verified. Restore verification records counts,
schema version, instance state, and health checks only. It must not record any
plaintext token or key.

Overwrite restore for the service volume is allowed only during an explicit
incident or maintenance window:

1. Stop `dsh-hub-service` while leaving Caddy and Authelia unchanged.
2. Use a one-off Compose container to move `/data/hub.db`, `/data/hub.db-wal`,
   and `/data/hub.db-shm` if present into incident backup files under `/backup`.
3. Copy the verified backup to `/data/hub.db` inside the Docker volume and set
   mode `0600`; do not mix old WAL/SHM files with the new main database.
4. Start `dsh-hub-service`.
5. Verify `/healthz`, Portal login, namespace/instance lists, and registered
   instance reconnects.
6. Record restore start/end time and whether instance-side reconnects were
   required.

Overwrite restore command shape:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml stop dsh-hub-service
docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v /srv/dsh-hub/backups:/backup \
  dsh-hub-service \
  sh -lc '
    set -eu
    backup=/backup/hub.backup.YYYYMMDDHHMMSS.db
    stamp=$(date +%Y%m%d%H%M%S)
    test -r "$backup"
    cp "$backup" /data/hub.db.restore.tmp
    chmod 600 /data/hub.db.restore.tmp
    node --input-type=module -e "
      import Database from \"better-sqlite3\";
      const db = new Database(\"/data/hub.db.restore.tmp\", { readonly: true, fileMustExist: true });
      try {
        const integrity = db.pragma(\"integrity_check\", { simple: true });
        if (integrity !== \"ok\") throw new Error(\"integrity_check=\" + integrity);
      } finally {
        db.close();
      }
    "
    mv /data/hub.db /backup/hub.incident.$stamp.db
    if [ -e /data/hub.db-wal ]; then mv /data/hub.db-wal /backup/hub.incident.$stamp.db-wal; fi
    if [ -e /data/hub.db-shm ]; then mv /data/hub.db-shm /backup/hub.incident.$stamp.db-shm; fi
    mv /data/hub.db.restore.tmp /data/hub.db
    node --input-type=module -e "
      import Database from \"better-sqlite3\";
      const db = new Database(\"/data/hub.db\", { readonly: true, fileMustExist: true });
      try {
        const integrity = db.pragma(\"integrity_check\", { simple: true });
        if (integrity !== \"ok\") throw new Error(\"integrity_check=\" + integrity);
      } finally {
        db.close();
      }
    "
  '
docker compose --env-file .env -f docker-compose.yml up -d dsh-hub-service
curl -fsS http://127.0.0.1:18081/healthz
```

## 4. Upgrade procedure

Upgrade in this order: backup first, switch commit second, rebuild backend
third, and run health checks last.

```bash
cd /opt/dsh-hub
git rev-parse HEAD
git fetch origin
git checkout <TARGET_COMMIT>
npm run deploy:m2:existing-caddy:check
npm run deploy:m3:alerts:check
npm run deploy:m3:recovery:check
cd deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
curl -fsS http://127.0.0.1:18081/healthz
```

Before upgrading, ensure there is a DB backup that passed `integrity_check`, and
record the current commit as the rollback target. For schema changes, first boot
the target version against a backup copy and confirm the schema loader,
namespace/instance readback, and token verification paths before upgrading the
service volume.

## 5. Rollback procedure

The default rollback decision window is 15 minutes after upgrade. Roll back
immediately if any of the following occurs:

- `/healthz` keeps failing;
- Portal login works but namespace/instance lists cannot be loaded;
- many online clients/plugins cannot handshake;
- the SQLite schema loader reports an unsupported version;
- other existing sites regress in an existing-Caddy setup.

Code rollback:

```bash
cd /opt/dsh-hub
git checkout <PREVIOUS_COMMIT>
npm run deploy:m2:existing-caddy:check
cd deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
curl -fsS http://127.0.0.1:18081/healthz
```

Database rollback should be performed only if the upgrade changed schema or data
and the old code cannot read the current DB. Preserve an incident backup of the
current DB before doing so; verify afterward with the overwrite restore steps in
Section 3. If the schema did not change, prefer code-only rollback to avoid
losing registrations, token rotations, and audit records created during the
upgrade window.

## 6. Acceptance evidence

Local baseline:

```bash
npm run deploy:m3:recovery:check
```

Recommended evidence for a real deployment drill:

- backup manifest: commit, DB source path, backup path, permissions, size, and
  integrity result;
- restore manifest: restore path, schema version, namespace/instance/token
  readback counts;
- upgrade manifest: from/to commit, compose config check, image build, and
  health checks;
- rollback manifest: trigger reason, rollback commit, whether DB restore was
  needed, and post-rollback health checks;
- external validation: Portal, control health, auth host, and at least one
  registered instance domain authentication redirect or access result;
- existing-Caddy validation that other sites did not regress.

The public repository command `npm run deploy:m3:recovery:check` proves only
that the local recovery/rollback rehearsal baseline is repeatable. It is not
evidence that any real deployment has completed a restore drill.
