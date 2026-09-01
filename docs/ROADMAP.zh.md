# 路线图

语言：[English](ROADMAP.md) | 简体中文

本文概述 dsh-hub 在 v0.1.4 之后的公开方向。它是产品和工程路线图，不承诺具体交付日期。

当前发布基线见 [docs/releases/v0.1.0.zh.md](releases/v0.1.0.zh.md) 和
[docs/releases/v0.1.1.zh.md](releases/v0.1.1.zh.md)。v0.1.2 新增第一版有界大会话历史加载基线，见 [docs/releases/v0.1.2.zh.md](releases/v0.1.2.zh.md)。v0.1.3 新增第一版位于 DSH Web plugin card 的窄面 hosted 模型/provider 设置路径，见 [docs/releases/v0.1.3.zh.md](releases/v0.1.3.zh.md)。v0.1.4 新增自托管生产发布卫生文档，见 [docs/releases/v0.1.4.zh.md](releases/v0.1.4.zh.md)。

## 近期优先事项

### 大会话历史加固

v0.1.2 已实现第一版有界懒加载基线：先显示最新消息，用户向上滚动时可继续加载更早历史，实例侧会在响应离开实例前删除已结算 assistant chunk。

后续工作应覆盖更多 DSH 版本和更大的真实 transcript，提供安全的操作者调优入口，并让兼容测试继续跟随 DSH history API surface。

### 生产化加固

v0.1.4 基线新增公开生产检查清单、release/tag/deploy 指南、SQLite 备份验证指南和
existing-Caddy 共存指南。后续应让自托管更安全、更可重复：

- 长时间 relay 与 plugin 稳定性测试；
- 真实回滚和灾备演练；
- 真实 Alertmanager 接收人配置和通知测试；
- 大上传、WebSocket session 和慢链路容量建议。

### 多用户权限

v0.1.x 面向单个受信 owner namespace。多用户部署需要先定义明确授权模型，才能更广泛
推荐。后续应定义用户、角色、namespace 成员关系、实例访问、审计可见性和跨用户负向
测试。

### 管理后台

v0.1.x 的很多管理动作仍通过 API 或命令行 helper 完成。后续管理后台应安全暴露常见
操作：namespace 管理、registry key 轮换、replacement grant、实例吊销、诊断和审计
查看。

管理后台应建立在多用户权限模型之上，而不是固化单 owner 假设。

## 兼容性与用户体验

### DSH 版本兼容性

DSH 仍在演进。dsh-hub 依赖特定 DSH seam：plugin 加载、profile composition、
browser client 注册、本地 web server、目录选择器行为和 HTTP/WebSocket API。后续
版本应发布小型兼容矩阵，并明确推荐 DSH 版本。

### 远程文件操作

plugin-first 路径通过面向浏览器的 picker 处理远程目录选择。native `openPath` 仍然
被 gate，因为它会在实例机器上执行，而不是远程浏览器。未来可以增加更安全的替代
能力，例如预览、下载、复制路径提示或带审计的文件动作。

### Portal 嵌入

v0.1.0 的可靠入口是整页实例子域访问。iframe 嵌入仍是实验能力，因为它涉及 frame
policy、同站点 cookie 行为、Origin/CORS、Fetch Metadata 和认证边界。

## 托管 DSH

### 托管 DSH 容器

v0.1.1 新增了第一版实验性的手工托管 DSH 容器模板。它在 Docker 中运行 DSH，通过
桌面实例同样使用的 plugin tunnel 接入 dsh-hub，将 DSH home、workspace 和 logs 存放
在每实例独立 bind mount 中，并把 hosted 工作区选择器限制在容器 `/workspace`。

这仍是操作者自托管模板，不是面向敌对租户的 SaaS 沙箱。更大的托管实例池应等待多用户
权限和管理员操作定义完成。

### 托管模型/provider 设置

v0.1.3 增加 hosted-only 的 dsh-hub plugin 面板，支持 DeepSeek 官方和
OpenAI-compatible/custom Base URL provider。它在本地 hosted eligibility 检查通过后，
通过 DSH 本地 settings 与 credentials seam 写入配置，不把 provider API key 存入 Hub
service。

后续应在多用户权限模型明确后，把常用 hosted 模型管理迁移到 Portal 侧 owner/admin 流程。

## 长期探索

### 无头自动化 API

自动化控制可能有价值，但它是高风险扩展，因为 DSH 可以操作文件和类似 shell 的工作流。
任何 headless API 都必须具备清晰授权、审计、速率限制，并与浏览器 session cookie
明确分离。

### 多实例工作台

未来 Portal 可以聚合多个实例，提供收藏、分组、健康摘要和快速切换。第一版应使用
hub 自有元数据和诊断摘要，而不是缓存 DSH 会话正文。

### 高可用与多中心路由

v0.1.0 使用单 service + SQLite。高可用、多中心路由或 P2P 设计需要单独评估一致性、
token 生命周期、审计归属、故障切换行为和运维复杂度。
