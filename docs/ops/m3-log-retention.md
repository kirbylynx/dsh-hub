# dsh-hub self-hosted logging and redaction guide

Language: English | [简体中文](m3-log-retention.zh.md)

- Status: v0.1.0 self-hosted log retention and redaction baseline.
- Scope: Docker Compose container log rotation, incident evidence commands,
  log redaction rules, and local acceptance checks.
- Out of scope: managed logging services, Alertmanager receiver configuration,
  long-term compliance archives, and operator-private incident records.

This is a public repository guide. Real logging platforms, retention periods,
alert receivers, server paths, and incident evidence should live in the
operator's private operations overlay.

## 1. Scope and boundaries

This baseline applies only to Docker Compose container logs managed by this
repository:

- `deploy/m2-local/docker-compose.yml`: `caddy`, `authelia`, and
  `dsh-hub-service`.
- `deploy/m2-existing-caddy/docker-compose.yml`: `authelia` and
  `dsh-hub-service`.

In the existing-Caddy deployment profile, the host's system Caddy remains owned
by the server's existing configuration. dsh-hub does not take over system Caddy
logs, rotation, or other site configuration. If system Caddy access logs are
collected later, first confirm that the change does not affect other sites on
the same host.

## 2. Retention policy

Compose profiles use Docker's `json-file` driver and set each container to
`10m × 7`:

```yaml
x-dsh-hub-log-retention: &dsh-hub-log-retention
  driver: json-file
  options:
    max-size: "10m"
    max-file: "7"
```

This policy is a capacity guardrail for self-hosted deployments: each container
keeps at most about 70 MiB of Docker stdout/stderr logs. It does not replace the
audit table, Prometheus metrics, or incident drill evidence. If Loki,
CloudWatch, Vector, Fluent Bit, or another external logging system is added,
keep an equal or stricter local rotation cap and record the external retention
period as a separate operations decision.

## 3. Evidence collection

When an alert, abnormal disconnect, or failed upgrade occurs, preserve a short
evidence window before restarting or rolling back:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service > /tmp/dsh-hub-service.logs
docker compose --env-file .env -f docker-compose.yml logs --since=30m authelia > /tmp/dsh-hub-authelia.logs
curl -fsS -H 'Host: 127.0.0.1' http://127.0.0.1:18081/metrics > /tmp/dsh-hub.metrics
git -C /opt/dsh-hub rev-parse HEAD > /tmp/dsh-hub.commit
```

If you need to preserve the Docker JSON log file itself, use `docker inspect` to
identify one container's exact `LogPath`. Do not recursively copy or clean the
Docker root directory.

## 4. Redaction rules

Do not paste registry keys, replacement grants, instance tokens, Authorization
headers, or Cookies into chats, issues, tickets, runbooks, manifests, or
long-term logging systems. It is acceptable to record:

- short-window instance ID or namespace ID information needed for debugging;
- bounded error codes such as `TOKEN_EXPIRED`, `TOKEN_ROTATED`, and
  `LIMIT_EXCEEDED`;
- aggregate metrics, status counts, timestamps, commits, and compose profiles;
- short redacted log snippets after a human confirms that no credential,
  request/response body, or local workspace path is present.

The shared service/client `log()` helper redacts credential-shaped values,
Bearer tokens, Cookies, and common sensitive fields before writing to stdout.
That helper is only one layer of defense; operators must still review logs
before sharing them externally.

## 5. Acceptance evidence

Local acceptance command:

```bash
npm run deploy:m3:logging:check
```

The full check requires local `docker compose config --format json`, but it does
not connect to a remote server or modify runtime configuration. The root
`npm test` suite includes only the no-Docker redaction/documentation guardrails:

```bash
npm run test:m3:logging-redaction
```

Passing acceptance means:

- both Compose profiles declare and apply `json-file` / `10m × 7` rotation;
- the M3 logging runbook states that existing-Caddy does not take over system
  Caddy;
- service/client log helpers redact registry keys, replacement grants, instance
  tokens, Bearer Authorization, and Cookies;
- the check does not connect to production servers, read production secrets, or
  modify server configuration.

Before a real deployment, operators must separately confirm Alertmanager
receivers, external logging platforms, stress-test windows, and incident-drill
windows. This guide must not be presented as proof that a production logging
system is complete.
