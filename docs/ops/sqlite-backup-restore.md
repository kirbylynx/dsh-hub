# SQLite backup and restore guide

Language: English | [简体中文](sqlite-backup-restore.zh.md)

dsh-hub stores center state in SQLite. This guide describes safe backup and
restore patterns for the self-hosted existing-Caddy deployment template.

The examples assume:

- Compose directory: `/opt/dsh-hub/deploy/m2-existing-caddy`;
- service container path: `/data/hub.db`;
- Docker volume: `hub_data:/data`.

Adjust these paths in a private operations overlay for your deployment.

## 1. Backup principles

- Do not copy an actively written SQLite database file directly.
- Prefer SQLite online backup semantics, such as `VACUUM INTO` or `.backup`.
- Verify the backup before deploying new code.
- Keep backups private and non-world-readable.
- Never put backups in Git.

## 2. Create a backup

This command uses Node and `better-sqlite3` from the service image, so the host
does not need the `sqlite3` CLI:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
backup_dir="${DSH_HUB_BACKUP_DIR:-/opt/dsh-hub-backups}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
backup_name="hub.backup.$(date +%Y%m%d%H%M%S).db"

docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v "$backup_dir":/backup \
  -e DSH_HUB_BACKUP_NAME="$backup_name" \
  dsh-hub-service \
  node --input-type=module -e '
    import fs from "node:fs";
    import Database from "better-sqlite3";
    const backup = "/backup/" + process.env.DSH_HUB_BACKUP_NAME;
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
```

## 3. Verify in a temporary path

```bash
restore_dir="$(mktemp -d /tmp/dsh-hub-restore.XXXXXX)"
cp "$backup_dir/$backup_name" "$restore_dir/hub.db"
chmod 600 "$restore_dir/hub.db"

docker compose --env-file .env -f docker-compose.yml run --rm --no-deps \
  -v "$restore_dir":/restore:ro \
  dsh-hub-service \
  node --input-type=module -e '
    import Database from "better-sqlite3";
    const db = new Database("/restore/hub.db", { readonly: true, fileMustExist: true });
    try {
      const integrity = db.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") throw new Error("integrity_check=" + integrity);
      console.log(JSON.stringify({
        schemaVersion: db.prepare("SELECT version FROM schema_migration ORDER BY version DESC LIMIT 1").get()?.version ?? null,
        namespaces: db.prepare("SELECT count(*) AS count FROM namespaces").get().count,
        activeInstances: db.prepare("SELECT count(*) AS count FROM instances WHERE state = ?").get("active").count,
        activeTokens: db.prepare("SELECT count(*) AS count FROM instance_tokens WHERE revoked_at IS NULL").get().count,
        deploymentModes: db.prepare("SELECT coalesce(deployment_mode, ?) AS mode, count(*) AS count FROM instances GROUP BY coalesce(deployment_mode, ?)").all("unknown", "unknown"),
        auditEvents: db.prepare("SELECT count(*) AS count FROM audit_events").get().count,
      }));
    } finally {
      db.close();
    }
  '
```

The temporary restore verifies that the backup is readable without replacing the
live database.

## 4. Evidence to keep privately

Record:

- source commit;
- Compose file and `.env` path;
- backup file path, size, and mode;
- integrity check result;
- schema version;
- namespace, instance, active token, deployment mode, and audit-event summaries;
- temporary restore path and cleanup decision.

Do not record token values, keyring contents, cookies, Authorization headers, or
provider API keys.

## 5. Real overwrite restore

Replacing the live database is a destructive operation. Do it only during an
explicit incident or maintenance window.

Minimum requirements:

1. Stop `dsh-hub-service`.
2. Preserve the current `hub.db`, `hub.db-wal`, and `hub.db-shm` if present.
3. Copy the verified backup into the service volume as `/data/hub.db`.
4. Set mode `0600`.
5. Start `dsh-hub-service`.
6. Verify `/healthz`, Portal access, instance lists, and reconnect behavior.

If the schema did not change, prefer code-only rollback over database rollback
to avoid losing registrations, token rotations, and audit events created after
the backup.
