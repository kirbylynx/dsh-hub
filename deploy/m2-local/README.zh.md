# M2 本地部署基线

语言：[English](README.md) | 简体中文

本目录是 `dsh-hub-service + Caddy + Authelia + LLDAP + SQLite` 的本地、非生产 M2 部署骨架。

它用于证明 compose 模型、host 分离、secret-file 注入和 service 参数在真实服务器
就绪前是内部一致的。

它不能证明公网 DNS、公网 TLS、真实 Authelia 登录或远程 WSS。这些检查需要一台有
公网 IP 和域名的服务器。

## 本地检查

```bash
npm run deploy:m2:check
npm run deploy:m2:check:deep
docker compose --env-file deploy/m2-local/.env.example -f deploy/m2-local/docker-compose.yml build dsh-hub-service
docker compose --env-file deploy/m2-local/.env.example -f deploy/m2-local/docker-compose.yml config
```

本地 compose 模板故意让 Docker 自动分配 bridge subnet 和容器 IP。不要在这里固定：
固定网段可能与开发机已有 Docker 网络冲突。

`secrets/*.example.*` 下的示例 secret 是故意不安全的。它们只用于让
`docker compose config` 能在本地渲染。

示例使用 `BOOTSTRAP_SYSTEM_ADMIN_USERNAME=admin`，与 `lldap` 容器自动创建的
LLDAP admin 用户对齐。Authelia access rule 要求用户属于配置的 `dsh-hub-users`
admission group；dsh-hub 会保持 bootstrap admin 在该 group 中，并且只对公开邀请
注册路径绕过 Authelia。

## 之后真实服务器需要的输入

- 公网 IPv4/IPv6 地址；
- 指向服务器的 `BASE_DOMAIN`、`control.<BASE_DOMAIN>`、`auth.<BASE_DOMAIN>` 和
  `*.instances.<BASE_DOMAIN>` DNS 记录；
- 可从公网访问的 80 和 443 端口；
- 真实 Authelia、LLDAP 和 dsh-hub secret 文件；
- 真实 token pepper keyring、idempotency encryption keyring 和 proxy key；
- 已存在于 LLDAP 且属于 admission group 的 bootstrap system admin；
- ACME 策略；如果需要 wildcard 证书，优先 DNS-01。

到这一步前应暂停，并向用户确认服务器和域名信息。
