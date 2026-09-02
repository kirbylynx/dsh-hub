# existing-Caddy 模式的 secrets

语言：[English](README.md) | 简体中文

提交到仓库里的 `*.example.*` 文件是故意不安全的，只用于本地渲染和校验。

在服务器上，请在本目录创建非 example 文件，并确保它们不进入 Git：

- `token-pepper-keyring.json`
- `idempotency-encryption-keyring.json`
- `authelia-jwt.txt`
- `authelia-session.txt`
- `authelia-storage.txt`
- `lldap-jwt.txt`
- `lldap-key-seed.txt`
- `lldap-admin-password.txt`

secret 文件权限请使用 `chmod 600`。
