# 已知限制

语言：[English](KNOWN-LIMITATIONS.md) | 简体中文

本文列出 v0.1.x 自托管基线的重要限制。

计划中的后续方向见 [docs/ROADMAP.md](ROADMAP.zh.md)。

## 大会话历史已有有界懒加载防护

v0.1.2 基线已为大型 DSH 会话历史增加懒加载防护：远程 history 请求默认会被限制数量，已结算的 assistant chunk 会在离开实例前被瘦身，raw 响应和最终响应都有 byte 上限。

这能改善常见大会话路径，但不是完整搜索/索引系统，也不承诺无限历史大小。过旧或未来变化的 DSH 版本、极端 transcript、弱网络链路仍可能需要配置调优或兼容适配。

## 整页实例入口是可靠路径

dsh-hub 有意使用每实例独立子域作为可靠访问模型：

```text
https://<instanceId>.instances.hub.example.com/
```

iframe 嵌入在 v0.1.0 中不是默认支持路径。如果要把 iframe 恢复为推荐选项，需要专门
评审 frame policy、cookie、Origin/CORS、Fetch Metadata 和认证行为。

## v0.1.5 多用户支持仍是早期受信自托管基线

v0.1.5 新增基于 LLDAP 的邀请注册、namespace 角色、成员/邀请管理、系统管理员禁用/恢复用户和实例 ACL 检查。这是第一版受信自托管基线，不是成熟的多租户 SaaS 安全边界。

操作者不应把 v0.1.x 视为面向敌对租户的 SaaS 隔离边界。
自助修改密码、管理员重置密码、邮件找回密码、批量管理工作流以及更深入的审计/搜索体验仍是后续工作。

## Agent 模式是 fallback，不是主要远程 UX

推荐路径是 `dsh-hub-plugin`，它运行在 DSH 内部，并能接入 DSH 浏览器侧能力。独立
`dsh-hub-client` 仍适合 bootstrap、诊断、fallback 和 plugin helper 命令。

不要用 agent 模式推断所有本地桌面能力在远程浏览器触发时都是安全且有意义的。

## 远程 native 文件打开被有意 gate

native `openPath` 行为会作用于实例机器。v0.1.x 因此在远程 profile 中 gate 该能力。
未来版本可以提供更安全的远程替代能力，例如文件预览、下载、复制路径提示或审计动作。

## 托管模型设置使用 dsh-hub 窄面板

DSH 原生 `设置 → 模型` 页面在远程 hosted browser 中仍可能提示 settings 不可用。
v0.1.3 因此为 hosted 实例增加了更窄的 dsh-hub plugin 面板：只把 DeepSeek 官方设置和
OpenAI-compatible/custom Base URL provider 写入该 hosted DSH 实例自己的本地 settings
与 credential store。

这不是通用 settings bridge。Hub service 不保存 provider API key；远程入伙的桌面实例
仍不开放模型设置写入；Portal 侧 owner/admin 模型管理仍属于后续工作。

## DSH 版本兼容性需要验证

dsh-hub 依赖 DSH plugin/profile/webserver seam，而这些 seam 可能随着 DSH 演进而变化。
推荐新 DSH 版本作为默认基线前，应先在隔离 profile 中测试。

## 公开生产指南不是部署证明

仓库包含 Docker Compose、Caddy、Authelia、LLDAP、metrics、logging、recovery 示例和 v0.1.5
生产发布指南。模板检查通过或按公开 checklist 操作，只能证明示例内部一致并且 operator
按流程执行；不能证明某个具体自托管部署已经完成备份、恢复、升级、回滚或压测。

真实部署证据、凭据、服务器地址、本地路径和运维交接记录应留在公开仓库之外。
