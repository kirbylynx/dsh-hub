# Secrets for existing-Caddy VPS mode

Language: English | [简体中文](README.zh.md)

The committed `*.example.*` files are deliberately insecure and exist only for
local rendering and validation.

On the VPS, create non-example files in this directory and keep them out of
Git:

- `token-pepper-keyring.json`
- `idempotency-encryption-keyring.json`
- `authelia-jwt.txt`
- `authelia-session.txt`
- `authelia-storage.txt`
- `lldap-jwt.txt`
- `lldap-key-seed.txt`
- `lldap-admin-password.txt`

Use `chmod 600` for secret files.
