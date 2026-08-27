# M2 local deployment baseline

Language: English | [简体中文](README.zh.md)

This directory is the local, non-production M2 deployment skeleton for
`dsh-hub-service + Caddy + Authelia + SQLite`.

It is intended to prove that the compose model, host separation, secret-file
injection, and service arguments are internally consistent before a real VPS is
available.

It does not prove public DNS, public TLS, real Authelia login, or remote WSS.
Those checks require a VPS with a public IP and domain.

## Local checks

```bash
npm run deploy:m2:check
npm run deploy:m2:check:deep
docker compose --env-file deploy/m2-local/.env.example -f deploy/m2-local/docker-compose.yml build dsh-hub-service
docker compose --env-file deploy/m2-local/.env.example -f deploy/m2-local/docker-compose.yml config
```

The local compose template deliberately lets Docker allocate the bridge subnet
and container IPs. Do not pin them here: fixed ranges can collide with existing
developer-machine Docker networks.

The example secrets under `secrets/*.example.*` are intentionally insecure.
They exist only so `docker compose config` can render locally.

## Real VPS inputs needed later

- public IPv4/IPv6 address;
- `BASE_DOMAIN`, `control.<BASE_DOMAIN>`, `auth.<BASE_DOMAIN>`, and
  `*.instances.<BASE_DOMAIN>` DNS records pointing to the VPS;
- ports 80 and 443 reachable from the internet;
- real Authelia user database and secret files;
- real token pepper keyring, idempotency encryption keyring, and proxy key;
- ACME strategy, preferably DNS-01 if wildcard certificates are required.

Stop before this point and ask the user for VPS/domain details.
