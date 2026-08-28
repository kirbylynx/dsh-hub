# Hosted DSH container

Language: English | [简体中文](README.zh.md)

This template is the G11 baseline for running one manually managed DSH instance
inside Docker and connecting it to `dsh-hub` through `dsh-hub-plugin`.

It is intentionally separate from the hub service deployment templates. The
container does not publish the DSH Web port; remote access still goes through
the hub instance subdomain and the plugin tunnel.

## Scope

Included:

- a hosted DSH image with Node.js, fixed `@deepseek-ai/dsh@0.1.0-rc.7`,
  `dsh-hub-client`, and `dsh-hub-plugin`;
- a Compose service for one manually named instance such as `dsh-0001`;
- bind mounts for DSH home, workspace, and logs;
- non-root runtime, read-only root filesystem, dropped capabilities,
  `no-new-privileges`, resource limits, healthcheck, and Docker log rotation;
- `start`, `join`, `install-check`, and `shell` entrypoint modes.

Not included:

- automatic hosted instance assignment;
- multi-user ownership and permission management;
- hostile-tenant isolation guarantees;
- public exposure of the container DSH Web port;
- long-lived registry keys, replacement grants, or instance tokens in Compose
  environment variables.

## Prepare a private deployment copy

Do not edit `.env.example` in the public repository for a real deployment.
Copy this directory or at least the env file into your private operations
overlay:

```bash
cp deploy/hosted-dsh/.env.example deploy/hosted-dsh/.env
```

Edit `.env`:

```dotenv
DSH_HOSTED_INSTANCE_ID=dsh-0001
DSH_HOST_DATA_ROOT=/data/docker
DSH_HUB_ENDPOINT=https://control.hub.example.com
DSH_HUB_NAMESPACE=my-team
DSH_HUB_INSTANCE_NAME=hosted-dsh-0001
DSH_VERSION=0.1.0-rc.7
```

Create the host directories before starting the container:

```bash
sudo mkdir -p \
  /data/docker/dsh-0001/dsh-home \
  /data/docker/dsh-0001/workspace \
  /data/docker/dsh-0001/logs
sudo chown -R 10001:10001 /data/docker/dsh-0001
```

## Check and build

```bash
npm run deploy:g11:hosted-dsh:check

docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml build hosted-dsh
```

The check validates the Compose rendering and the baseline security guardrails.
It does not contact a real hub and does not prove a real VPS deployment.

## Join the hub manually

The registry key or replacement grant should enter through stdin or an
interactive prompt. Do not put it in `.env`, the image, or Compose environment
variables.

Interactive:

```bash
docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm hosted-dsh join
```

Stdin:

```bash
printf '%s' "$DSH_HUB_REGISTRY_KEY" | docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm -T hosted-dsh join --registry-key-stdin
```

Replacement grant:

```bash
printf '%s' "$DSH_HUB_REPLACEMENT_GRANT" | docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml run --rm -T hosted-dsh join --replacement-grant-stdin
```

Successful join stores only plugin instance credentials under the mounted DSH
home. The one-time registry key or replacement grant is not persisted by
`plugin-join`.

## Start

```bash
docker compose --env-file deploy/hosted-dsh/.env \
  -f deploy/hosted-dsh/docker-compose.yml up -d hosted-dsh
```

Then open the hub Portal and verify that the hosted instance is online. Users
should access it through the normal instance subdomain:

```text
https://<instanceId>.instances.<baseDomain>/
```

## Operations notes

- Keep one host directory per hosted DSH instance.
- Do not mount the Docker socket.
- Do not use `privileged: true`.
- Do not bind-mount broad host directories such as `/`, `/home`, `/root`, or
  `/var/run`.
- Treat the VPS administrator as able to read all mounted instance data.
- Keep real deployment evidence in a private operations overlay.
