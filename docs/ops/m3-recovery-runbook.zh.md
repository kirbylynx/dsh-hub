# dsh-hub 自托管备份、恢复、升级与回滚指南

语言：[English](m3-recovery-runbook.md) | 简体中文

本文是公开的 v0.1.0 自托管恢复基线指南。示例使用 existing-Caddy 部署模板：
系统 Caddy 占用公网 80/443，Docker Compose 只管理 Authelia 和
`dsh-hub-service`。在该模板中，SQLite 位于 service 容器内的 `/data/hub.db`，
由 Docker named volume `hub_data:/data` 提供。

这些命令只是模板。你自己的部署应在私有运维 overlay 中替换路径、hostname、commit
ID 和证据保存位置。

## 1. 范围和禁止事项

- 本手册覆盖 SQLite 备份、恢复演练、升级、回滚和证据记录。
- 默认先在本地或临时目录演练；覆盖真实服务前必须单独确认维护窗口、备份和回滚点。
- 不覆盖 DNS 自动配置、Caddy 全量替换、Authelia 用户库重置或真实 DSH 实例修复。
- 不直接复制正在写入的 `hub.db`/`hub.db-wal` 作为备份；使用 `VACUUM INTO` 或等价 SQLite 一致性备份。
- 不在聊天、日志、runbook 或 manifest 中记录 registry key、replacement grant、instance token、pepper keyring、Authelia secret 或用户密码。

## 2. 备份基线

服务前置检查：

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
git rev-parse HEAD
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/healthz
```

SQLite 在线备份建议在 service 正常运行时，通过一次性 compose 容器挂载
`hub_data:/data` 和宿主机备份目录来执行；不要假设宿主机存在
`/var/lib/...` 形式的 bind mount：

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

上述命令复用镜像内的 Node/better-sqlite3，不需要宿主机安装 `sqlite3`
CLI。脚本只访问 `/data/hub.db` 和 `/backup`，不得打印 secret 文件内容。

每次备份至少记录：

- 当前 Git commit；
- compose 文件路径和 `.env` 路径；
- 数据库源位置：Docker named volume `hub_data:/data` 内的 `/data/hub.db`；
- 备份文件路径、权限和大小；
- `PRAGMA integrity_check` 结果；
- 备份前后的 `/healthz` 结果。

## 3. 恢复演练

恢复演练优先使用临时目录，不覆盖服务卷：

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

临时恢复环境启动时必须使用与目标服务等价的 token pepper keyring 和
idempotency encryption keyring，否则历史摘要和幂等响应无法校验。恢复验证
只记录计数、schema version、实例状态和健康检查，不记录任何 token/key 明文。

覆盖服务卷恢复只允许在明确事故或维护窗口内执行：

1. 停止 `dsh-hub-service`，保持 Caddy/Authelia 不变。
2. 用一次性 compose 容器把 `/data/hub.db`、`/data/hub.db-wal` 和
   `/data/hub.db-shm`（若存在）移动到 `/backup` 下的事故备份文件。
3. 将已验证备份复制为 Docker volume 内的 `/data/hub.db` 并设置 `0600`；
   不要保留旧 WAL/SHM 与新主库混用。
4. 启动 `dsh-hub-service`。
5. 验证 `/healthz`、Portal 登录、namespace/instance 列表、已注册实例重新建连。
6. 记录恢复开始/结束时间和是否需要 instance 侧重连。

覆盖恢复命令形态：

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

## 4. 升级流程

升级使用“先备份、再切 commit、再重建后端、最后健康检查”的顺序：

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

升级前必须已有一份通过 `integrity_check` 的 DB 备份，并记录当前 commit
作为回滚目标。涉及 schema 变化时，必须先在备份副本上启动目标版本，确认
schema loader、namespace/instance 读回和 token 校验路径均通过，再对服务卷
执行升级。

## 5. 回滚流程

回滚决策窗口默认为升级后 15 分钟，若出现以下情况应立即回滚：

- `/healthz` 持续失败；
- Portal 登录后无法列出 namespace/instance；
- 已在线 client/plugin 大面积无法握手；
- SQLite schema loader 报不支持版本；
- existing-Caddy 场景下已有其它站点出现回归。

代码回滚：

```bash
cd /opt/dsh-hub
git checkout <PREVIOUS_COMMIT>
npm run deploy:m2:existing-caddy:check
cd deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
curl -fsS http://127.0.0.1:18081/healthz
```

数据库回滚只有在升级已经改变 schema 或数据且旧代码无法读取当前 DB 时才执行。
执行前必须保留当前 DB 的事故备份；执行后按 §3 的覆盖恢复步骤验证。若
schema 未改变，优先只回滚代码，避免丢失升级期间的新注册、token 轮换和审计。

## 6. 验收证据

本地基线：

```bash
npm run deploy:m3:recovery:check
```

真实部署演练证据建议包含：

- 备份 manifest：commit、DB 源路径、备份路径、权限、大小、integrity 结果；
- 恢复 manifest：恢复路径、schema version、namespace/instance/token 读回计数；
- 升级 manifest：from/to commit、compose config 检查、镜像构建、健康检查；
- 回滚 manifest：触发原因、回滚 commit、是否恢复 DB、恢复后健康检查；
- 对外验证：Portal、control health、auth host、至少一个已注册 instance 域名的认证跳转或可访问结果；
- existing-Caddy 场景下，已有站点无回归验证。

公开仓库中的 `npm run deploy:m3:recovery:check` 只证明本地恢复/回滚演练基线可重复，不等同于某个真实部署已经完成恢复演练。
