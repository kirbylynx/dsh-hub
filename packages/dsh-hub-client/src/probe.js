import http from 'node:http';
import os from 'node:os';
import WebSocket from 'ws';
import { parseTarget } from './util.js';

/**
 * Probe the local DSH web (GET /) to determine whether it is online.
 * Returns { online, status }.
 */
export function probeLocalDsh(target, timeoutMs = 2000) {
  const { host, port } = parseTarget(target);
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ online: res.statusCode === 200, status: res.statusCode }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ online: false, status: 0 });
    });
    req.on('error', () => resolve({ online: false, status: 0 }));
  });
}

export async function diagnoseLocalDsh(target, { timeoutMs = 3000 } = {}) {
  const root = await probeLocalDsh(target, timeoutMs);
  const sessionList = await dshRpc(target, 'session.list', timeoutMs);
  const workspaceList = await dshRpc(target, 'workspace.list', timeoutMs);
  const eventsMux = await wsProbe(target, '/api/events.mux', { timeoutMs, expectMessage: true });
  const eventsHost = await wsProbe(target, '/api/events.host', { timeoutMs, expectMessage: false });
  const workspaceSessionIds = collectWorkspaceSessionIds(workspaceList.items);
  const allSessionIds = collectSessionIds(sessionList.items);
  const allSessionIdSet = new Set(allSessionIds);
  const linkedSessionIds = [...workspaceSessionIds].filter((id) => allSessionIdSet.has(id));
  const unlinkedSessionIds = allSessionIds.filter((id) => !workspaceSessionIds.has(id));
  const staleWorkspaceSessionIds = [...workspaceSessionIds].filter((id) => !allSessionIdSet.has(id));

  return {
    target,
    checkedAt: new Date().toISOString(),
    root,
    api: {
      sessionList: summarizeRpc(sessionList),
      workspaceList: summarizeRpc(workspaceList),
    },
    websocket: {
      eventsMux,
      eventsHost,
    },
    workspaceMapping: {
      sessionCount: allSessionIds.length,
      workspaceCount: Array.isArray(workspaceList.items) ? workspaceList.items.length : null,
      linkedSessionCount: linkedSessionIds.length,
      unlinkedSessionCount: unlinkedSessionIds.length,
      unlinkedSessionIds: unlinkedSessionIds.slice(0, 50),
      staleWorkspaceSessionCount: staleWorkspaceSessionIds.length,
      staleWorkspaceSessionIds: staleWorkspaceSessionIds.slice(0, 50),
      truncated: unlinkedSessionIds.length > 50,
      staleWorkspaceSessionTruncated: staleWorkspaceSessionIds.length > 50,
    },
    hostCapabilities: inferHostCapabilities(target),
  };
}

async function dshRpc(target, method, timeoutMs) {
  const { host, port } = parseTarget(target);
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `dsh-hub-diagnose-${method}`,
    method,
    payload: {},
  });
  const result = await httpRequest({
    host,
    port,
    path: `/api/${method}`,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
    body,
    timeoutMs,
  });
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch { /* noop */ }
  return {
    status: result.status,
    contentType: result.headers['content-type'] ?? null,
    ok: parsed?.result?.ok === true,
    rpcType: parsed?.type ?? null,
    error: parsed?.error ?? null,
    items: Array.isArray(parsed?.result?.value?.items) ? parsed.result.value.items : null,
  };
}

function summarizeRpc(result) {
  return {
    status: result.status,
    contentType: result.contentType,
    ok: result.ok,
    rpcType: result.rpcType,
    itemCount: Array.isArray(result.items) ? result.items.length : null,
    error: result.error,
  };
}

function httpRequest({ host, port, path, method = 'GET', headers = {}, body = null, timeoutMs }) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, headers: {}, body: '' });
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: '' }));
    if (body) req.write(body);
    req.end();
  });
}

function wsProbe(target, path, { timeoutMs, expectMessage }) {
  const { host, port } = parseTarget(target);
  return new Promise((resolve) => {
    const result = { opened: false, messages: 0, firstBytes: 0, idle: false, error: null };
    const authority = host === '::1' ? `[::1]:${port}` : `${host}:${port}`;
    const ws = new WebSocket(`ws://${authority}${path}`);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      result.idle = result.opened && result.messages === 0;
      try { ws.close(); } catch { /* noop */ }
      resolve(result);
    };
    const timer = setTimeout(settle, timeoutMs);
    ws.on('open', () => { result.opened = true; });
    ws.on('message', (data) => {
      result.messages += 1;
      if (!result.firstBytes) result.firstBytes = Buffer.byteLength(data);
      if (expectMessage) {
        clearTimeout(timer);
        settle();
      }
    });
    ws.on('error', (err) => {
      result.error = err.message;
      clearTimeout(timer);
      settle();
    });
  });
}

function collectSessionIds(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items
    .map((item) => item?.sessionId ?? item?.id ?? item?.session_id)
    .filter((id) => typeof id === 'string' && id.length > 0))];
}

function collectWorkspaceSessionIds(items) {
  const ids = new Set();
  if (!Array.isArray(items)) return ids;
  for (const workspace of items) {
    const candidates = [
      workspace?.sessionIds,
      workspace?.session_ids,
      workspace?.sessions,
    ];
    for (const value of candidates) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        const id = typeof entry === 'string' ? entry : entry?.sessionId ?? entry?.id ?? entry?.session_id;
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    }
  }
  return ids;
}

function inferHostCapabilities(target) {
  const { host } = parseTarget(target);
  const platform = os.platform();
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  const autoPicker = loopback && ['darwin', 'win32'].includes(platform) ? 'native' : 'browse-or-unknown';
  return {
    platform,
    bindHost: host,
    inferredDirectoryPicker: autoPicker,
    remoteLimited: autoPicker === 'native',
    note: autoPicker === 'native'
      ? 'agent loopback on this platform is expected to trigger the DSH native directory picker on the instance machine'
      : 'directory picker mode cannot be proven from outside the DSH process; plugin/profile diagnostics should confirm it',
  };
}
