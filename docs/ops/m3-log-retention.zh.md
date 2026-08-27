# dsh-hub 自托管日志与脱敏指南

语言：[English](m3-log-retention.md) | 简体中文

- 状态：v0.1.0 自托管日志保留/脱敏基线
- 范围：Docker Compose 容器日志轮转、事故取证命令、日志脱敏约束和本地验收检查
- 非范围：托管服务日志平台、Alertmanager 接收人配置、长期合规归档、用户私有运维记录

本文是公开仓库中的通用指南。实际日志平台、保留周期、告警接收人、服务器路径
和事故证据应放在使用者自己的私有运维 overlay。

## 1. 范围和边界

本基线只约束本仓库管理的 Docker Compose 容器日志：

- `deploy/m2-local/docker-compose.yml`：`caddy`、`authelia`、`dsh-hub-service`
- `deploy/m2-existing-caddy/docker-compose.yml`：`authelia`、`dsh-hub-service`

existing-Caddy 部署模式下，宿主机已有系统 Caddy 仍由服务器现有配置管理；
dsh-hub 不接管系统 Caddy 的日志、轮转或其它站点配置。若后续需要采集系统
Caddy 访问日志，必须先单独确认不会影响同机已有站点。

## 2. 保留策略

Compose profiles 使用 Docker `json-file` driver，并设置每容器 `10m × 7`：

```yaml
x-dsh-hub-log-retention: &dsh-hub-log-retention
  driver: json-file
  options:
    max-size: "10m"
    max-file: "7"
```

该策略是自托管部署的容量护栏：每个容器最多约 70 MiB Docker stdout/stderr
日志，不替代审计表、Prometheus 指标或故障演练证据。若接入 Loki、
CloudWatch、Vector、Fluent Bit 等外部日志系统，应保留同等或更严格的本地
轮转上限，并把外部保留周期作为单独运维决策记录。

## 3. 取证步骤

发生告警、异常断连或升级失败时，先保全短窗口证据，再重启或回滚：

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service > /tmp/dsh-hub-service.logs
docker compose --env-file .env -f docker-compose.yml logs --since=30m authelia > /tmp/dsh-hub-authelia.logs
curl -fsS -H 'Host: 127.0.0.1' http://127.0.0.1:18081/metrics > /tmp/dsh-hub.metrics
git -C /opt/dsh-hub rev-parse HEAD > /tmp/dsh-hub.commit
```

如需保存 Docker JSON 日志文件本身，应通过 `docker inspect` 精确定位单个容器
的 `LogPath`，不得对 Docker 根目录做递归复制或清理。

## 4. 脱敏约束

不得粘贴 registry key、replacement grant、instance token、Authorization 或 Cookie
到聊天、issue、工单、runbook、manifest 或长期日志系统。允许记录：

- instance ID、namespace ID 的短窗口问题定位信息；
- 有限错误码，例如 `TOKEN_EXPIRED`、`TOKEN_ROTATED`、`LIMIT_EXCEEDED`；
- 汇总指标、状态计数、时间戳、commit 和 compose profile；
- 已脱敏的一小段日志，且必须先人工确认没有凭据、请求/响应正文或本机 workspace 路径。

service/client 的通用 `log()` 会在 stdout 前对凭据形态、Bearer token、Cookie 和
敏感字段做基础脱敏；这只是防线之一，不能替代操作者在外发日志前的二次检查。

## 5. 验收证据

本地验收命令：

```bash
npm run deploy:m3:logging:check
```

该完整检查需要本机可执行 `docker compose config --format json`，但不会连接远程
服务器或修改运行配置。根目录 `npm test` 中只纳入不依赖 Docker 的脱敏/文档护栏：

```bash
npm run test:m3:logging-redaction
```

验收通过表示：

- 两个 Compose profile 均声明并应用 `json-file` / `10m × 7` 轮转；
- M3 日志 runbook 明确 existing-Caddy 不接管系统 Caddy；
- service/client 日志 helper 会脱敏 registry key、replacement grant、instance token、
  Bearer Authorization 和 Cookie 形态；
- 检查不连接生产服务器、不读取生产 secret、不修改服务器配置。

真实部署前还需要单独确认 Alertmanager 接收人、外部日志平台、压测窗口和
故障演练窗口；本指南不能被表述为“生产日志体系已完成”。
