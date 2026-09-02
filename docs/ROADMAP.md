# Roadmap

Language: English | [简体中文](ROADMAP.zh.md)

This document summarizes the public post-v0.1.5 direction for dsh-hub. It is a
product and engineering roadmap, not a commitment to specific delivery dates.

For release baselines, see [docs/releases/v0.1.0.md](releases/v0.1.0.md) and
[docs/releases/v0.1.1.md](releases/v0.1.1.md). v0.1.2 adds the first bounded
large-session history loading baseline; see
[docs/releases/v0.1.2.md](releases/v0.1.2.md). v0.1.3 adds the first narrow
hosted model/provider settings path in the DSH Web plugin card; see
[docs/releases/v0.1.3.md](releases/v0.1.3.md). v0.1.4 adds production release
hygiene docs for self-hosted deployments; see
[docs/releases/v0.1.4.md](releases/v0.1.4.md). v0.1.5 adds the first
LLDAP-backed multi-user baseline; see
[docs/releases/v0.1.5.md](releases/v0.1.5.md).

## Near-term priorities

### Large session history hardening

v0.1.2 implements the first bounded lazy-loading baseline for large DSH
conversation histories: newest messages are shown first, older history can load
as the user scrolls upward, and instance-side normalization removes settled
assistant chunks before responses leave the instance.

Future work should harden this baseline across more DSH versions and very large
real transcripts, expose safe operator tuning, and keep compatibility tests
aligned with the DSH history API surface.

### Production hardening

The v0.1.4 baseline adds public production checklists, release/tag/deploy
guidance, SQLite backup verification guidance, and existing-Caddy coexistence
guidance. Future work should continue making self-hosting safer and more
repeatable:

- long-running relay and plugin stability tests;
- real rollback and disaster-recovery drills;
- real Alertmanager receiver setup and notification tests;
- capacity guidance for large uploads, WebSocket sessions, and slow links.

### Multi-user permissions and password flows

v0.1.5 implements the first trusted self-hosted multi-user baseline: LLDAP
invite registration, namespace roles, member/invite management, instance ACLs,
and system-admin user disable/restore. Future work should harden this with
self-service password changes, administrator password reset, broader UI
polishing, and more cross-user negative tests.

### Admin console

v0.1.5 introduces a lightweight left-navigation Portal for common operations.
Future admin-console work should improve layout, audit browsing, bulk member
operations, search, and operator ergonomics without weakening the current
authorization model.

## Compatibility and user experience

### DSH version compatibility

DSH is still evolving. dsh-hub depends on specific DSH seams: plugin loading,
profile composition, browser client registration, the local web server, directory
picker behavior, and HTTP/WebSocket APIs. Future releases should publish a small
compatibility matrix and make the recommended DSH version explicit.

### Remote file actions

Remote directory selection is handled through a browser-oriented picker in the
plugin-first path. Native `openPath` remains gated because it would execute on
the instance machine, not the remote browser. Future work may add safer
alternatives such as previews, downloads, copy-path affordances, or audited file
actions.

### Portal embedding

The reliable v0.1.0 entry path is full-page instance subdomain access. iframe
embedding remains experimental because it touches frame policy, same-site cookie
behavior, Origin/CORS, Fetch Metadata, and authentication boundaries.

## Hosted DSH

### Hosted DSH containers

v0.1.1 adds the first experimental, manually managed hosted DSH container
template. It runs DSH inside Docker, connects through the same plugin tunnel used
by desktop instances, stores DSH home/workspace/logs in per-instance bind mounts,
and restricts the hosted workspace picker to container `/workspace`.

This remains an operator-run self-hosting template, not a hostile-tenant SaaS
sandbox. A larger hosted instance pool should build on the v0.1.5 multi-user
baseline and still needs allocation, quota, cleanup, and abuse controls.

### Hosted model/provider settings

v0.1.3 adds a hosted-only dsh-hub plugin panel for DeepSeek official and
OpenAI-compatible/custom Base URL providers. It writes through local DSH
settings and credentials seams after local hosted eligibility checks, and it
does not store provider API keys in the Hub service.

Future work should move common hosted model administration into a Portal-side
owner/admin flow now that the first multi-user permission baseline exists.

## Longer-term exploration

### Headless automation API

Automated control could be useful, but it is a high-risk expansion because DSH
can operate on files and shell-like workflows. Any headless API must have clear
authorization, audit, rate limits, and explicit separation from browser session
cookies.

### Multi-instance workbench

Future Portal versions may aggregate multiple instances with favorites, groups,
health summaries, and quick switching. The first version should use hub-owned
metadata and diagnostics summaries, not cached DSH conversation content.

### High availability and multi-center routing

v0.1.0 uses a single service with SQLite. High availability, multi-center
routing, or peer-to-peer designs require separate evaluation of consistency,
token lifecycle, audit ownership, failover behavior, and operational complexity.
