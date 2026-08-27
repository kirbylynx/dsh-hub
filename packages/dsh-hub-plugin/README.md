# dsh-hub-plugin

Language: English | [简体中文](README.zh.md)

This package is the v0.1.0 plugin-first delivery baseline for DSH. It covers the
connection status model, session/workspace diagnostics summary, browser-card
live status bridge, explicit remote host-capability overlay, `dsh-hub-web`
one-command startup wrapper, read-only `plugin-install-check`, profile installer
`plugin-install`, and join CLI `plugin-join`.

It builds on the M4D-3 join/credential runtime, M4D-2 tunnel adapter, M4D-1
browser settings card, and M4C directory picker overlay.

Current capabilities:

- declares the standard DSH bundle: `dsh.bundle.patch -> ./cordis.patch.yml`;
- inserts a default-disabled host plugin row into the web profile;
- registers the `dsh-hub` settings namespace;
- provides `ctx.dshHubPlugin` as a read-only status service;
- reads the in-process `ctx.webServer.host/port` as the source of the later
  loopback target;
- provides `PluginTunnelAdapter`, reusing the v1.1 `runTunnel` state machine
  from `dsh-hub-client`, setting `delivery=plugin`, disabling CLI process signal
  handlers, and fixing the target to the in-process DSH webServer loopback;
- provides `PluginCredentialStore` and `PluginRuntime`: when joining with a
  registry key or replacement grant, it calls the existing `/api/register`
  endpoint with `delivery=plugin`; after success it stores only instance
  credentials such as endpoint, installationId, instanceId, instanceToken,
  expiry/renewal times, target, and versions;
- can automatically start the tunnel when the plugin is enabled and endpoint
  matches existing instance credentials; endpoint/webServer route changes stop
  the old tunnel so old-endpoint credentials are not reused for a new hub;
- rejects silent registry-key rejoin when instance credentials already exist;
  recovery must use an owner replacement grant and reuse the installation ID;
- rotates tokens by stopping the old tunnel, saving the new token, and then
  taking over; public output returns redacted summaries only; leave self-revokes
  and clears local instance credentials;
- provides `statusView` with connection state, delivery, protocol version,
  instance URL hint, target, token expiry, and recent status/error;
- provides `diagnostics()` that read-only probes the in-process DSH loopback
  root, `session.list`, `workspace.list`, `events.mux`, and `events.host`, then
  returns only mapping counts, controlled errors, and recommended actions;
- provides `remote-capabilities.patch.yml`, which explicitly disables the
  default auto/native directory picker, mounts DSH browse picker host/client
  rows, and sets `api-gateway.config.nativeOpen=false` so
  `host.describe.canOpenPath=false` can drive UI gating;
- declares `dsh.client` and a lazy-CJS `./client` browser bundle that registers
  a read-only `dsh-hub` status and diagnostics card on the DSH Plugins settings
  page;
- provides `dsh-hub-web`, which does not modify the real DSH profile. At
  startup it applies an existing enabled patch, or generates a temporary
  non-secret enabled patch from `--endpoint/--namespace`, explicitly overlays
  `remote-capabilities.patch.yml`, and then executes `dsh web`;
- provides `dsh-hub-client plugin-install-check`, a read-only check for the DSH
  command, web profile, bundle/dependency, plugin package, enabled patch, remote
  overlay, and plugin credential file presence. It does not read or print any
  token;
- provides `dsh-hub-client plugin-install`, which is dry-run by default. With
  explicit `--apply`, it writes only profile package metadata, a local plugin
  symlink, and a non-secret enabled patch. `--enabled-patch` must stay inside the
  selected profile directory and is backed up before overwrite;
- provides `dsh-hub-client plugin-join`, which dynamically loads the installed
  plugin package from the target profile and reuses `PluginRuntime.join({
  start:false })`. It stores only plugin instance credentials and does not start
  the tunnel. Use `--registry-key-stdin` / `--replacement-grant-stdin` for
  one-time secrets.

One-command remote plugin startup:

```bash
# Read-only check. Does not modify ~/.dsh or print registry/replacement/token secrets.
dsh-hub-client plugin-install-check

# Dry-run by default: preview profile package, symlink, and enabled patch changes.
dsh-hub-client plugin-install --endpoint https://control.hub.example.com --namespace my-team

# Explicit write. Does not accept registry keys, replacement grants, or instance tokens.
dsh-hub-client plugin-install --endpoint https://control.hub.example.com --namespace my-team --apply

# Reuse PluginRuntime.join; the secret enters through stdin, not settings or logs.
printf '%s' "$DSH_HUB_REGISTRY_KEY" | dsh-hub-client plugin-join \
  --endpoint https://control.hub.example.com --registry-key-stdin

# Start with the existing dsh-hub-enabled.patch.yml in the profile.
dsh-hub-web
```

Explicitly enable the remote host-capability overlay:

```bash
DSH_HUB_REMOTE_PATCH="${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-hub-plugin/remote-capabilities.patch.yml"
dsh web --patch "$DSH_HUB_REMOTE_PATCH"
```

The overlay is not enabled automatically by the default bundle patch, so the
plugin disabled/default-off state does not change original DSH behavior. It
disables the instance machine's native picker and reports `canOpenPath=false` so
UI affordances that depend on that capability can be hidden or disabled. It does
not provide a remote `openPath` replacement UI and does not intercept direct
`host.openPath` RPC.

Explicit non-goals:

- do not write registry keys or replacement grants to DSH settings, plugin
  stores, URLs, browser cards, or logs; they are one-time join inputs only;
- the browser card reads the same-origin
  `/plugins/dsh-hub-plugin/status.json` endpoint for a minimal redacted
  `statusView`, but does not read, enter, or store secrets and does not open a
  WebSocket;
- do not replace the directory picker in the default bundle patch;
- do not provide remote `host.openPath` replacement; the explicit overlay only
  disables `canOpenPath` capability advertisement / UI gating through
  `api-gateway.config.nativeOpen=false`;
- `plugin-install` does not accept registry keys, replacement grants, or
  instance tokens, and the underlying install helper is dry-run by default;
  `plugin-join` does not start the tunnel and does not write one-time secrets to
  settings, profiles, URLs, or logs. Installation and enablement must be
  separately authorized by the user.

The browser settings card uses the lazy-CJS shape verified against DSH rc.7:
`package.json` declares `dsh.client`, and `exports["./client"]` points to a
classic script that calls `window.__ModuleLoader__.load({ id, factory })`.

Local development dependencies are pinned to the currently verified DSH
`0.1.0-rc.7` package family. The M4 test suite validates profile composition,
real DSH loader activation, host-capability overlay behavior, browser-card
registration, tunnel adapter boundaries, plugin credential lifecycle, live
status and diagnostics redaction, one-command startup, and the default-dry-run
installer/join CLI behavior.
