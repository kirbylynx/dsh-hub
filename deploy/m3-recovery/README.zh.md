# M3 恢复与回滚基线

语言：[English](README.md) | 简体中文

本目录包含 `dsh-hub` 的本地 M3B 恢复基线。

它是演练辅助工具，不是自动化生产部署工具。检查不会 SSH 到服务器，不连接生产服务，
也不会修改代码、配置、Docker volumes、Caddy、Authelia 或真实 DSH 实例。

简要说：本地检查不连接生产服务器，不读取生产 secret，不修改任何生产配置。

## 文件

- `check-recovery.mjs`：恢复 runbook 的本地一致性检查，并用临时数据库执行 SQLite
  备份/恢复 smoke。
- `docs/ops/m3-recovery-runbook.md`：existing-Caddy 部署形态下备份、恢复、升级和
  回滚的操作者 runbook。

## 本地检查

```bash
npm run deploy:m3:recovery:check
```

smoke test 会创建临时 `hub.db`，写入一个 namespace、一个 plugin instance 和一个
active instance token，用 `VACUUM INTO` 创建备份，设置备份权限为 `0600`，恢复到
另一个临时路径，通过当前 schema loader 打开恢复后的数据库，并验证 namespace、
instance、token 和 schema 能读回。

## runbook 覆盖的自托管形态

self-hosted 指南针对 existing-Caddy profile：

- 系统 Caddy 仍然是唯一公网 `:80/:443` listener；
- Docker Compose 只管理 Authelia 和 `dsh-hub-service`；
- `dsh-hub-service` 只绑定 loopback，目前为 `127.0.0.1:18081`；
- SQLite 位于 Docker named volume `hub_data:/data` 内，路径为 `/data/hub.db`；
- SQLite 使用在线备份语义，例如 `VACUUM INTO` 或等价一致性备份；不要直接复制
  正在写入的 WAL 数据库文件。

真实部署的 health、restore、upgrade 和 rollback 需要手工记录证据。本地基线只证明
仓库具备可重复恢复检查，不声明某个真实部署已经完成恢复演练。
