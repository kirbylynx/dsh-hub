# Roadmap

Language: English | [简体中文](ROADMAP.zh.md)

This document summarizes the public post-v0.1.4 direction for dsh-hub. It is a
product and engineering roadmap, not a commitment to specific delivery dates.

For release baselines, see [docs/releases/v0.1.0.md](releases/v0.1.0.md) and
[docs/releases/v0.1.1.md](releases/v0.1.1.md). v0.1.2 adds the first bounded
large-session history loading baseline; see
[docs/releases/v0.1.2.md](releases/v0.1.2.md). v0.1.3 adds the first narrow
hosted model/provider settings path in the DSH Web plugin card; see
[docs/releases/v0.1.3.md](releases/v0.1.3.md). v0.1.4 adds production release
hygiene docs for self-hosted deployments; see
[docs/releases/v0.1.4.md](releases/v0.1.4.md).

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

### Multi-user permissions

v0.1.x is designed for a single trusted owner namespace. Multi-user deployments
need an explicit authorization model before they can be recommended broadly.
Future work should define users, roles, namespace membership, instance access,
audit visibility, and cross-user negative tests.

### Admin console

Many v0.1.x management actions are available through APIs or command-line
helpers. A future admin console should expose common operations safely:
namespace management, registry key rotation, replacement grants, instance
revocation, diagnostics, and audit review.

The admin console should build on the multi-user permission model instead of
hard-coding single-owner assumptions.

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
sandbox. A larger hosted instance pool should wait until multi-user permissions
and admin operations are defined.

### Hosted model/provider settings

v0.1.3 adds a hosted-only dsh-hub plugin panel for DeepSeek official and
OpenAI-compatible/custom Base URL providers. It writes through local DSH
settings and credentials seams after local hosted eligibility checks, and it
does not store provider API keys in the Hub service.

Future work should move common hosted model administration into a Portal-side
owner/admin flow after the multi-user permission model is defined.

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
