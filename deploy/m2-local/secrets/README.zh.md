# M2 本地示例 secrets

语言：[English](README.md) | 简体中文

这些文件只用于让 `docker compose config` 可以在本地渲染。

不要在服务器上使用它们。真实部署请用以下命令生成替代文件：

```bash
node -e "console.log(Buffer.from(require('crypto').randomBytes(32)).toString('base64url'))"
openssl rand -base64 48
```

真实 secret 文件不要提交进 Git。`.dockerignore` 已经排除了本目录中的非 example
JSON/TXT 文件。
