# dsh-hub self-hosted operations guide

Language: English | [简体中文](m3-runbook.zh.md)

- Status: v0.1.0 self-hosted alert and runbook baseline.
- Scope: self-hosted `dsh-hub-service`, internal `/metrics`, and Prometheus
  alert response.
- Out of scope: managed-service SLAs, long-term capacity commitments,
  production stress-test reports, and operator-private incident records.

This public guide uses `hub.example.com`, `control.hub.example.com`, and the
existing-Caddy template by default. Real domains, server paths, Prometheus
receivers, deployment evidence, and incident records should live in the
operator's private operations overlay.

## 1. Principles

- `/metrics` must be readable only through loopback source addresses and a
  loopback Host. Do not scrape it through public domains.
- Alert rules must not include tokens, registry keys, Authorization headers,
  local workspace paths, instance identifiers, or namespace identifiers.
- Heartbeat `sentAt` age is the age of the send timestamp observed by the
  service; it is not end-to-end RTT.
- Preserve evidence before restarting: save `docker compose ps`, recent logs, a
  `/metrics` snapshot, and the current commit.
- Public issues, chats, and tickets should include redacted logs only. Do not
  share credentials, Cookies, request bodies, or workspace paths.

## 2. Quick evidence commands

The existing-Caddy template uses `127.0.0.1:18081` as the default backend:

```bash
cd /opt/dsh-hub/deploy/m2-existing-caddy
git rev-parse --short HEAD
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service
curl -fsS http://127.0.0.1:18081/healthz -H 'Host: control.hub.example.com'
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' > /tmp/dsh-hub.metrics.$(date +%Y%m%d%H%M%S).txt
```

Public entry points must continue to reject `/metrics`:

```bash
curl -i https://control.hub.example.com/metrics
curl -i https://hub.example.com/metrics
```

The expected result is that public routes do not return Prometheus metric text.

## 3. Alert response

### DshHubServiceScrapeDown

Meaning: Prometheus cannot scrape internal `/metrics`.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | head
docker compose --env-file .env -f docker-compose.yml ps
docker compose --env-file .env -f docker-compose.yml logs --since=15m dsh-hub-service
```

Action: if the service is unhealthy, first preserve logs and compose state; then
restart the service only after confirming that the database volume exists. If
the service is healthy, check that the Prometheus scrape target still points to
the loopback backend rather than a public Host.

### DshHubTunnelHandshakeFailures

Meaning: tunnel authentication or protocol handshakes are failing repeatedly.

Checks:

```bash
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service | grep -E 'tunnel auth failed|handshake|TOKEN_|PROTO|CAPABILITY'
```

Action: first distinguish token expiry, token rotation, client/plugin version
mismatch, and non-loopback targets. Do not paste instance tokens, registry keys,
or replacement grants into logs or tickets.

### DshHubLimitRejectionBurst

Meaning: request size, session count, rate limit, or backpressure limits are
rejecting requests in a burst.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_limit_rejections_total|dsh_hub_http_errors_total|dsh_hub_rate_limit_rejections_total'
```

Action: if the code is `RATE_LIMITED`, look for repeated refreshes, automation,
or abnormal clients. If the code is `LIMIT_EXCEEDED`, inspect body/message/session
sizes and backpressure metrics. Do not make limits larger as the first reaction.

### DshHubDshHealthStaleOrOffline

Meaning: an existing tunnel reports local DSH health as stale or offline.

Checks: run read-only diagnostics for the instance in the Portal, or ask the
instance machine to check the DSH process and `127.0.0.1:3080`.

Action: if the tunnel is online but DSH is offline, restart instance-side DSH or
the plugin/agent first. If health is stale, check host sleep, network jitter, and
whether heartbeat is still continuous.

### DshHubHeartbeatSentAtAgeHigh

Meaning: the heartbeat `sentAt` age observed by the service remains high.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_heartbeat_sent_at_age_seconds'
```

Action: treat this as send-timestamp age, not RTT. Combine it with event-loop
delay, tunnel reconnects, server CPU, and load to decide whether the service,
the instance machine, or the network queue is slow.

### DshHubRelayBackpressureSustained

Meaning: relay is waiting for credit while uncredited bytes persist.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_relay_credit_waiters|dsh_hub_relay_uncredited_bytes|dsh_hub_relay_queued_bytes'
```

Action: check for large uploads, slow browser downloads, slow local DSH
responses, or WebSocket buildup. If `LIMIT_EXCEEDED` appears at the same time,
preserve the request time window and logs before tuning thresholds.

### DshHubRelayDownstreamBufferedHigh

Meaning: tunnel WebSocket, HTTP response, or browser WebSocket downstream buffers
are high.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_relay_downstream_buffered_bytes'
```

Action: look first for slow clients, long responses, browser disconnects that
did not propagate promptly, and network bottlenecks. Do not inspect only the
active session count; also inspect queued, uncredited, and credit-wait metrics.

### DshHubSQLiteWriteLatencyHigh

Meaning: service-side SQLite writes remain slow.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_sqlite_write_seconds'
df -h
docker compose --env-file .env -f docker-compose.yml logs --since=30m dsh-hub-service | grep -E 'SQLITE|database|disk|busy|locked'
```

Action: check disk space, the database volume, backup jobs, and lock waits. If
database corruption is suspected, copy the database before stopping writes; do
not repair it in place.

### DshHubMemoryHigh

Meaning: service RSS exceeds the alert threshold.

Checks:

```bash
docker stats --no-stream
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep -E 'dsh_hub_process_resident_memory_bytes|dsh_hub_process_heap_used_bytes'
```

Action: use active sessions, queued bytes, uncredited bytes, and downstream
buffered bytes to decide whether this is normal load, a slow downstream, or a
leak. If a restart is needed, first consider the impact on active sessions.

### DshHubEventLoopDelayHigh

Meaning: Node.js event loop delay max remains high.

Checks:

```bash
curl -fsS http://127.0.0.1:18081/metrics -H 'Host: 127.0.0.1' | grep 'dsh_hub_event_loop_delay_seconds'
top
docker stats --no-stream
```

Action: check CPU saturation, synchronous disk I/O, log flushing, unusually
large requests, and container resource limits. If heartbeat age is also high,
start with the service-stall hypothesis.

## 4. Local alert-rule validation

```bash
npm run deploy:m3:alerts:check
```

This check ensures that alert rules reference `dsh_hub_*` metrics emitted by the
current service implementation and do not use high-cardinality or secret-related
labels.
