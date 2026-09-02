# M2 existing-Caddy 部署模板

语言：[English](README.md) | 简体中文

本 profile 是公开模板，用于部署在一台已有系统 Caddy 的服务器后面。该系统
Caddy 已经占用公网 80/443 端口，并且可能还服务其它站点。

不要在同一台机器上启动 `deploy/m2-local` compose stack：它包含自己的 Caddy，
会与已有公网监听端口冲突。

## 形态

```text
Internet
  -> existing system Caddy :80/:443
      -> LLDAP on 127.0.0.1:17170 / 127.0.0.1:3890
      -> Authelia on 127.0.0.1:19091
      -> dsh-hub-service on 127.0.0.1:18081

Docker Compose
  - lldap, host network, binds 127.0.0.1:17170 and 127.0.0.1:3890
  - authelia, host network, binds 127.0.0.1:19091
  - dsh-hub-service, host network, binds 127.0.0.1:18081
  - no compose Caddy
  - no public compose ports
```

实例 wildcard 域名使用 Caddy on-demand TLS，并通过内部 `ask` 端点判断是否允许签证：

```text
http://127.0.0.1:18081/api/tls/ask?domain=<sni>
```

service 只接受 loopback `Host` 值访问该端点（`127.0.0.1`、`::1` 或
`localhost`）。`control.hub.example.com` 这样的公网 Host 不得把它暴露成实例域名
枚举 oracle。

service 只允许为以下域名签发证书：

- `hub.example.com`；
- `control.hub.example.com`；
- `auth.hub.example.com`；
- 匹配 `inst-*.instances.hub.example.com` 的已注册实例域名。

## 本地检查

```bash
npm run deploy:m2:existing-caddy:check
npm run deploy:m2:existing-caddy:check:deep
```

## 代码推送后的服务器设置

服务器上建议使用 Git，使每次部署都能绑定到一个 commit：

```bash
sudo mkdir -p /opt/dsh-hub
sudo chown "$USER":"$(id -gn)" /opt/dsh-hub
cd /opt/dsh-hub
git clone <YOUR_GITHUB_REPO_URL> .
git checkout <COMMIT_SHA>
```

创建生产配置和 secret：

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
cp .env.example .env
mkdir -p secrets

node -e "import crypto from 'node:crypto'; console.log(JSON.stringify({'example-key-1': crypto.randomBytes(32).toString('base64url')}))" > secrets/token-pepper-keyring.json
node -e "import crypto from 'node:crypto'; console.log(JSON.stringify({'example-key-1': crypto.randomBytes(32).toString('base64url')}))" > secrets/idempotency-encryption-keyring.json
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(48).toString('base64url'))" > secrets/authelia-jwt.txt
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(48).toString('base64url'))" > secrets/authelia-session.txt
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(48).toString('base64url'))" > secrets/authelia-storage.txt
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(48).toString('base64url'))" > secrets/lldap-jwt.txt
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(48).toString('base64url'))" > secrets/lldap-key-seed.txt
node -e "import crypto from 'node:crypto'; console.log(crypto.randomBytes(32).toString('base64url'))" > secrets/lldap-admin-password.txt
chmod 600 secrets/*.json secrets/*.txt
```

更新 `.env`，指向非 example 的 secret 文件：

```env
TOKEN_PEPPER_KEYRING_SECRET_FILE=./secrets/token-pepper-keyring.json
IDEMPOTENCY_ENCRYPTION_KEYRING_SECRET_FILE=./secrets/idempotency-encryption-keyring.json
AUTHELIA_JWT_SECRET_FILE=./secrets/authelia-jwt.txt
AUTHELIA_SESSION_SECRET_FILE=./secrets/authelia-session.txt
AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=./secrets/authelia-storage.txt
LLDAP_JWT_SECRET_FILE=./secrets/lldap-jwt.txt
LLDAP_KEY_SEED_FILE=./secrets/lldap-key-seed.txt
LLDAP_ADMIN_PASSWORD_FILE=./secrets/lldap-admin-password.txt
LLDAP_BASE_DN=dc=dsh,dc=hub
LLDAP_ADMIN_USERNAME=admin
LLDAP_ADMISSION_GROUP=dsh-hub-users
```

Authelia 通过 LLDAP 做身份认证。`lldap` service 首次启动时会按
`LLDAP_ADMIN_USERNAME` 和 `LLDAP_ADMIN_PASSWORD_FILE` 创建 LDAP 管理员。dsh-hub
在首次 provision 或 restore 用户时会自动创建配置的 admission group。

验证并启动后端：

```bash
npm run deploy:m2:existing-caddy:check
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/api/tls/ask?domain=hub.example.com
curl -i 'https://control.hub.example.com/api/tls/ask?domain=hub.example.com' # public Caddy loaded 后必须为 403
curl -fsS http://127.0.0.1:18081/healthz -H 'Host: control.hub.example.com'
```

## Caddy 集成

示例片段位于：

```text
deploy/m2-existing-caddy/caddy/Caddyfile.hub.example.com.example
```

因为 `/etc/caddy/Caddyfile` 可能已经服务其它站点，不要覆盖它。先备份：

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)
```

把全局 `on_demand_tls` block 合并到现有 Caddyfile 最顶部。如果文件已经有全局
options block，只把 `on_demand_tls` section 合并进去。

把四个 `hub.example.com` site block 追加到已有站点之后。保留 portal、control
和 instance site block 中的 `dsh_hub_scrub_spoofed_identity` import；它们会在请求
到达 dsh-hub 前移除外部伪造的身份头。不要移除外层 `route { ... }` block：它们
确保 Caddy 先清理伪造头，再执行 ForwardAuth，并把 Authelia 的可信 `Remote-User`
保留到 dsh-hub。

reload 前先验证：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

## 公开入口验证

```bash
curl -I https://hub.example.com
curl -fsS https://control.hub.example.com/healthz
curl -I https://auth.hub.example.com
```

至少注册一个实例后再验证：

```bash
curl -I https://<instanceId>.instances.hub.example.com/
```

后端健康、Caddy 验证通过且已有站点仍能响应之前，不要继续做完整远程 DSH 测试。
