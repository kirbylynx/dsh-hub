# SQLite 备份与恢复指南

语言：[English](sqlite-backup-restore.md) | 简体中文

dsh-hub 使用 SQLite 保存中心状态。本文描述自托管 existing-Caddy 部署模板中的安全备份和恢复模式。

示例假设：

- Compose 目录：`/opt/dsh-hub/deploy/m2-existing-caddy`；
- service 容器内路径：`/data/hub.db`；
- Docker volume：`hub_data:/data`。

请在自己的私有运维 overlay 中调整这些路径。

## 1. 备份原则

- 不要直接复制正在写入的 SQLite 数据库文件。
- 优先使用 `VACUUM INTO` 或 `.backup` 等 SQLite 在线备份语义。
- 部署新代码前先验证备份。
- 备份应保持私有，不能 world-readable。
- 备份不能进入 Git。

## 2. 创建备份

此命令使用 service 镜像内的 Node 和 `better-sqlite3`，宿主机不需要安装 `sqlite3` CLI：

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

## 3. 在临时路径验证

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

临时恢复验证可以证明备份可读，但不会替换线上数据库。

## 4. 私有保存的证据

记录：

- source commit；
- Compose 文件和 `.env` 路径；
- 备份文件路径、大小和权限；
- integrity check 结果；
- schema version；
- namespace、instance、active token、deployment mode 和 audit event 摘要；
- 临时恢复路径和清理决定。

不要记录 token 值、keyring 内容、cookie、Authorization header 或 provider API key。

## 5. 真实覆盖恢复

替换线上数据库是破坏性操作。只应在明确事故或维护窗口内执行。

最低要求：

1. 停止 `dsh-hub-service`。
2. 保留当前 `hub.db`、`hub.db-wal` 和 `hub.db-shm`。
3. 将已验证备份复制到 service volume 中的 `/data/hub.db`。
4. 设置权限 `0600`。
5. 启动 `dsh-hub-service`。
6. 验证 `/healthz`、Portal 访问、实例列表和实例重连行为。

如果 schema 没有变化，优先做 code-only rollback，避免丢失备份之后产生的注册、token rotation 和 audit event。
