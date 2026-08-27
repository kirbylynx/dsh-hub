import { diagnoseLocalDsh } from 'dsh-hub-client/src/probe.js';
import { createPluginTunnelTarget } from './tunnel-adapter.js';
import { redactPluginSecrets } from './runtime.js';

const POSIX_PATH_PATTERN = /(^|[\s"'(=,:;])\/(?:Users|home|root|var|tmp|private\/var|Volumes|mnt|opt|srv|workspace)\/[^\s"',)<>\]]+/g;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:\\[^\s"',)]+/g;
const UNC_PATH_PATTERN = /\\\\[^\\\s"',)<>\]]+\\[^\s"',)<>\]]+/g;

function sanitizeText(value) {
  if (value === null || value === undefined) return null;
  return redactPluginSecrets(String(value))
    .replace(POSIX_PATH_PATTERN, '$1[redacted-path]')
    .replace(WINDOWS_PATH_PATTERN, '[redacted-path]')
    .replace(UNC_PATH_PATTERN, '[redacted-path]');
}

function publicTarget(target) {
  if (!target || typeof target !== 'object') return sanitizeText(target);
  return Object.freeze({
    ...target,
    error: sanitizeText(target.error),
    host: sanitizeText(target.host),
    authority: sanitizeText(target.authority),
  });
}

function publicProbeError(error) {
  if (!error) return null;
  if (typeof error === 'string') return sanitizeText(error);
  if (typeof error !== 'object') return sanitizeText(error);
  return Object.freeze({
    code: sanitizeText(error.code ?? error.name ?? 'DSH_PROBE_ERROR'),
    message: sanitizeText(error.message ?? error.error ?? String(error)),
  });
}

function summarizeRpcProbe(probe) {
  return Object.freeze({
    ok: probe?.ok === true,
    status: Number.isInteger(probe?.status) ? probe.status : 0,
    itemCount: Number.isInteger(probe?.itemCount) ? probe.itemCount : null,
    error: publicProbeError(probe?.error),
  });
}

function summarizeWsProbe(probe) {
  return Object.freeze({
    opened: probe?.opened === true,
    idle: probe?.idle === true,
    messages: Number.isInteger(probe?.messages) ? probe.messages : 0,
    firstBytes: Number.isInteger(probe?.firstBytes) ? probe.firstBytes : 0,
    error: sanitizeText(probe?.error),
  });
}

function recommendation(code, severity, message) {
  return Object.freeze({ code, severity, message });
}

function buildRecommendations(summary) {
  const items = [];
  if (summary.root?.online !== true) {
    items.push(recommendation('DSH_WEB_OFFLINE', 'attention', 'DSH web root probe is not online.'));
  }
  if (summary.dshApi.sessionList.ok !== true || summary.dshApi.workspaceList.ok !== true) {
    items.push(recommendation('DSH_API_PROBE_FAILED', 'attention', 'DSH session/workspace API probe failed.'));
  }
  if ((summary.workspaceMapping?.unlinkedSessionCount ?? 0) > 0) {
    items.push(recommendation('UNLINKED_SESSIONS', 'info', 'Some sessions are not linked from any workspace registry entry.'));
  }
  if ((summary.workspaceMapping?.staleWorkspaceSessionCount ?? 0) > 0) {
    items.push(recommendation('STALE_WORKSPACE_SESSION_IDS', 'info', 'Some workspace registry session IDs are stale.'));
  }
  if (summary.websocket.eventsMux.opened !== true) {
    items.push(recommendation('EVENTS_MUX_UNAVAILABLE', 'attention', 'DSH events.mux WebSocket did not open.'));
  }
  if (summary.hostCapabilities.directoryPicker.remoteLimited === true) {
    items.push(recommendation('DIRECTORY_PICKER_REMOTE_LIMITED', 'info', 'Use the explicit remote capabilities overlay to avoid native picker popups on the instance machine.'));
  }
  items.push(recommendation('OPEN_PATH_LOCAL_ONLY', 'info', 'Use the explicit remote capabilities overlay to make host.describe.canOpenPath=false for UI gating; direct host.openPath RPC is not intercepted and no remote replacement is provided yet.'));
  return Object.freeze(items);
}

export function summarizePluginDiagnostics(raw = {}) {
  const summary = {
    state: 'ok',
    checkedAt: raw.checkedAt ?? new Date().toISOString(),
    target: sanitizeText(raw.target) ?? null,
    root: Object.freeze({
      online: raw.root?.online === true,
      status: Number.isInteger(raw.root?.status) ? raw.root.status : 0,
    }),
    dshApi: Object.freeze({
      sessionList: summarizeRpcProbe(raw.api?.sessionList),
      workspaceList: summarizeRpcProbe(raw.api?.workspaceList),
    }),
    websocket: Object.freeze({
      eventsMux: summarizeWsProbe(raw.websocket?.eventsMux),
      eventsHost: summarizeWsProbe(raw.websocket?.eventsHost),
    }),
    workspaceMapping: Object.freeze({
      sessionCount: Number.isInteger(raw.workspaceMapping?.sessionCount) ? raw.workspaceMapping.sessionCount : null,
      workspaceCount: Number.isInteger(raw.workspaceMapping?.workspaceCount) ? raw.workspaceMapping.workspaceCount : null,
      linkedSessionCount: Number.isInteger(raw.workspaceMapping?.linkedSessionCount) ? raw.workspaceMapping.linkedSessionCount : null,
      unlinkedSessionCount: Number.isInteger(raw.workspaceMapping?.unlinkedSessionCount) ? raw.workspaceMapping.unlinkedSessionCount : null,
      staleWorkspaceSessionCount: Number.isInteger(raw.workspaceMapping?.staleWorkspaceSessionCount) ? raw.workspaceMapping.staleWorkspaceSessionCount : null,
      samplesTruncated: raw.workspaceMapping?.truncated === true || raw.workspaceMapping?.staleWorkspaceSessionTruncated === true,
    }),
    hostCapabilities: Object.freeze({
      directoryPicker: Object.freeze({
        state: raw.hostCapabilities?.inferredDirectoryPicker ?? 'unknown',
        remoteLimited: raw.hostCapabilities?.remoteLimited === true,
      }),
      openPath: Object.freeze({
        state: 'can-open-path-overlay-available',
        remoteLimited: true,
        canOpenPathOverlay: true,
        directRpcIntercept: false,
      }),
    }),
    recommendations: [],
  };
  summary.recommendations = buildRecommendations(summary);
  if (summary.root.online !== true
    || summary.dshApi.sessionList.ok !== true
    || summary.dshApi.workspaceList.ok !== true
    || summary.websocket.eventsMux.opened !== true) {
    summary.state = 'attention';
  }
  return Object.freeze(summary);
}

export async function diagnosePluginLocalDsh({
  webServer,
  timeoutMs = 3000,
  probe = diagnoseLocalDsh,
} = {}) {
  const target = createPluginTunnelTarget(webServer);
  if (!target.ok) {
    return Object.freeze({
      state: 'unavailable',
      checkedAt: new Date().toISOString(),
      target: publicTarget(target),
      error: sanitizeText(target.error ?? 'webServer target unavailable'),
      recommendations: Object.freeze([
        recommendation('TARGET_UNAVAILABLE', 'attention', 'DSH webServer loopback target is unavailable.'),
        recommendation('OPEN_PATH_LOCAL_ONLY', 'info', 'Use the explicit remote capabilities overlay to make host.describe.canOpenPath=false for UI gating; direct host.openPath RPC is not intercepted and no remote replacement is provided yet.'),
      ]),
    });
  }
  try {
    const raw = await probe(target.authority, { timeoutMs });
    return summarizePluginDiagnostics(raw);
  } catch (error) {
    return Object.freeze({
      state: 'error',
      checkedAt: new Date().toISOString(),
      target: publicTarget(target),
      error: publicProbeError(error),
      recommendations: Object.freeze([
        recommendation('DIAGNOSTICS_FAILED', 'attention', 'Plugin local DSH diagnostics failed.'),
        recommendation('OPEN_PATH_LOCAL_ONLY', 'info', 'Use the explicit remote capabilities overlay to make host.describe.canOpenPath=false for UI gating; direct host.openPath RPC is not intercepted and no remote replacement is provided yet.'),
      ]),
    });
  }
}
