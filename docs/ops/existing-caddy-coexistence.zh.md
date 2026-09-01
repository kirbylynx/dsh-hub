# existing-Caddy 共存指南

语言：[English](existing-caddy-coexistence.md) | 简体中文

existing-Caddy 部署 profile 用于已经运行 system Caddy、Authelia 或其它站点的服务器。在此模式下，Docker Compose 不应接管公开 `80` 和 `443` 端口。

## 1. 归属模型

- system Caddy 拥有公开 `:80` 和 `:443`；
- Authelia 仍是边缘认证层；
- `dsh-hub-service` 监听 loopback，例如 `127.0.0.1:18081`；
- Compose 只管理后端服务和数据 volume；
- 同服务器其它站点不属于 dsh-hub Compose project。

## 2. 必要路由

典型部署包含：

- Portal host：`hub.example.com`；
- control host：`control.hub.example.com`；
- auth host：`auth.hub.example.com`；
- instance wildcard：`*.instances.hub.example.com`。

DSH Web 必须挂载在每个 instance 子域根路径，不能挂在 `/instances/<id>/` 这类路径前缀下，因为 DSH 会从 `location.origin` 解析 API 路径。

## 3. 安全配置流程

修改 Caddy 或 Authelia 前：

1. 备份当前配置。
2. 审查 diff。
3. 运行 `caddy validate` 或等价校验命令。
4. 只有配置变化时才 reload。
5. 复查 dsh-hub 和其它站点抽样。

如果只是部署 dsh-hub 代码，不改变路由、header、域名或 Authelia 规则，不要仅因为 Node/container 代码更新而 reload Caddy。

## 4. Smoke checks

示例检查：

```bash
systemctl status caddy --no-pager
curl -i https://hub.example.com/
curl -i https://control.hub.example.com/
curl -i https://inst-example.instances.hub.example.com/
curl -i https://control.hub.example.com/metrics
curl -fsS http://127.0.0.1:18081/healthz
```

公开 `/metrics` 不应暴露 Prometheus 文本。内部 metrics 应只通过 loopback source address 和 loopback Host 采集。

## 5. 停机点

出现以下情况时，先停止并检查，不要直接修改：

- Caddy 已经不健康；
- Authelia redirect 与预期域名不匹配；
- 其它站点共享了同一个 host 或 wildcard route；
- Compose project 看起来绑定了公开 `80` 或 `443`；
- Docker labels 显示运行容器来自非预期 working directory 或 Compose file。

## 6. 不应公开保存的内容

不要公开包含真实 private domain、private upstream address、Authelia secret、用户数据库、cookie、TLS private key path 或 operator-only incident notes 的 Caddy 配置片段。
