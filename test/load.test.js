import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';

import { HubServer } from '../packages/dsh-hub-service/src/server.js';
import { DEFAULT_LIMITS, MSG, PROTO_MINOR, REQUIRED_CAPABILITIES, STREAMS, encodeChunk } from '../packages/dsh-hub-service/src/protocol.js';
import { makeInstallationId } from '../packages/dsh-hub-service/src/security.js';
import { securityOptions, tempDatabase } from '../packages/dsh-hub-service/test/test-helpers.js';

test('M1B maxSessions 上限确定性拒绝新 relay session，避免无界排队', async (t) => {
  const { dbPath } = tempDatabase(t, 'dshhub-load-');
  const hub = new HubServer({
    ...securityOptions(),
    host: '127.0.0.1',
    port: 0,
    dbPath,
    baseDomain: 'localhost',
    inactiveMs: 60_000,
    devAuthUser: 'owner',
    protocolLimits: { ...DEFAULT_LIMITS, maxSessions: 1 },
  });
  hub.listen();
  await once(hub.http, 'listening');
  t.after(() => hub.close());
  const port = hub.http.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const installationId = makeInstallationId();
  const ns = await api(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'idempotency-key': 'load-namespace-key-0000000001' },
    body: { name: 'load' },
  });
  const joined = await api(baseUrl, '/api/register', {
    method: 'POST',
    headers: { 'idempotency-key': 'load-register-key-0000000001' },
    body: {
      registryKey: ns.registryKey,
      installationId,
      delivery: 'agent',
      hostname: 'load',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });

  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/agent`);
  await once(ws, 'open');
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  ws.send(JSON.stringify({
    type: MSG.HELLO,
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    token: joined.instanceToken,
    instanceId: joined.instanceId,
    installationId,
    delivery: 'agent',
    hostname: 'load',
    clientVersion: '0.1.0',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: DEFAULT_LIMITS,
  }));
  const [welcomeRaw] = await once(ws, 'message');
  assert.equal(JSON.parse(welcomeRaw.toString()).type, MSG.WELCOME);

  const host = `${joined.instanceId}.localhost:${port}`;
  const first = holdHttpRequest(baseUrl, '/', host);
  const [relayRaw] = await once(ws, 'message');
  assert.equal(JSON.parse(relayRaw.toString()).type, MSG.REQ);

  const second = await rawHttpRequest(baseUrl, '/', { host });
  assert.equal(second.status, 503);
  assert.equal(second.body.error.code, 'LIMIT_EXCEEDED');
  first.destroy();
});

test('M3B-3D 本地背压容量基线覆盖慢 credit 下的有界 HTTP 上传', { timeout: 15_000 }, async (t) => {
  const iterations = positiveEnvInt('DSH_HUB_LOAD_ITERATIONS', 8);
  const concurrency = positiveEnvInt('DSH_HUB_LOAD_CONCURRENCY', 4);
  const bodyBytes = positiveEnvInt('DSH_HUB_LOAD_BODY_BYTES', 8192);
  const creditDelayMs = positiveEnvInt('DSH_HUB_LOAD_CREDIT_DELAY_MS', 20);
  const maxRssDeltaBytes = positiveEnvInt('DSH_HUB_LOAD_MAX_RSS_DELTA_MB', 96) * 1024 * 1024;
  const maxHeapDeltaBytes = positiveEnvInt('DSH_HUB_LOAD_MAX_HEAP_DELTA_MB', 64) * 1024 * 1024;
  const chunkBytes = 1024;
  const limits = {
    ...DEFAULT_LIMITS,
    maxChunkDecodedBytes: chunkBytes,
    maxHttpBodyBytes: Math.max(bodyBytes * 2, chunkBytes * 8),
    maxWsMessageBytes: chunkBytes,
    maxSessions: Math.max(concurrency + 1, 8),
    initialStreamCreditBytes: chunkBytes,
    maxUncreditedBytesPerTunnel: chunkBytes * 2,
    highWaterBytes: chunkBytes * 2,
    lowWaterBytes: chunkBytes,
    backpressureTimeoutMs: 2_000,
  };
  const { dbPath } = tempDatabase(t, 'dshhub-load-backpressure-');
  const hub = new HubServer({
    ...securityOptions(),
    host: '127.0.0.1',
    port: 0,
    dbPath,
    baseDomain: 'localhost',
    inactiveMs: 60_000,
    devAuthUser: 'owner',
    protocolLimits: limits,
  });
  hub.listen();
  await once(hub.http, 'listening');
  t.after(() => hub.close());
  const port = hub.http.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const installationId = makeInstallationId();
  const ns = await api(baseUrl, '/api/namespaces', {
    method: 'POST',
    headers: { 'idempotency-key': 'load-bp-namespace-key-000001' },
    body: { name: 'load-backpressure' },
  });
  const joined = await api(baseUrl, '/api/register', {
    method: 'POST',
    headers: { 'idempotency-key': 'load-bp-register-key-000001' },
    body: {
      registryKey: ns.registryKey,
      installationId,
      delivery: 'agent',
      hostname: 'load-backpressure',
      clientVersion: '0.1.0',
      dshVersion: null,
    },
  });

  const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/agent`);
  await once(ws, 'open');
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const tunnelStats = startBackpressureAgent(ws, { creditDelayMs });
  ws.send(JSON.stringify({
    type: MSG.HELLO,
    proto: 1,
    minor: PROTO_MINOR,
    capabilities: REQUIRED_CAPABILITIES,
    token: joined.instanceToken,
    instanceId: joined.instanceId,
    installationId,
    delivery: 'agent',
    hostname: 'load-backpressure',
    clientVersion: '0.1.0',
    target: { host: '127.0.0.1', port: 3080 },
    offeredLimits: limits,
  }));
  const [welcomeRaw] = await once(ws, 'message');
  assert.equal(JSON.parse(welcomeRaw.toString()).type, MSG.WELCOME);

  const samples = [];
  let sampling = true;
  const sampler = sampleMetricsUntilStopped(baseUrl, samples, () => sampling);
  const host = `${joined.instanceId}.localhost:${port}`;
  const origin = `http://${joined.instanceId}.localhost`;
  const payload = Buffer.alloc(bodyBytes, 0x61);
  try {
    let next = 0;
    const workers = Array.from({ length: concurrency }, async () => {
      while (next < iterations) {
        const index = next;
        next += 1;
        const response = await rawHttpRequest(baseUrl, `/api/load-${index}`, {
          host,
          method: 'POST',
          body: payload,
          headers: { 'content-type': 'application/octet-stream', origin },
        });
        assert.equal(response.status, 200);
        assert.equal(response.bodyText, 'ok');
      }
    });
    await Promise.all(workers);
  } finally {
    sampling = false;
    await sampler;
  }

  assert.equal(tunnelStats.completedRequests, iterations);
  assert.equal(tunnelStats.receivedBytes, iterations * bodyBytes);
  assert.ok(tunnelStats.reqDataFrames >= iterations * Math.ceil(bodyBytes / chunkBytes));
  assert.ok(samples.length > 0);

  const maxCreditWaiters = Math.max(...samples.map((sample) => sample.reqCreditWaiters));
  const maxUncreditedBytes = Math.max(...samples.map((sample) => sample.browserToInstanceUncredited));
  const minRss = Math.min(...samples.map((sample) => sample.rss));
  const maxRss = Math.max(...samples.map((sample) => sample.rss));
  const minHeap = Math.min(...samples.map((sample) => sample.heap));
  const maxHeap = Math.max(...samples.map((sample) => sample.heap));
  const maxEventLoopDelay = Math.max(...samples.map((sample) => sample.eventLoopDelayMax));

  assert.ok(maxCreditWaiters >= 1, `expected credit waiters in metrics; samples=${JSON.stringify(samples.slice(-5))}`);
  assert.ok(maxUncreditedBytes >= chunkBytes, `expected uncredited bytes in metrics; samples=${JSON.stringify(samples.slice(-5))}`);
  assert.ok(Number.isFinite(maxEventLoopDelay), `expected finite event loop delay metric; samples=${JSON.stringify(samples.slice(-5))}`);
  assert.ok(maxRss - minRss <= maxRssDeltaBytes, `rss delta ${maxRss - minRss} exceeded ${maxRssDeltaBytes}`);
  assert.ok(maxHeap - minHeap <= maxHeapDeltaBytes, `heap delta ${maxHeap - minHeap} exceeded ${maxHeapDeltaBytes}`);
});

async function api(baseUrl, pathname, { method, headers = {}, body }) {
  const finalHeaders = { ...headers, 'content-type': 'application/json' };
  if (pathname === '/api/namespaces') {
    const portal = await fetch(`${baseUrl}/api/portal`).then((r) => r.json());
    finalHeaders.origin = baseUrl;
    finalHeaders['x-csrf-token'] = portal.csrfToken;
  }
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: finalHeaders,
    body: JSON.stringify(body),
  });
  const parsed = await res.json();
  assert.ok(res.ok, `${pathname} failed: ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}

function holdHttpRequest(baseUrl, path, host) {
  const base = new URL(baseUrl);
  const req = http.request({
    hostname: base.hostname,
    port: base.port,
    path,
    method: 'GET',
    headers: { host },
  }, (res) => {
    res.on('data', () => {});
  });
  req.end();
  req.on('error', () => {});
  return req;
}

function rawHttpRequest(baseUrl, path, { host, method = 'GET', body = null, headers = {} }) {
  const base = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      path,
      method,
      headers: {
        host,
        ...headers,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = tryParseJson(raw);
        resolve({ status: res.statusCode, body: parsed, bodyText: raw });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function startBackpressureAgent(ws, { creditDelayMs }) {
  const stats = {
    receivedBytes: 0,
    reqDataFrames: 0,
    completedRequests: 0,
  };
  const sessions = new Map();
  ws.on('message', (data) => {
    const msg = tryParseJson(data.toString());
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === MSG.REQ) {
      sessions.set(msg.id, { bytes: 0 });
      return;
    }
    if (msg.type === MSG.REQ_DATA) {
      const decodedBytes = Buffer.from(String(msg.data ?? ''), 'base64').length;
      const session = sessions.get(msg.id);
      if (session) session.bytes += decodedBytes;
      stats.receivedBytes += decodedBytes;
      stats.reqDataFrames += 1;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: MSG.CREDIT, id: msg.id, stream: STREAMS.REQ, bytes: decodedBytes }));
        }
      }, creditDelayMs).unref?.();
      return;
    }
    if (msg.type === MSG.REQ_END) {
      const body = Buffer.from('ok');
      ws.send(JSON.stringify({ type: MSG.RESP, id: msg.id, status: 200, headers: { 'content-type': ['text/plain'] } }));
      ws.send(JSON.stringify({ type: MSG.RESP_DATA, id: msg.id, seq: 0, data: encodeChunk(body) }));
      ws.send(JSON.stringify({ type: MSG.RESP_END, id: msg.id, bytes: body.length }));
      sessions.delete(msg.id);
      stats.completedRequests += 1;
    }
  });
  return stats;
}

async function sampleMetricsUntilStopped(baseUrl, samples, isSampling) {
  while (isSampling()) {
    const text = await fetch(`${baseUrl}/metrics`).then((response) => response.text()).catch(() => '');
    if (text) {
      samples.push({
        reqCreditWaiters: metricValue(text, 'dsh_hub_relay_credit_waiters', { stream: 'req', statistic: 'sum' }),
        browserToInstanceUncredited: metricValue(text, 'dsh_hub_relay_uncredited_bytes', { direction: 'browser_to_instance', statistic: 'sum' }),
        rss: metricValue(text, 'dsh_hub_process_resident_memory_bytes'),
        heap: metricValue(text, 'dsh_hub_process_heap_used_bytes'),
        eventLoopDelayMax: metricValue(text, 'dsh_hub_event_loop_delay_seconds', { statistic: 'max' }, Number.NaN),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function metricValue(text, metricName, labels = {}, missingValue = 0) {
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [series, rawValue] = line.trim().split(/\s+/, 2);
    const match = series.match(/^([^{]+)(?:\{(.+)\})?$/);
    if (!match || match[1] !== metricName) continue;
    const parsedLabels = parseMetricLabels(match[2] ?? '');
    if (Object.entries(labels).every(([key, value]) => parsedLabels[key] === value)) {
      const n = Number(rawValue);
      return Number.isFinite(n) ? n : missingValue;
    }
  }
  return missingValue;
}

function parseMetricLabels(raw) {
  const labels = {};
  for (const part of raw.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"/g)) {
    labels[part[1]] = part[2];
  }
  return labels;
}

function positiveEnvInt(name, fallback) {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tryParseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
