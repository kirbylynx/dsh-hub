# Roadmap

Language: English | [简体中文](ROADMAP.zh.md)

This document summarizes the public post-v0.1.0 direction for dsh-hub. It is a
product and engineering roadmap, not a commitment to specific delivery dates.

For the current release baseline, see [docs/releases/v0.1.0.md](releases/v0.1.0.md).

## Near-term priorities

### Large session history performance

Very large DSH conversations can be slow to open over a remote tunnel when the
UI requests the full history at once. The preferred direction is lazy loading:
show the newest messages first, then load older history as the user scrolls or
requests it.

Before implementation, dsh-hub should confirm which DSH history API parameters
are stable enough to rely on. If DSH does not expose a reliable paging contract,
any adapter must avoid simply downloading the full history and slicing it in the
browser.

### Production hardening

The v0.1.0 baseline includes Docker Compose templates, metrics, alert rules,
logging/redaction checks, and local recovery rehearsal. Future work should make
self-hosting safer and more repeatable:

- release tags and upgrade notes;
- long-running relay and plugin stability tests;
- backup, restore, upgrade, and rollback drills for real deployments;
- clearer Alertmanager integration examples;
- capacity guidance for large uploads, WebSocket sessions, and slow links.

### Multi-user permissions

v0.1.0 is designed for a single trusted owner namespace. Multi-user deployments
need an explicit authorization model before they can be recommended broadly.
Future work should define users, roles, namespace membership, instance access,
audit visibility, and cross-user negative tests.

### Admin console

Many v0.1.0 management actions are available through APIs or command-line
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

## Longer-term exploration

### Hosted DSH containers

A self-hosted operator may want to run DSH inside a Docker container on a server
and connect it to dsh-hub through the same plugin tunnel used by desktop
instances. This appears feasible without changing the tunnel protocol, but it
requires careful work on container isolation, mounted data directories, resource
limits, secret handling, backups, and lifecycle management.

The first useful step would be a manually managed single-container template. A
larger hosted instance pool should wait until multi-user permissions and admin
operations are defined.

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
