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

## v0.1.x is single-owner oriented

The current MVP is suitable for trusted self-hosted evaluation and single-owner
usage. It does not yet include general multi-user roles, namespace sharing,
member invitations, per-user instance ACLs, or a full admin console.

Operators should not treat v0.1.x as a hostile-tenant SaaS isolation boundary.

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

## Hosted model settings are not yet remotely configurable

The v0.1.1 hosted DSH template can run DSH in Docker and restrict workspace
selection to `/workspace`, but DSH's native `Settings → Models` page may still
show that settings are unavailable from a remote browser. Current DSH durable
settings and credential flows are loopback-browser oriented.

Do not work around this by blindly exposing the full DSH settings or credentials
surface. A future owner/admin-controlled configuration path should handle
provider settings, API keys, redaction, permissions, and audit explicitly.

## DSH version compatibility must be verified

dsh-hub depends on DSH plugin/profile/webserver seams that may change as DSH
evolves. New DSH versions should be tested in an isolated profile before they are
recommended as the default baseline.

## Deployment templates are not production proof

The repository includes Docker Compose, Caddy, Authelia, metrics, logging, and
recovery examples. Passing template checks proves that the examples are
internally consistent; it does not prove that a specific self-hosted deployment
has been backed up, restored, upgraded, rolled back, or load-tested.

Real deployment evidence, credentials, server addresses, local paths, and
operator handoff notes should stay outside the public repository.
