# Known limitations

Language: English | [简体中文](KNOWN-LIMITATIONS.zh.md)

This document lists important limitations of the v0.1.x self-hosted baseline.

For planned follow-up areas, see [docs/ROADMAP.md](ROADMAP.md).

## Large session histories have bounded lazy-loading safeguards

The v0.1.2 baseline adds lazy-loading safeguards for large DSH conversation
histories. Remote history requests are capped by default, settled assistant
chunks are normalized before leaving the instance, and both raw and normalized
responses have byte limits.

This improves the common large-history path, but it is not a full search/index
system and it does not promise unlimited history sizes. Very old DSH versions,
future DSH API changes, extreme transcripts, or weak links may still require
configuration tuning or compatibility work.

## Full-page instance access is the reliable entry path

dsh-hub intentionally uses per-instance subdomains as the reliable access model:

```text
https://<instanceId>.instances.hub.example.com/
```

iframe embedding is not the default supported path in v0.1.0. Restoring iframe
as a recommended option requires a dedicated review of frame policy, cookies,
Origin/CORS, Fetch Metadata, and authentication behavior.

## v0.1.6 multi-user and admin support is an early trusted self-hosted baseline

v0.1.5 adds LLDAP-backed invite registration, namespace roles, member/invite
management, system-admin user disable/restore, and instance ACL checks. v0.1.6
adds the first namespace/admin console baseline for namespace create/edit/list,
registry-key reveal/copy/update, replacement grants, instance lifecycle actions,
diagnostics, audit browsing, and common pagination. This is still an early
trusted self-hosted baseline, not a mature multi-tenant SaaS boundary.

Operators should not treat v0.1.x as a hostile-tenant SaaS isolation boundary.
Self-service password changes, administrator password resets, email-based
password recovery, team-owned namespaces, namespace ownership transfer/deletion,
bulk admin workflows, and deeper audit/search UX remain future work.

## Agent mode is fallback, not the primary remote UX

The recommended path is `dsh-hub-plugin`, which runs inside DSH and can integrate
with DSH browser-side affordances. The standalone `dsh-hub-client` remains useful
for bootstrap, diagnostics, fallback, and plugin helper commands.

Agent mode should not be used to infer that every local desktop capability is
safe or meaningful when invoked from a remote browser.

## Remote native file opening is intentionally gated

Native `openPath` behavior would act on the instance machine. v0.1.x therefore
gates that capability in the remote profile. Future releases may provide safer
remote-oriented replacements, such as file previews, downloads, copy-path
prompts, or audited actions.

## Hosted model settings use a narrow dsh-hub panel

DSH's native `Settings → Models` page may still show that settings are
unavailable from a remote hosted browser. v0.1.3 therefore adds a narrower
dsh-hub plugin panel for hosted instances only. It can write DeepSeek official
settings and OpenAI-compatible/custom Base URL providers to that hosted DSH
instance's local settings and credential store.

This is not a general settings bridge. The Hub service does not store provider
API keys, remote joined desktop instances remain read-only for model settings,
and Portal-side owner/admin management is still future work.

## DSH version compatibility must be verified

dsh-hub depends on DSH plugin/profile/webserver seams that may change as DSH
evolves. New DSH versions should be tested in an isolated profile before they are
recommended as the default baseline.

## Public production guides are not deployment proof

The repository includes Docker Compose, Caddy, Authelia, LLDAP, metrics, logging,
recovery examples, and v0.1.6 production release guides. Passing template checks
or following the public checklist proves only that the examples are internally
consistent and that an operator followed a process; it does not prove that a
specific self-hosted deployment has been backed up, restored, upgraded, rolled
back, or load-tested.

Real deployment evidence, credentials, server addresses, local paths, and
operator handoff notes should stay outside the public repository.
