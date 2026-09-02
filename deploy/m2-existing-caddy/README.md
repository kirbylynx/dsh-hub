# M2 existing-Caddy deployment template

Language: English | [简体中文](README.zh.md)

This profile is a public template for deploying behind an existing system Caddy
that already owns public ports 80/443 and may serve other sites.

Do not start the `deploy/m2-local` compose stack on the same host: it includes
its own Caddy and would conflict with the existing public listener.

## Shape

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

The instance wildcard uses Caddy on-demand TLS with an internal `ask` endpoint:

```text
http://127.0.0.1:18081/api/tls/ask?domain=<sni>
```

The service only accepts this endpoint through a loopback `Host` value
(`127.0.0.1`, `::1`, or `localhost`). Public hosts such as
`control.hub.example.com` must not expose it as an instance-domain oracle.

The service only allows certificates for:

- `hub.example.com`;
- `control.hub.example.com`;
- `auth.hub.example.com`;
- registered instance domains matching `inst-*.instances.hub.example.com`.

## Local checks

```bash
npm run deploy:m2:existing-caddy:check
npm run deploy:m2:existing-caddy:check:deep
```

## Server setup after the code is pushed

Use Git on the server so deployments are tied to a commit:

```bash
sudo mkdir -p /opt/dsh-hub
sudo chown "$USER":"$(id -gn)" /opt/dsh-hub
cd /opt/dsh-hub
git clone <YOUR_GITHUB_REPO_URL> .
git checkout <COMMIT_SHA>
```

Create production config and secrets:

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

Update `.env` to point to the non-example secret files:

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

Authelia authenticates against LLDAP. The `lldap` service creates the configured
LDAP admin user from `LLDAP_ADMIN_USERNAME` and `LLDAP_ADMIN_PASSWORD_FILE` on
first boot. dsh-hub automatically creates the configured admission group when it
first provisions or restores a user.

Validate and start the backend:

```bash
npm run deploy:m2:existing-caddy:check
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml build dsh-hub-service
docker compose --env-file .env -f docker-compose.yml up -d
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/api/tls/ask?domain=hub.example.com
curl -i 'https://control.hub.example.com/api/tls/ask?domain=hub.example.com' # must be 403 after public Caddy is loaded
curl -fsS http://127.0.0.1:18081/healthz -H 'Host: control.hub.example.com'
```

## Caddy integration

The example snippet is:

```text
deploy/m2-existing-caddy/caddy/Caddyfile.hub.example.com.example
```

Because `/etc/caddy/Caddyfile` already serves other sites, do not overwrite it.
Make a backup first:

```bash
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak.$(date +%Y%m%d%H%M%S)
```

Merge the global `on_demand_tls` block at the very top of the existing
Caddyfile. If the file already has a global options block, merge only the
`on_demand_tls` section into that block.

Append the four `hub.example.com` site blocks after the existing sites.
Keep the `dsh_hub_scrub_spoofed_identity` imports in the portal, control, and
instance site blocks; they remove externally supplied identity headers before
requests reach dsh-hub. Do not remove the surrounding `route { ... }` blocks:
they force Caddy to scrub spoofed headers before ForwardAuth and keep the
trusted `Remote-User` copied from Authelia until the request reaches dsh-hub.

Then validate before reloading:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

## Public validation

```bash
curl -I https://hub.example.com
curl -fsS https://control.hub.example.com/healthz
curl -I https://auth.hub.example.com
```

After at least one instance is registered, validate:

```bash
curl -I https://<instanceId>.instances.hub.example.com/
```

Do not continue to full DSH remote testing until the backend is healthy, Caddy
validates cleanly, and existing sites still respond.
