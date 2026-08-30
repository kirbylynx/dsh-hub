# dsh-hub

Language: English | [简体中文](README.zh.md)

`dsh-hub` provides a multi-tenant remote access and control center for
[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/dsh) instances running
on multiple machines.

DSH intentionally listens only on loopback (`127.0.0.1:3080`) and rejects
`--host 0.0.0.0`, so that agent shell and file capabilities are not exposed to
the network. `dsh-hub` connects those loopback-only instances to a public center
through registration plus outbound tunnels. Users authenticate at the center
with Authelia, select a namespace and instance in the Portal, and open the
original DSH Web GUI through a full-page instance entry. iframe embedding remains
limited and experimental.

```text
                         ┌──────────────────────────────────────────┐
   User browser           │  dsh-hub-service (public center)         │
  ┌──────────┐  https     │                                          │
  │  Portal  │ ────────▶ │  Authelia (edge authentication)          │
  └──────────┘            │     │                                    │
       │ full-page/iframe │     ▼                                    │
       │ instA.hub...     │  HTTP+WS reverse proxy + tunnel relay    │
       └─────────────────▶│     │                                    │
                          │     ▼                                    │
                          │  Registry (namespace/instance/token)     │
                          └──────────────┬───────────────────────────┘
                                          │ outbound wss tunnel
                                          │ (instance -> center)
                            ┌─────────────┴───────────────┐
                            │                             │
                   ┌────────▼──────────┐         ┌────────▼──────────┐
                   │ dsh-hub-plugin    │         │ dsh-hub-client    │
                   │ in-process DSH    │         │ standalone npm    │
                   │ plugin            │         │ process           │
                   │  ┌─ DSH web ──┐   │         │  ┌─ DSH web ──┐   │
                   │  │127.0.0.1:P │   │         │  │127.0.0.1:3080│  │
                   │  └────────────┘   │         │  └─────────────┘   │
                   └───────────────────┘         └────────────────────┘
```

- Star topology: every instance connects outbound to the center; no public
  instance port and no P2P path are required.
- The center handles registration, relay, Portal, and authentication. It does
  not understand DSH business payloads; relay traffic is byte-forwarded.
- The two instance-side delivery modes, plugin and client, share the same relay
  protocol. See [docs/protocol.md](docs/protocol.md).

## Components

| Component | Description | Status |
| --- | --- | --- |
| `dsh-hub-service` | Center service for registration, tunnel relay, Portal, and SQLite persistence. It can run directly with Node.js or through Docker Compose with Caddy + Authelia, including an existing-Caddy backend profile. The v0.1.x baseline includes internal-only Prometheus `/metrics`, tunnel-level uncredited-byte accounting, high/low-water send gates, fair sender scheduling, local backpressure capacity checks, alert rules and runbook baseline, local backup/restore/upgrade/rollback rehearsal, Docker stdout/stderr log rotation, service/client log redaction, history-relay error classification, and non-secret `deploymentMode` metadata for remote/hosted instance display. | v0.1.3 release baseline; suitable for trusted evaluation |
| `dsh-hub-plugin` | Preferred instance-side delivery mode. It runs inside DSH and provides the host plugin skeleton, explicit `remote-capabilities.patch.yml`, DSH browse picker overlay, hosted `/workspace`-restricted picker overlay, `dsh.client` browser card, plugin tunnel adapter, registry/replacement join, instance credential storage, automatic tunnel startup, token rotate/leave, host/browser status views, local DSH session/workspace diagnostics, same-origin live status bridge, remote-origin-gated history autoload, `host.describe.canOpenPath=false` UI gating, hosted model/provider settings for DeepSeek official and OpenAI-compatible/custom Base URL providers, `dsh-hub-web` one-command startup, read-only install checks, default-dry-run profile installer, and plugin join CLI. | v0.1.3 recommended path |
| `dsh-hub-client` | Standalone instance-side process with `join`, `run`, and `status`. It can keep the tunnel across DSH restarts and also provides `plugin-install-check`, `plugin-install`, `plugin-join`, and `dsh-hub-web` helpers. It includes deployment-mode metadata, instance-side history request clamping, response normalization, raw/final byte caps, and redacted diagnostics. `plugin-install` is dry-run by default, and `plugin-join` should receive secrets from stdin or an interactive prompt. | v0.1.3 fallback and helper path |

Terms: **namespace** is a tenant/logical group, **registry key** is a namespace
registration credential, and **instance token** is a revocable instance
connection credential.

## Quick start: service + standalone client

> Requirement: Node.js >= 22. This project is developed and verified on Node 24.

```bash
# 1. Install dependencies
npm install

# 2. Start the center service.
#    It listens on 127.0.0.1:8081 and stores data at ./data/hub.db by default.
#    DEV_AUTH_USER=dev is development-only and simulates an authenticated
#    Authelia user. Production deployments must put Authelia in front.
DEV_AUTH_USER=dev node packages/dsh-hub-service/bin/dsh-hub-service.js --port 8081

# 3. In another terminal, join an instance.
node packages/dsh-hub-client/bin/dsh-hub-client.js join \
  --endpoint http://127.0.0.1:8081 --registry-key <KEY>

# 4. Run the tunnel from local DSH Web to the center.
node packages/dsh-hub-client/bin/dsh-hub-client.js run

# 5. Optional: collect read-only compatibility diagnostics.
node packages/dsh-hub-client/bin/dsh-hub-client.js diagnose --json

# 6. Open the Portal and then the instance subdomain:
#    http://127.0.0.1:8081/
#    http://<instanceId>.localhost:8081/
```

### Plugin remote mode: install, join, and one-command startup

`dsh-hub-web` is a safe wrapper around `dsh web`. It does not store registry
keys, replacement grants, or instance tokens. At startup it applies the plugin
enabled patch plus `remote-capabilities.patch.yml`, so remote browse picker and
`canOpenPath=false` UI gating are active. `plugin-install` is dry-run by default
and writes a DSH profile only when `--apply` is provided.

```bash
# Read-only check for plugin, overlay, and credential readiness.
dsh-hub-client plugin-install-check

# Preview installation. This does not write ~/.dsh.
dsh-hub-client plugin-install \
  --endpoint https://control.hub.example.com --namespace my-team

# Apply installation: profile package, local plugin symlink, and non-secret
# enabled patch only.
dsh-hub-client plugin-install \
  --endpoint https://control.hub.example.com --namespace my-team --apply

# Prefer stdin for registry keys so secrets do not enter shell history.
printf '%s' "$DSH_HUB_REGISTRY_KEY" | dsh-hub-client plugin-join \
  --endpoint https://control.hub.example.com --registry-key-stdin

# Start the remote plugin mode.
dsh-hub-web
```

The v0.1.3 release baseline keeps the v0.1.2 validated plugin installation,
join, startup, baseline remote access, hosted container startup, and
large-session history loading paths, and adds a narrow hosted model/provider
settings panel in the DSH Web plugin card. Registry keys and replacement grants
should still be supplied through stdin or interactive input. `dsh-hub-web` does
not persist these one-time secrets.

### First use: create a namespace and registry key

```bash
# Center-side namespace creation. Requires DEV_AUTH_USER or Authelia identity.
curl -H 'x-authenticated-user: dev' http://127.0.0.1:8081/api/namespaces \
  -d '{"name":"my-team"}'
# -> { "namespace": {...}, "registryKey": "dhk_..." }
```

## Security model

**Center authentication is the only security boundary.** After the center
forwards a request, DSH sees it like a request from a local browser. The instance
side rewrites Host to `127.0.0.1` and strips Origin / `sec-fetch-*` headers so
DSH's local Host fence can be satisfied, including privileged methods.

- Any path that bypasses center authentication and directly reaches an instance
  must be impossible. Instances receive traffic only through outbound tunnels.
- User -> namespace -> instance ACLs are enforced by the center.
- Authelia rules must cover every instance subdomain (`*.hub.example.com`) so
  users cannot bypass the Portal by opening an instance host directly.
- Instance tokens can be revoked; revocation closes tunnels. Registry keys can
  be rotated for future registration.
- TLS is required end to end (`https` + `wss`), and instances must verify the
  center certificate.

> One instance per subdomain is a hard requirement. DSH Web resolves APIs from
> `location.origin + "/api/..."` and cannot be mounted under a URL path prefix.
> Each instance therefore lives at the root of its own subdomain, such as
> `<instanceId>.hub.example.com` or `<instanceId>.localhost` for local
> development.

## Milestones

- **M1A/M1B**: security, credentials, protocol, and bounded relay are complete
  and reviewed.
- **M1C**: baseline real-DSH HTTP/WS and full-page instance access passed.
  iframe, restart recovery, long chat/tool/attachment flows, and npm
  `latest/next` still need broader testing.
- **M2**: deployment templates for all-in-one Compose and existing-Caddy backend
  profiles. Public examples remain generic; real domains, server addresses, and
  deployment evidence belong in an operator-owned private overlay.
- **M3A**: minimal remote compatibility diagnostics are implemented. The Portal
  can run owner-only read diagnostics through an online tunnel without returning
  local workspace paths, request bodies, or secrets.
- **M4**: plugin-first remote UX reached the v0.1.0 MVP bar, including remote
  DSH Web UI, plugin tunnel, browse picker, status card, diagnostics, and
  `canOpenPath=false` UI gating. Remote `openPath` replacement UI is out of
  scope for v0.1.0.
- **M3B**: operations baseline reached the v0.1.0 MVP bar: internal metrics,
  alert examples, runbooks, local recovery/rollback rehearsal, log rotation, and
  redaction. Long stress tests, real deployment recovery drills, Alertmanager
  receivers, and failure drills remain future production-hardening work.
- **v0.1.0**: MVP closed. See [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md).
- **v0.1.1**: experimental manually managed hosted DSH container baseline added.
  See [docs/releases/v0.1.1.md](docs/releases/v0.1.1.md).
- **v0.1.2**: large-session history loading baseline added. Instance-side
  history requests are capped, settled history chunks are normalized before
  leaving the instance, browser autoload is gated to remote origins, and errors
  are classified without logging payload content. See
  [docs/releases/v0.1.2.md](docs/releases/v0.1.2.md).
- **v0.1.3**: hosted DSH instances can advertise
  `deploymentMode=hosted`, and the plugin browser card exposes a narrow
  same-origin model/provider settings panel for DeepSeek official and
  OpenAI-compatible/custom Base URL providers. API keys are written only to the
  hosted DSH local credential store, never to the Hub service database. See
  [docs/releases/v0.1.3.md](docs/releases/v0.1.3.md).
- **Next**: see [docs/ROADMAP.md](docs/ROADMAP.md). Current limitations are
  tracked in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

v0.1.3 still does not include multi-user roles, an admin console, a headless
control API, per-user session isolation, P2P, multi-instance workbench features,
remote `openPath` replacement UI, Portal-side model administration, or automatic
hosted instance assignment.

## Documentation

Every Markdown document has a matching Simplified Chinese version named
`*.zh.md`, linked from the document header.

- [docs/ROADMAP.md](docs/ROADMAP.md) — public post-v0.1.3 roadmap.
- [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) — known v0.1.x
  limitations.
- [docs/releases/v0.1.0.md](docs/releases/v0.1.0.md) — v0.1.0 closeout notes.
- [docs/releases/v0.1.1.md](docs/releases/v0.1.1.md) — v0.1.1 hosted DSH
  closeout notes.
- [docs/releases/v0.1.2.md](docs/releases/v0.1.2.md) — v0.1.2 large-session
  history loading closeout notes.
- [docs/releases/v0.1.3.md](docs/releases/v0.1.3.md) — v0.1.3 hosted
  model/provider settings closeout notes.
- [docs/plans/20260821-v0.1.0-requirements.md](docs/plans/20260821-v0.1.0-requirements.md)
  — v0.1.0 requirements baseline.
- [docs/plans/20260821-v0.1.0-design.md](docs/plans/20260821-v0.1.0-design.md)
  — v0.1.0 design baseline.
- [docs/plans/20260821-v0.1.0-implementation-plan.md](docs/plans/20260821-v0.1.0-implementation-plan.md)
  — v0.1.0 implementation baseline.
- [docs/protocol.md](docs/protocol.md) — relay protocol.
- [deploy/m3-observability/README.md](deploy/m3-observability/README.md) —
  alert rule validation.
- [deploy/m3-recovery/README.md](deploy/m3-recovery/README.md) — local
  recovery/rollback rehearsal validation.
- [deploy/hosted-dsh/README.md](deploy/hosted-dsh/README.md) — experimental
  manual hosted DSH container template with `/workspace`-restricted directory
  picker.

## Operations and self-hosting guides

If you plan to self-host dsh-hub, start with these public guides. They describe
templates and security boundaries, not real deployment evidence:

- [docs/ops/m3-runbook.md](docs/ops/m3-runbook.md) — alert response and
  operations runbook.
- [docs/ops/m3-recovery-runbook.md](docs/ops/m3-recovery-runbook.md) — SQLite
  backup, restore, upgrade, and rollback guide.
- [docs/ops/m3-log-retention.md](docs/ops/m3-log-retention.md) — Docker log
  rotation and redaction guide.
- [deploy/hosted-dsh/README.md](deploy/hosted-dsh/README.md) — experimental
  manual hosted DSH container template.

## License

MIT License. See [LICENSE](LICENSE).
