# M3 可观测性基线

语言：[English](README.md) | 简体中文

本目录包含 `dsh-hub-service` 的本地 M3B 可观测性基线。

它不是生产部署。service 的 `/metrics` 端点只供内部读取，必须从同机或明确可信的
私有路径采集。M2 Caddy profiles 会继续在代理前拒绝公网 `/metrics`。

## 文件

- `alerts.dsh-hub.yml`：当前 service 指标的 Prometheus 告警规则。
- `check-alerts.mjs`：本地一致性检查，验证告警指标名以及禁止高基数或携带秘密的
  label。

## 本地检查

```bash
npm run deploy:m3:alerts:check
```

## 推荐同机 scrape

existing-Caddy 自托管 profile 下，Prometheus 应直接采集 loopback service 端点：

```yaml
scrape_configs:
  - job_name: dsh-hub-service
    metrics_path: /metrics
    static_configs:
      - targets:
          - 127.0.0.1:18081
```

不要采集 `https://hub.example.com/metrics`、
`https://control.hub.example.com/metrics` 或实例域名。这些公网路径是故意阻断的。

## 范围

本基线覆盖规则形态、安全指标引用和 runbook 链接。它不配置 Alertmanager 接收人、
paging、dashboard、长期生产压测、备份/恢复演练或升级/回滚演练。
