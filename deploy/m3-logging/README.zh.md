# M3B-6 日志保留检查

语言：[English](README.md) | 简体中文

本目录包含 M3B-6 日志保留与脱敏基线的本地检查。

```bash
npm run deploy:m3:logging:check
```

该检查不连接生产服务器、不修改运行配置。完整检查需要 Docker Compose，因为它会
渲染两个部署 profile，并验证有界 `json-file` 日志保留策略（`10m × 7`）。它还会
验证 service/client 日志 helper 在写入 stdout 前会脱敏凭据形态的值。

根目录 `npm test` 使用下面这个不依赖 Docker 的子集，用于脱敏和文档护栏：

```bash
npm run test:m3:logging-redaction
```

生产使用仍需要显式部署步骤，并由操作者自行决定外部日志转发、Alertmanager
接收人和事故工单保留策略。
