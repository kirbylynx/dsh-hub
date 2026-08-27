# 已知限制

语言：[English](KNOWN-LIMITATIONS.md) | 简体中文

本文列出 v0.1.0 MVP 基线的重要限制。

计划中的后续方向见 [docs/ROADMAP.md](ROADMAP.zh.md)。

## 大会话历史可能加载较慢

v0.1.0 relay 路径可以承载普通 DSH Web UI 流量。但在弱网络下，如果 DSH Web 一次性
请求完整历史，超大的会话历史仍可能加载缓慢或失败。

这是性能和加载策略限制，不代表注册、认证、HTTP relay 或 WebSocket relay 失败。计划
方向是懒加载或分页，前提是 DSH history API surface 足够稳定。

## 整页实例入口是可靠路径

dsh-hub 有意使用每实例独立子域作为可靠访问模型：

```text
https://<instanceId>.instances.hub.example.com/
```

iframe 嵌入在 v0.1.0 中不是默认支持路径。如果要把 iframe 恢复为推荐选项，需要专门
评审 frame policy、cookie、Origin/CORS、Fetch Metadata 和认证行为。

## v0.1.0 面向单 owner

当前 MVP 适合受信自托管评估和单 owner 使用。它还不包含通用多用户角色、namespace
共享、成员邀请、按用户划分的实例 ACL 或完整管理后台。

操作者不应把 v0.1.0 视为面向敌对租户的 SaaS 隔离边界。

## Agent 模式是 fallback，不是主要远程 UX

推荐路径是 `dsh-hub-plugin`，它运行在 DSH 内部，并能接入 DSH 浏览器侧能力。独立
`dsh-hub-client` 仍适合 bootstrap、诊断、fallback 和 plugin helper 命令。

不要用 agent 模式推断所有本地桌面能力在远程浏览器触发时都是安全且有意义的。

## 远程 native 文件打开被有意 gate

native `openPath` 行为会作用于实例机器。v0.1.0 因此在远程 profile 中 gate 该能力。
未来版本可以提供更安全的远程替代能力，例如文件预览、下载、复制路径提示或审计动作。

## DSH 版本兼容性需要验证

dsh-hub 依赖 DSH plugin/profile/webserver seam，而这些 seam 可能随着 DSH 演进而变化。
推荐新 DSH 版本作为默认基线前，应先在隔离 profile 中测试。

## 部署模板不是生产证明

仓库包含 Docker Compose、Caddy、Authelia、metrics、logging 和 recovery 示例。模板
检查通过只能证明示例内部一致；不能证明某个具体自托管部署已经完成备份、恢复、升级、
回滚或压测。

真实部署证据、凭据、服务器地址、本地路径和运维交接记录应留在公开仓库之外。
