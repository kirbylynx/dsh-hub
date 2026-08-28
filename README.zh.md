# dsh-hub

语言：[English](README.md) | 简体中文

语言：[English](README.md) | 简体中文

为多台机器上的 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/dsh) 实例提供**多租户远程接入/控制中心**。

DSH 默认只监听本机回环端口（`127.0.0.1:3080`），并有意拒绝 `--host 0.0.0.0`（防止把 agent 的 shell/文件能力暴露到网络）。`dsh-hub` 通过 **注册 + 出站隧道** 把这些实例接入一个公网中心，用户在中心经 **Authelia** 认证后，在一个门户里切换 namespace / 实例，并以**整页实例入口**作为可靠路径复用 DSH 原版 Web GUI；iframe 当前只保留为受限/实验入口。

```
                         ┌──────────────────────────────────────────┐
   用户浏览器             │  dsh-hub-service（公网，中心）            │
  ┌──────────┐  https     │                                          │
  │  Portal   │ ────────▶ │  Authelia（边缘认证）                    │
  └──────────┘            │     │                                    │
       │ 整页入口 / iframe │     ▼                                    │
       │ instA.hub...     │  HTTP+WS 反代 + 隧道中继                 │
       └─────────────────▶│     │                                    │
                          │     ▼                                    │
                          │  注册表（namespace/instance/token）       │
                          └──────────────┬───────────────────────────┘
                                          │ 出站 wss 隧道（实例→中心）
                            ┌─────────────┴───────────────┐
                            │                             │
                   ┌────────▼──────────┐         ┌────────▼──────────┐
                   │ dsh-hub-plugin    │         │ dsh-hub-client    │
                   │（DSH 进程内插件）  │         │（独立进程，npm）  │
                   │  ┌─ DSH web ──┐   │         │  ┌─ DSH web ──┐   │
                   │  │127.0.0.1:P │   │         │  │127.0.0.1:3080│  │
                   │  └────────────┘   │         │  └─────────────┘   │
                   └───────────────────┘         └────────────────────┘
```

- **星型拓扑**：每台实例各自**出站**连接中心，无需公网端口、无需 P2P。
- 中心只做「注册 + 中继 + 门户 + 认证」，**不理解 DSH 业务协议**（字节透传）。
- 实例侧两种交付方式（plugin / client）共享**同一份中继协议**（见 `docs/protocol.md`）。

## 组件

| 组件 | 说明 | 状态 |
|---|---|---|
| `dsh-hub-service` | 中心服务：注册 / 隧道中继 / 门户 / 数据持久化（SQLite），直接运行（node）或 docker-compose（Caddy + Authelia / existing Caddy 后端模式）；M3B-3A 已扩展仅内部 loopback 直连可读的 Prometheus 文本 `/metrics` 运维指标，M3B-3B 已新增 tunnel 级未确认字节总账和高/低水位发送门控，M3B-3C 已补 sender 等待队列公平调度，M3B-3D 已补本地背压容量基线，M3B-4 已补告警规则与运行手册基线，M3B-5 已补本地备份/恢复/升级回滚演练基线，M3B-6 已补 Docker stdout/stderr 日志轮转和 service/client 日志脱敏基线 | v0.1.0 MVP 已收口，可受信试用 |
| `dsh-hub-plugin` | 实例侧交付 A：DSH 进程内插件；已具备默认关闭的 host 插件骨架、显式 `remote-capabilities.patch.yml`、DSH browse picker overlay、hosted `/workspace` 限制 picker overlay、`dsh.client` browser card、plugin tunnel adapter、registry/replacement 入伙、instance credentials 存储、自动建连、token rotate/leave、host/browser 状态视图、本地 DSH session/workspace 诊断摘要、同源只读 live status bridge、`host.describe.canOpenPath=false` UI gating、`dsh-hub-web` 一行启动、只读安装检查、默认 dry-run profile 安装器和复用 `PluginRuntime.join()` 的 plugin 入伙 CLI | v0.1.0 正式推荐主路径 |
| `dsh-hub-client` | 实例侧交付 B：独立进程，`join` / `run` / `status`，可跨 DSH 重启保隧道；新增 `plugin-install-check` / `plugin-install` / `plugin-join` 用于检查、安装和入伙 DSH plugin，其中 `plugin-install` 默认 dry-run，`plugin-join` 推荐从 stdin 读取 secret；定位为试用、链路诊断、应急 fallback 和 plugin 启动辅助 | v0.1.0 fallback/辅助路径 |

术语：**namespace**（租户分组）、**registry key**（namespace 级入伙钥匙）、**instance token**（实例级连接凭据，可轮换/吊销）。

## 快速开始（M1：service + client 直接运行）

> 前置：Node.js ≥ 22（本项目在 Node 24 上开发验证）。

```bash
# 1. 安装依赖
npm install

# 2. 启动中心服务（默认 127.0.0.1:8081，数据落在 ./data/hub.db）
#    DEV_AUTH_USER=dev 仅用于本地开发：模拟 Authelia 认证通过的用户；
#    生产环境必须在前面挂 Authelia（见 docs/plans/...-design.md §7）。
DEV_AUTH_USER=dev node packages/dsh-hub-service/bin/dsh-hub-service.js --port 8081

# 3. 另开终端：实例侧 agent 入伙（交互式录入 endpoint 与 registry key，
#    凭据写入本机 Keychain / 0600 文件）
node packages/dsh-hub-client/bin/dsh-hub-client.js join \
  --endpoint http://127.0.0.1:8081 --registry-key <KEY>

# 4. 运行隧道（把本地 127.0.0.1:3080 的 DSH Web 转发到中心）
node packages/dsh-hub-client/bin/dsh-hub-client.js run

# 5. 可选：采集 M2 只读兼容诊断（session/workspace/events/目录选择器推断）
node packages/dsh-hub-client/bin/dsh-hub-client.js diagnose --json

# 6. 浏览器打开门户 http://127.0.0.1:8081/ ，进入实例子域
#    http://<instanceId>.localhost:8081/   （本地开发用 .localhost 解析回环）
```

### Plugin 远程模式安装、入伙和一行启动（M4D-7B）

`dsh-hub-web` 是 `dsh web` 的安全包装：不保存 registry key / replacement grant / instance token；它只在启动时应用 plugin enabled patch 与显式 `remote-capabilities.patch.yml`，用于远程 browse picker 与 `canOpenPath=false` UI gating。`plugin-install` 默认只做 dry-run，必须显式 `--apply` 才会写 DSH profile；如使用 `--enabled-patch` 自定义文件名，路径也必须留在所选 profile 目录内。

```bash
# 只读检查本机 DSH web profile 是否已装 plugin/overlay/凭据
dsh-hub-client plugin-install-check

# 预览安装：不写 ~/.dsh
dsh-hub-client plugin-install \
  --endpoint https://control.hub.example.com --namespace my-team

# 确认安装：写入 profile package、本地 plugin symlink 和非秘密 enabled patch
dsh-hub-client plugin-install \
  --endpoint https://control.hub.example.com --namespace my-team --apply

# 推荐从 stdin 输入 registry key，避免进入 shell history
printf '%s' "$DSH_HUB_REGISTRY_KEY" | dsh-hub-client plugin-join \
  --endpoint https://control.hub.example.com --registry-key-stdin

# 启动远程 plugin 模式
dsh-hub-web
```

v0.1.0 MVP 已完成 plugin 安装、入伙、启动和远程访问的基础验证。registry key / replacement grant 仍建议通过 stdin 或交互输入，避免进入 shell history；`dsh-hub-web` 本身不保存这些一次性 secret。

### 首次使用：创建 namespace 与 registry key

```bash
# 中心侧（需要 DEV_AUTH_USER 或 Authelia 认证上下文）创建 namespace
curl -H 'x-authenticated-user: dev' http://127.0.0.1:8081/api/namespaces \
  -d '{"name":"my-team"}'
# → 返回 { "namespace": {...}, "registryKey": "dhk_..." }
```

## 安全模型（重要，v1 的唯一安全边界）

**中心认证 = 唯一安全边界。** 经中心转发后，请求对 DSH 而言与「本机浏览器」无异（实例侧会把 Host 改写为 `127.0.0.1`、剥离 Origin / `sec-fetch-*` 头以通过 DSH 的 Host 围栏，包括特权方法）。因此：

- 任何「绕过中心认证直接触达实例」的路径都必须被堵死：实例只从出站隧道接收转发，**无其它入站**。
- 用户 → namespace → 实例的 ACL 由中心强制执行。
- Authelia 的域规则必须覆盖**所有**实例子域（`*.hub.example.com`），防止用户绕过门户直连实例。
- instance token 支持吊销，吊销即断隧道；registry key 支持轮换。
- 全链路 TLS（`https` + `wss`），实例侧校验中心证书（防中间人）。

> 一实例一子域是**硬约束**：DSH 前端把 API 基址硬编码为 `location.origin + "/api/..."`，不支持子路径部署，因此每个实例挂在独立子域 `<instanceId>.hub.example.com` 根路径下（本地开发用 `<instanceId>.localhost`）。

## 里程碑

- **M1A/M1B**：安全/凭据/协议/有界中继已完成并复审通过。
- **M1C**：DSH 核心 HTTP/WS 和整页实例入口兼容基线已通过；iframe、停启恢复、聊天/工具/附件长链路和 npm `latest/next` 仍待补测。
- **M2**：部署模板基线；支持全栈 compose 和 existing-Caddy 后端模式。新增 `dsh-hub-client diagnose` 与 `npm run test:m2:compat`，可重复采集 session/workspace/events/目录选择器推断、stale workspace session 和 SQLite 备份恢复证据。公开仓库只保留通用模板；实际域名、服务器地址和部署证据应放在使用者自己的私有运维 overlay。
- **M3A**：最小远程兼容诊断已落地；Portal 提供按实例“诊断”按钮，`GET /api/instances/:id/diagnostics` 通过在线 tunnel 只读探测 DSH API/WS，解释 relay、`session.list`、`workspace.list`、未挂接/stale session、events 和 host capability 问题；返回值不含 workspace 本机路径/请求体/凭据，最多包含有界 session ID 样本用于定位映射问题，为 M4 plugin 提供输入。
- **M4**：plugin-first 远程体验主路径已达到 v0.1.0 MVP 收口口径；远程 DSH Web UI、plugin tunnel、browse picker、状态卡片、session/workspace 诊断和 `canOpenPath=false` UI gating 已完成基础验证。remote openPath 替代 UI 不在 v0.1.0。
- **M3B**：可运维性基线已达到 v0.1.0 MVP 收口口径，包括内部 metrics、告警规则示例、运行手册、本地恢复/回滚演练、日志轮转和脱敏。长时压测、真实部署恢复/升级/回滚实战演练、Alertmanager 接收人配置和故障演练进入后续生产化阶段。
- **v0.1.0**：MVP 已收口，详见 `docs/releases/v0.1.0.zh.md`。
- **v0.1.1**：新增实验性的手工托管 DSH 容器基线，详见 `docs/releases/v0.1.1.zh.md`。
- **后续**：公开路线见 `docs/ROADMAP.zh.md`；优先处理大会话历史懒加载/性能优化，再推进生产化、多用户权限和管理员界面。当前限制见 `docs/KNOWN-LIMITATIONS.zh.md`。

v0.1.0 非目标：会话历史懒加载、多用户成员/角色、管理员界面、无头控制 API、用户级会话隔离、P2P、多实例聚合、remote openPath 替代 UI、VPS 托管 DSH 容器实例、托管实例池自动分配。v0.1.1 已新增第一版实验性的手工托管 DSH 容器模板；托管实例自动分配仍属于后续工作。

## 文档

每个 Markdown 文档都有同名 `*.zh.md` 简体中文版，并在文档头部提供语言切换链接。

- `docs/ROADMAP.zh.md` — v0.1.0 后公开路线图
- `docs/KNOWN-LIMITATIONS.zh.md` — v0.1.0 已知限制
- `docs/releases/v0.1.0.zh.md` — v0.1.0 MVP 收口文档
- `docs/releases/v0.1.1.zh.md` — v0.1.1 托管 DSH 收口文档
- `docs/plans/20260821-v0.1.0-requirements.zh.md` — v0.1.0 MVP 需求文档
- `docs/plans/20260821-v0.1.0-design.zh.md` — v0.1.0 MVP 设计文档
- `docs/plans/20260821-v0.1.0-implementation-plan.zh.md` — v0.1.0 MVP 实施计划
- `docs/protocol.zh.md` — 中继协议
- `deploy/m3-observability/README.zh.md` — M3 告警规则与本地校验说明
- `deploy/m3-recovery/README.zh.md` — M3 本地恢复/回滚演练校验说明
- `deploy/hosted-dsh/README.zh.md` — 实验性的手工托管 DSH 容器模板，包含 `/workspace` 限制目录选择器

## 运维与自托管指南

如果你准备自托管 dsh-hub，建议先读这三份公开指南；它们是模板和安全边界说明，不包含任何真实环境部署证据：

- `docs/ops/m3-runbook.zh.md` — 告警响应与运行手册，说明 `/metrics` 内部采集、告警含义和排查顺序。
- `docs/ops/m3-recovery-runbook.zh.md` — SQLite 备份、恢复、升级和回滚指南，强调一致性备份和覆盖恢复前置条件。
- `docs/ops/m3-log-retention.zh.md` — Docker 日志轮转与脱敏指南，说明哪些内容不能进入日志、issue 或工单。
- `deploy/hosted-dsh/README.zh.md` — 实验性的手工托管 DSH 容器模板，包含 `/workspace` 限制目录选择器；真实 VPS 证据和私有配置应保存在 private overlay。

## License

MIT License. See `LICENSE`.
