# Existing-Caddy coexistence guide

Language: English | [简体中文](existing-caddy-coexistence.zh.md)

The existing-Caddy deployment profile is for servers that already run a system
Caddy instance, Authelia, or other sites. In this mode, Docker Compose should
not take ownership of public ports `80` and `443`.

## 1. Ownership model

- system Caddy owns public `:80` and `:443`;
- Authelia remains the edge authentication layer;
- `dsh-hub-service` listens on loopback, for example `127.0.0.1:18081`;
- Compose manages backend services and data volumes only;
- other sites on the same server remain outside the dsh-hub Compose project.

## 2. Required routes

A typical deployment has:

- Portal host: `hub.example.com`;
- control host: `control.hub.example.com`;
- auth host: `auth.hub.example.com`;
- instance wildcard: `*.instances.hub.example.com`.

DSH Web must be mounted at the root of each instance subdomain. It cannot be
mounted under a path prefix such as `/instances/<id>/`, because DSH resolves API
paths from `location.origin`.

## 3. Safe config workflow

Before changing Caddy or Authelia:

1. Back up the current config.
2. Review the diff.
3. Run `caddy validate` or the equivalent validation command.
4. Reload only if the config changed.
5. Re-check dsh-hub and a sample of existing sites.

If a code-only dsh-hub deployment does not change routes, headers, domains, or
Authelia rules, do not reload Caddy just to deploy new Node/container code.

## 4. Smoke checks

Example checks:

```bash
systemctl status caddy --no-pager
curl -i https://hub.example.com/
curl -i https://control.hub.example.com/
curl -i https://inst-example.instances.hub.example.com/
curl -i https://control.hub.example.com/metrics
curl -fsS http://127.0.0.1:18081/healthz
```

Public `/metrics` should not expose Prometheus text. Internal metrics should be
scraped only through loopback source addresses and a loopback Host.

## 5. Stop conditions

Stop and inspect before changing anything if:

- Caddy is already unhealthy;
- Authelia redirects do not match the expected domain;
- another site shares the same host or wildcard route;
- the Compose project appears to bind public `80` or `443`;
- Docker labels show that a running container was started from an unexpected
  working directory or Compose file.

## 6. What not to store publicly

Do not publish real Caddy snippets containing private domains, private upstream
addresses, Authelia secrets, user databases, cookies, TLS private key paths, or
operator-only incident notes.
