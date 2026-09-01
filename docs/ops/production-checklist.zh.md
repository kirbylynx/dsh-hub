# 生产就绪检查清单

语言：[English](production-checklist.md) | 简体中文

本文用于自托管 `dsh-hub` 部署，说明在把某个部署视为生产化之前，operator 应该检查什么。它是模板，不是任何具体服务器已经通过检查的证明。

真实域名、IP、路径、凭据、备份清单和部署证据应保存在你自己的私有运维 overlay 中。

## 1. 仓库与版本状态

- 部署前先选择明确的 Git commit 或 release tag。
- 部署证据不要放进公开仓库。
- 记录 Hub service 使用的 commit；如果启用 hosted DSH，也记录 hosted DSH 部署模板使用的 commit。
- 构建镜像前确认工作区干净：

```bash
git status --short --branch
git rev-parse HEAD
git tag --points-at HEAD
```

## 2. 密钥与配置

- `.env`、Authelia secrets、registry key、replacement grant、instance token、provider API key、cookie 和 TLS 私钥都不能进入 Git。
- 一次性凭据优先通过 `.env`、stdin 或私有 secret 文件提供，避免放进命令行参数。
- 确认公开示例仍使用 `hub.example.com`、`control.hub.example.com`、`*.instances.hub.example.com` 等占位符。
- 在 issue、聊天或工单里分享证据前，先人工审查和脱敏。

## 3. existing-Caddy 边界

如果使用 existing-Caddy profile：

- system Caddy 仍是唯一公开 `:80/:443` 监听者；
- Docker Compose 只管理后端服务；
- `dsh-hub-service` 应只绑定 loopback；
- Caddy 和 Authelia 配置修改前应先 validate；
- 如果 dsh-hub 路由没有变化，不要仅因为代码部署而 reload Caddy。

参见 [existing-Caddy 共存指南](existing-caddy-coexistence.zh.md)。

## 4. 升级前备份

修改代码或镜像前：

- 使用 `VACUUM INTO` 等在线备份语义创建 SQLite 备份；
- 用 `PRAGMA integrity_check` 验证备份；
- 在临时路径恢复或打开备份，并读取关键表摘要；
- 备份文件应保持私有，且不能 world-readable。

参见 [SQLite 备份与恢复](sqlite-backup-restore.zh.md)。

## 5. 本地模板检查

按部署 profile 运行对应检查：

```bash
npm test
npm run deploy:m2:check
npm run deploy:m2:existing-caddy:check
npm run deploy:m3:alerts:check
npm run deploy:m3:recovery:check
npm run deploy:m3:logging:check
npm run deploy:g11:hosted-dsh:check
npm run test:g13:hosted-model-settings
```

这些检查验证模板和本地行为，不能替代真实服务器健康检查。

## 6. 部署后 smoke checks

部署后验证：

- Compose 配置有效；
- Hub service 正在运行且健康；
- 公开 Portal 路由经认证入口可达；
- 内部 `/metrics` 没有通过公开 host 暴露；
- instance 子域通过认证边缘路由；
- tunnel handshake 和实例状态健康；
- 日志没有持续错误循环。

示例：

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/healthz
```

## 7. Hosted DSH 检查

如果运行 hosted DSH 模板，验证：

- hosted 容器 running/healthy；
- DSH home、workspace 和 logs 已映射到 operator 管理的宿主机目录；
- hosted picker 限制在 `/workspace`；
- plugin tunnel online；
- instance URL 能通过 Hub 边缘入口打开；
- `/plugins/dsh-hub-plugin/model-settings.json` 只返回脱敏模型设置摘要，不暴露 API key 或 raw credential reference。

参见 [deploy/hosted-dsh/README.zh.md](../../deploy/hosted-dsh/README.zh.md)。

## 8. v0.1.x 已知非目标

v0.1.x 自托管基线不是 hostile-tenant SaaS 平台。它尚未提供通用多用户角色、管理员界面、高可用、自动 hosted 实例分配、真实 Alertmanager 接收人配置或生产长时压测报告。
