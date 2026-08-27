# dsh-hub 自托管运行手册

语言：[English](m3-runbook.md) | 简体中文

- 状态：v0.1.0 自托管告警与运行手册基线
- 范围：`dsh-hub-service` 自托管部署、内部 `/metrics`、Prometheus 告警响应
- 非范围：托管服务 SLA、长期容量承诺、生产压测报告、用户私有运维记录

本文是公开仓库中的通用运维指南，示例默认使用 `hub.example.com`、
`control.hub.example.com` 和 existing-Caddy 模板。实际域名、服务器路径、
Prometheus 接收人、部署证据和事故记录应放在使用者自己的私有运维 overlay。

## 1. 基本原则

- `/metrics` 只允许 loopback 来源地址和 loopback Host 直连读取；不要从公网域名采集。
- 告警规则不得包含 token、registry key、Authorization、workspace 本机路径、实例标识或 namespace 标识。
- heartbeat `sentAt` age 是 service 观察到的发送时间年龄，不是端到端 RTT。
- 先保全证据再重启：保存 `docker compose ps`、最近日志、`/metrics` 快照和当前 commit。
- 公开 issue、聊天和工单中只粘贴已脱敏日志；凭据、Cookie、请求正文和 workspace 路径不得外发。

## 2. 快速取证命令

existing-Caddy 模板默认后端端口是 `127.0.0.1:18081`：

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
git rev-parse --short HEAD
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service
curl -fsS http://127.0.0.1:18081/healthz -H 'Host: control.hub.example.com'
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' > /tmp/dsh-hub.metrics.$(date +%Y%m%d%H%M%S).txt
```

公开入口必须继续拒绝 `/metrics`：

```bash
curl -i https://control.hub.example.com/metrics
curl -i https://hub.example.com/metrics
```

期望结果是公开入口不返回 Prometheus 指标正文。

## 3. 告警处置

### DshHubServiceScrapeDown

含义：Prometheus 无法抓取内部 `/metrics`。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | head
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=15m dsh-hub-service
```

处置：若 service 不健康，先保存日志和 compose 状态；确认数据库卷存在后再重启 service。若 service 正常，检查 Prometheus scrape target 是否仍指向 loopback 后端，而不是公网 Host。

### DshHubTunnelHandshakeFailures

含义：tunnel 认证或协议握手连续失败。

检查：

```bash
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service | grep -E 'tunnel auth failed|handshake|TOKEN_|PROTO|CAPABILITY'
```

处置：优先区分 token 过期、token 已轮换、client/plugin 版本不匹配和非 loopback target。不要在日志或工单中粘贴 instance token、registry key 或 replacement grant。

### DshHubLimitRejectionBurst

含义：请求大小、会话数、限流或背压限制出现突增拒绝。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_limit_rejections_total|dsh_hub_http_errors_total|dsh_hub_rate_limit_rejections_total'
```

处置：若是 `RATE_LIMITED`，检查是否有重复刷新、自动化脚本或异常客户端；若是 `LIMIT_EXCEEDED`，检查 body/message/session 大小和背压指标，不要直接放宽限制作为第一反应。

### DshHubDshHealthStaleOrOffline

含义：已有 tunnel 报告本地 DSH 健康状态 stale 或 offline。

检查：在 Portal 里对相关实例执行只读诊断，或让实例机器本地检查 DSH 进程和 `127.0.0.1:3080`。

处置：如果 tunnel 在线但 DSH offline，优先重启实例侧 DSH 或 plugin/agent；如果健康状态 stale，检查实例机器休眠、网络抖动和 heartbeat 是否持续。

### DshHubHeartbeatSentAtAgeHigh

含义：service 观察到的 heartbeat `sentAt` age 持续偏高。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_heartbeat_sent_at_age_seconds'
```

处置：把它当作“发送时间年龄”看待，不当作 RTT。结合 event-loop delay、tunnel 是否重连和服务器 CPU/负载判断是否是 service 卡顿、实例机器卡顿或网络排队。

### DshHubRelayBackpressureSustained

含义：relay 正在等待 credit，且未确认字节持续存在。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_relay_credit_waiters|dsh_hub_relay_uncredited_bytes|dsh_hub_relay_queued_bytes'
```

处置：检查是否有大上传、慢浏览器下载、实例 DSH 响应慢或 WebSocket 堆积。若伴随 `LIMIT_EXCEEDED`，保留请求时间窗口和日志后再评估阈值。

### DshHubRelayDownstreamBufferedHigh

含义：tunnel WebSocket、HTTP response 或 browser WebSocket 下游缓冲较高。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_relay_downstream_buffered_bytes'
```

处置：优先排查慢客户端、长响应、浏览器断开未及时传播和网络瓶颈。不要只看 active session 数，应同时看 queued/uncredited/credit wait。

### DshHubSQLiteWriteLatencyHigh

含义：service 层 SQLite 写操作持续变慢。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_sqlite_write_seconds'
df -h
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service | grep -E 'SQLITE|database|disk|busy|locked'
```

处置：先检查磁盘空间、数据库卷、备份任务和锁等待。若怀疑数据库损坏，停止写入前先复制数据库文件，不要原地修复。

### DshHubMemoryHigh

含义：service RSS 超过告警阈值。

检查：

```bash
docker stats --no-stream
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_process_resident_memory_bytes|dsh_hub_process_heap_used_bytes'
```

处置：结合 active sessions、queued bytes、uncredited bytes 和 downstream buffered bytes 判断是否是正常负载、慢下游或泄漏。需要重启时先确认正在进行的会话影响。

### DshHubEventLoopDelayHigh

含义：Node.js event loop delay max 持续偏高。

检查：

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_event_loop_delay_seconds'
top
docker stats --no-stream
```

处置：检查 CPU 饱和、同步磁盘 I/O、日志刷写、异常大请求和容器资源限制。若同时出现 heartbeat age high，应先按 service 卡顿方向排查。

## 4. 告警规则本地校验

```bash
npm run deploy:m3:alerts:check
```

该检查确保告警规则引用的 `dsh_hub_*` 指标来自当前 service 实现，并且不使用高基数或秘密相关标签。
