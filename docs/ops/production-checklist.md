# Production readiness checklist

Language: English | [简体中文](production-checklist.zh.md)

This checklist is for self-hosted `dsh-hub` deployments. It describes what an
operator should verify before treating a deployment as production-like. It is a
template, not proof that any particular server has passed these checks.

Use your own private operations overlay for real domains, IP addresses, paths,
credentials, backup manifests, and deployment evidence.

## 1. Repository and release state

- Choose a specific Git commit or release tag before deployment.
- Keep deployment evidence outside the public repository.
- Record the commit used for the Hub service and, if hosted DSH is enabled, the
  commit used for the hosted DSH deployment template.
- Confirm the working tree is clean before building images:

```bash
git status --short --branch
git rev-parse HEAD
git tag --points-at HEAD
```

## 2. Secrets and configuration

- Keep `.env`, Authelia secrets, registry keys, replacement grants, instance
  tokens, provider API keys, cookies, and TLS private keys out of Git.
- Prefer `.env`, stdin, or private secret files over command-line arguments for
  one-time credentials.
- Confirm examples still use placeholders such as `hub.example.com`,
  `control.hub.example.com`, and `*.instances.hub.example.com`.
- Review generated evidence before sharing it in issues, chats, or tickets.

## 3. Existing-Caddy boundary

If you use the existing-Caddy profile:

- system Caddy remains the only public `:80/:443` listener;
- Docker Compose manages the backend services only;
- `dsh-hub-service` should bind loopback only;
- Caddy and Authelia configuration changes should be validated before reload;
- if the dsh-hub route did not change, do not reload Caddy just for a code
  deployment.

See [existing-Caddy coexistence](existing-caddy-coexistence.md).

## 4. Backup before upgrade

Before changing code or images:

- create a SQLite backup with online backup semantics, such as `VACUUM INTO`;
- verify the backup with `PRAGMA integrity_check`;
- restore or open the backup in a temporary path and read key table summaries;
- keep backup files private and non-world-readable.

See [SQLite backup and restore](sqlite-backup-restore.md).

## 5. Local template checks

Run the repository checks that match the deployment profile:

```bash
npm test
npm run deploy:m2:check
npm run deploy:m2:existing-caddy:check
npm run deploy:m3:alerts:check
npm run deploy:m3:recovery:check
npm run deploy:m3:logging:check
npm run deploy:g11:hosted-dsh:check
npm run test:g13:hosted-model-settings
```

These checks validate templates and local behavior. They do not replace real
server health checks.

## 6. Deployment smoke checks

After deployment, verify:

- Compose configuration is valid;
- Hub service is running and healthy;
- public Portal routes are reachable through authentication;
- internal `/metrics` is not exposed through public hosts;
- instance subdomains route through the authenticated edge;
- tunnel handshakes and instance status are healthy;
- logs contain no sustained error loop.

Example shape:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml config --quiet
docker compose --env-file .env -f docker-compose.yml ps
curl -fsS http://127.0.0.1:18081/healthz
```

## 7. Hosted DSH checks

If you run the hosted DSH template, verify:

- the hosted container is running and healthy;
- DSH home, workspace, and logs are mapped to operator-owned host directories;
- the hosted picker is restricted to `/workspace`;
- the plugin tunnel is online;
- the instance URL opens through the Hub edge;
- `/plugins/dsh-hub-plugin/model-settings.json` returns only redacted model
  settings summaries and does not expose API keys or raw credential references.

See [deploy/hosted-dsh/README.md](../../deploy/hosted-dsh/README.md).

## 8. Known non-goals for v0.1.x

The v0.1.x self-hosted baseline is not a hostile-tenant SaaS platform. It does
not yet provide general multi-user roles, an admin console, high availability,
automatic hosted instance assignment, real Alertmanager receiver setup, or
long-running production load-test reports.
