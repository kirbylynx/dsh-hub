import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';

import { HubServer } from '../src/server.js';
import { HttpSession, PendingWSSession, relayHttpErrorBody } from '../src/relay.js';
import { DEFAULT_LIMITS, MSG, PROTO_MINOR, REQUIRED_CAPABILITIES, STREAMS, encodeChunk, offeredLimits } from '../src/protocol.js';
import { makeInstallationId } from '../src/security.js';
import { securityOptions, tempDatabase } from './test-helpers.js';
import { ClientRelay } from '../../dsh-hub-client/src/relay.js';

async function startHub(t, overrides = {}) {
  const { dbPath } = tempDatabase(t);
  const server = new HubServer({
    ...securityOptions(),
    host: '127.0.0.1',
    port: 0,
    dbPath,
    baseDomain: 'localhost',
    inactiveMs: 60_000,
    devAuthUser: 'owner',
    ...overrides,
  });
  await new Promise((resolve) => {
    server.listen();
    server.http.once('listening', resolve);
  });
  t.after(() => server.close());
  const { port } = server.http.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/agent` };
}

class SlowResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.writableEnded = false;
    this.writableLength = 0;
    this.destroyed = false;
  }

  writeHead() {
    this.headersSent = true;
  }

  write(chunk) {
    this.writableLength += chunk.length;
    return false;
  }

  end() {
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

class CapturingResponse extends EventEmitter {
  constructor() {
    super();
    this.headersSent = false;
    this.writableEnded = false;
    this.statusCode = null;
    this.headers = null;
    this.body = '';
    this.destroyed = false;
  }

  writeHead(statusCode, headers = {}) {
    this.headersSent = true;
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.body += String(chunk);
    return true;
  }

  end(chunk = '') {
    if (chunk) this.body += String(chunk);
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
  }
}

function makeHttpSessionForResponseBackpressure() {
  const sent = [];
  const detached = [];
  const req = new EventEmitter();
  const res = new SlowResponse();
  const tunnel = {
    limits: DEFAULT_LIMITS,
    send: (frame) => sent.push(frame),
    sendData: async (frame) => sent.push(frame),
    releaseDataCredit: () => {},
    detachSession: (id) => detached.push(id),
  };
  const session = new HttpSession({ id: 'slow-response', tunnel, req, res });
  return { session, req, res, sent, detached };
}

async function joinInstance(baseUrl, { idempotencyPrefix = 'tunnel', installationId = makeInstallationId() } = {}) {
  const namespace = await api(`${baseUrl}/api/namespaces`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${idempotencyPrefix}-namespace`.padEnd(32, '0'),
    },
    body: JSON.stringify({ name: `team-${idempotencyPrefix}` }),
  });
  const join = await api(`${baseUrl}/api/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `${idempotencyPrefix}-register`.padEnd(32, '0'),
    },
    body: JSON.stringify({
      registryKey: namespace.registryKey,
      installationId,
      delivery: 'agent',
      hostname: 'tester',
      clientVersion: '0.1.0',
      dshVersion: '0.1.0',
    }),
  });
  return { namespace, join, installationId };
}

test('HTTP response backpressure 只注册一个 drain listener 并归还累积 credit', () => {
  const { session, res, sent } = makeHttpSessionForResponseBackpressure();
  const chunk = Buffer.alloc(1024, 'h');

  session.handleFrame(MSG.RESP, { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' } });
  for (let seq = 0; seq < 12; seq += 1) {
    session.handleFrame(MSG.RESP_DATA, { seq, data: encodeChunk(chunk) });
  }

  assert.equal(res.listenerCount('drain'), 1);
  assert.equal(session.metricsSnapshot().instanceToBrowserUncreditedBytes, chunk.length * 12);
  assert.equal(sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP).length, 0);

  res.emit('drain');

  assert.equal(res.listenerCount('drain'), 0);
  assert.equal(session.metricsSnapshot().instanceToBrowserUncreditedBytes, 0);
  assert.deepEqual(
    sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP),
    [{ type: MSG.CREDIT, id: 'slow-response', stream: STREAMS.RESP, bytes: chunk.length * 12 }],
  );
});

test('HTTP response end 会清理 drain listener 并归还待确认 credit', () => {
  const { session, res, sent, detached } = makeHttpSessionForResponseBackpressure();
  const chunk = Buffer.alloc(512, 'e');

  session.handleFrame(MSG.RESP, { status: 200, statusText: 'OK', headers: {} });
  session.handleFrame(MSG.RESP_DATA, { seq: 0, data: encodeChunk(chunk) });
  assert.equal(res.listenerCount('drain'), 1);

  session.handleFrame(MSG.RESP_END, { bytes: chunk.length });

  assert.equal(res.writableEnded, true);
  assert.equal(res.listenerCount('drain'), 0);
  assert.deepEqual(detached, ['slow-response']);
  assert.deepEqual(
    sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP),
    [{ type: MSG.CREDIT, id: 'slow-response', stream: STREAMS.RESP, bytes: chunk.length }],
  );
});

test('HTTP response cancel 清理 drain listener 且不追加 response credit', () => {
  const { session, res, sent, detached } = makeHttpSessionForResponseBackpressure();
  const chunk = Buffer.alloc(512, 'c');

  session.handleFrame(MSG.RESP, { status: 200, statusText: 'OK', headers: {} });
  session.handleFrame(MSG.RESP_DATA, { seq: 0, data: encodeChunk(chunk) });
  assert.equal(res.listenerCount('drain'), 1);

  session.cancel('CLIENT_GONE', 'browser request closed');
  res.emit('drain');

  assert.equal(res.destroyed, true);
  assert.equal(res.listenerCount('drain'), 0);
  assert.deepEqual(detached, ['slow-response']);
  assert.equal(sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP).length, 0);
  assert.deepEqual(
    sent.filter((frame) => frame.type === MSG.CANCEL),
    [{ type: MSG.CANCEL, id: 'slow-response', code: 'CLIENT_GONE', message: 'browser request closed' }],
  );
});

test('HTTP response close 会取消 relay session 并清理 pending drain', () => {
  const { session, res, sent, detached } = makeHttpSessionForResponseBackpressure();
  const chunk = Buffer.alloc(512, 'r');

  session.handleFrame(MSG.RESP, { status: 200, statusText: 'OK', headers: {} });
  session.handleFrame(MSG.RESP_DATA, { seq: 0, data: encodeChunk(chunk) });
  assert.equal(res.listenerCount('drain'), 1);

  res.emit('close');
  res.emit('drain');

  assert.equal(res.destroyed, true);
  assert.equal(res.listenerCount('drain'), 0);
  assert.deepEqual(detached, ['slow-response']);
  assert.equal(sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP).length, 0);
  assert.deepEqual(
    sent.filter((frame) => frame.type === MSG.CANCEL),
    [{ type: MSG.CANCEL, id: 'slow-response', code: 'CLIENT_GONE', message: 'browser response closed' }],
  );
});

test('HTTP response error 终止会清理 drain listener 且不追加 pending credit', () => {
  const { session, res, sent, detached } = makeHttpSessionForResponseBackpressure();
  const chunk = Buffer.alloc(512, 'x');

  session.handleFrame(MSG.RESP, { status: 200, statusText: 'OK', headers: {} });
  session.handleFrame(MSG.RESP_DATA, { seq: 0, data: encodeChunk(chunk) });
  assert.equal(res.listenerCount('drain'), 1);

  session.handleFrame(MSG.ERROR, { code: 'UPSTREAM_DOWN', message: 'local DSH closed' });
  res.emit('drain');

  assert.equal(res.destroyed, true);
  assert.equal(res.listenerCount('drain'), 0);
  assert.deepEqual(detached, ['slow-response']);
  assert.equal(sent.filter((frame) => frame.type === MSG.CREDIT && frame.stream === STREAMS.RESP).length, 0);
});

test('G1-4 history relay 错误响应分类且不回传上游原始 message', () => {
  const req = new EventEmitter();
  req.method = 'POST';
  req.url = '/api/session.history?sessionId=sess-secret';
  req.headers = {};
  const res = new CapturingResponse();
  const sent = [];
  const detached = [];
  const tunnel = {
    limits: DEFAULT_LIMITS,
    send: (frame) => sent.push(frame),
    sendData: async (frame) => sent.push(frame),
    releaseDataCredit: () => {},
    detachSession: (id) => detached.push(id),
  };
  const session = new HttpSession({ id: 'hist-1', tunnel, req, res });

  session.handleFrame(MSG.ERROR, {
    code: 'UPSTREAM_DOWN',
    message: 'local DSH failed at /Users/alice/project with dht_secret_token',
  });

  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.history, true);
  assert.equal(body.code, 'UPSTREAM_DOWN');
  assert.equal(body.category, 'instance_unavailable');
  assert.equal(body.retryable, true);
  assert.equal(body.requestId, 'hist-1');
  assert.equal(body.error, body.message);
  assert.match(body.message, /Local DSH is unreachable/);
  assert.equal(JSON.stringify(body).includes('/Users/alice'), false);
  assert.equal(JSON.stringify(body).includes('dht_secret_token'), false);
  assert.deepEqual(detached, ['hist-1']);
});

test('G1-4 history relay 错误分类覆盖取消、超时、超限、压缩和协议错误', () => {
  const req = { method: 'POST', url: '/api/subagent.history' };
  const cases = [
    ['CLIENT_GONE', 'browser closed at /Users/alice/project dht_secret', 'browser_cancelled', true],
    ['UPSTREAM_TIMEOUT', 'timeout at /Users/alice/project dht_secret', 'upstream_timeout', true],
    ['UPSTREAM_DOWN', 'connect ECONNREFUSED /Users/alice/project dht_secret', 'instance_unavailable', true],
    ['LIMIT_EXCEEDED', 'history request body too large /Users/alice/project dht_secret', 'history_request_too_large', false],
    ['LIMIT_EXCEEDED', 'history response remains too large after normalization /Users/alice/project dht_secret', 'history_response_too_large', false],
    ['HISTORY_UNSUPPORTED_ENCODING', 'gzip /Users/alice/project dht_secret', 'history_unsupported_encoding', false],
    ['PROTOCOL_ERROR', 'bad seq /Users/alice/project dht_secret', 'relay_protocol_error', true],
  ];
  for (const [code, message, category, retryable] of cases) {
    const body = relayHttpErrorBody({ req, requestId: 'req-1', msg: { code, message } });
    assert.equal(body.code, code);
    assert.equal(body.category, category);
    assert.equal(body.retryable, retryable);
    assert.equal(body.history, true);
    assert.equal(body.requestId, 'req-1');
    const text = JSON.stringify(body);
    assert.equal(text.includes('/Users/alice'), false);
    assert.equal(text.includes('dht_secret'), false);
  }

  const nonHistory = relayHttpErrorBody({
    req: { method: 'GET', url: '/' },
    requestId: 'plain-1',
    msg: { code: 'UPSTREAM_DOWN', message: 'plain error dht_secret' },
  });
  assert.deepEqual(nonHistory, { error: 'plain error [redacted-secret]', code: 'UPSTREAM_DOWN' });
});

async function connectTunnel(wsUrl, {
  token,
  instanceId,
  installationId,
  target = { host: '127.0.0.1', port: 3080 },
  offeredLimits = DEFAULT_LIMITS,
  capabilities = REQUIRED_CAPABILITIES,
} = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  const welcomePromise = waitForJsonMessage(ws);
  ws.send(JSON.stringify({
    type: MSG.HELLO,
    proto: 1,
    minor: PROTO_MINOR,
    capabilities,
    token,
    instanceId,
    installationId,
    delivery: 'agent',
    hostname: 'tester',
    clientVersion: '0.1.0',
    dshVersion: '0.1.0',
    target,
    offeredLimits,
  }));
  const welcome = await welcomePromise;
  assert.equal(welcome.type, MSG.WELCOME);
  ws.welcome = welcome;
  return ws;
}

async function startDiagnosticMockDsh(t, options = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/session.list') {
      if (options.hangSessionList) {
        req.resume();
        return;
      }
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const rpc = parseJson(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (options.errorSessionList) {
          res.end(JSON.stringify({
            type: 'server-response',
            rpcId: rpc.rpcId,
            error: {
              code: 'E_SECRET_PATH',
              type: 'LocalPathError',
              message: 'failed to read /very/secret/request-body.json',
              stack: 'Error: failed at /very/secret/stack.js:1',
            },
          }));
          return;
        }
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: rpc.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                { id: 'sess-linked-1' },
                { id: 'sess-linked-2' },
                { id: 'sess-orphan-1' },
              ],
            },
          },
        }));
      });
      return;
    }
    if (req.url === '/api/workspace.list') {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const rpc = parseJson(raw);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          type: 'server-response',
          rpcId: rpc.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                { id: 'ws-alpha', path: '/very/secret/workspace', sessionIds: ['sess-linked-1', 'sess-linked-2', 'sess-stale-1'] },
                { id: 'ws-empty', path: '/very/secret/empty', sessionIds: [] },
              ],
            },
          },
        }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('mock dsh');
  });
  const mux = new WebSocketServer({ noServer: true });
  mux.on('connection', (ws) => ws.send(JSON.stringify({ type: 'session/subscribed' })));
  const host = new WebSocketServer({ noServer: true });
  host.on('connection', () => {});
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/events.mux') {
      mux.handleUpgrade(req, socket, head, (ws) => mux.emit('connection', ws, req));
      return;
    }
    if (req.url === '/api/events.host') {
      host.handleUpgrade(req, socket, head, (ws) => host.emit('connection', ws, req));
      return;
    }
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    mux.close();
    host.close();
    server.close();
  });
  return { port: server.address().port };
}

async function startHoldingMockDsh(t) {
  let releaseResponse;
  const releasePromise = new Promise((resolve) => { releaseResponse = resolve; });
  const server = http.createServer(async (req, res) => {
    req.resume();
    await releasePromise;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    releaseResponse();
    server.close();
  });
  return { port: server.address().port, releaseResponse };
}

async function startHoldingWebSocketMockDsh(t) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/api/events.mux') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const ws of sockets) {
      try { ws.close(); } catch { /* noop */ }
    }
    wss.close();
    server.close();
  });
  return { port: server.address().port };
}

function parseJson(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

async function connectRejected(wsUrl, {
  token,
  instanceId,
  installationId,
  target = { host: '127.0.0.1', port: 3080 },
  includeTarget = true,
  minor = PROTO_MINOR,
  capabilities = REQUIRED_CAPABILITIES,
  offeredLimits = DEFAULT_LIMITS,
} = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  const messagePromise = waitForJsonMessage(ws);
  const closePromise = new Promise((resolve) => {
    ws.once('close', (code, reasonBuffer) => {
      resolve({ code, reason: reasonBuffer.toString() });
    });
  });
  const hello = {
    type: MSG.HELLO,
    proto: 1,
    minor,
    capabilities,
    token,
    instanceId,
    installationId,
    delivery: 'agent',
    hostname: 'tester',
    clientVersion: '0.1.0',
    dshVersion: '0.1.0',
    offeredLimits,
  };
  if (includeTarget) hello.target = target;
  ws.send(JSON.stringify(hello));
  return { message: await messagePromise, close: await closePromise };
}

async function api(url, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const method = String(options.method ?? 'GET').toUpperCase();
  if (needsPortalCsrf(url, method, headers)) {
    const portal = await api(new URL('/api/portal', url).toString());
    headers.origin = new URL(url).origin;
    headers['x-csrf-token'] = portal.csrfToken;
  }
  if (!['GET', 'HEAD'].includes(method) && !headers['idempotency-key'] && !headers['Idempotency-Key']) {
    headers['idempotency-key'] = 't'.repeat(32);
  }
  const response = await fetch(url, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} -> ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function needsPortalCsrf(url, method, headers) {
  if (method !== 'POST') return false;
  if (headers.authorization || headers.Authorization) return false;
  if (headers['x-csrf-token'] || headers['X-CSRF-Token']) return false;
  const pathname = new URL(url).pathname;
  return pathname === '/api/namespaces'
    || /^\/api\/namespaces\/[^/]+\/rotate$/.test(pathname)
    || /^\/api\/instances\/[^/]+\/revoke$/.test(pathname)
    || /^\/api\/instances\/[^/]+\/replacement-grants$/.test(pathname);
}

function waitForJsonMessage(ws) {
  return new Promise((resolve) => {
    ws.on('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()));
      } catch {
        resolve(null);
      }
    });
  });
}

async function waitForCondition(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('owner revoke 先发送 BYE 再关闭 tunnel', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'owner-revoke' });

  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  const byePromise = waitForJsonMessage(ws);
  const closePromise = new Promise((resolve) => {
    ws.once('close', (code, reasonBuffer) => {
      resolve({ code, reason: reasonBuffer.toString() });
    });
  });

  await api(`${baseUrl}/api/instances/${join.instanceId}/revoke`, {
    method: 'POST',
    headers: { 'idempotency-key': 'v'.repeat(32), 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'test owner revoke' }),
  });

  const bye = await byePromise;
  const close = await closePromise;
  assert.deepEqual(bye, { type: MSG.BYE, code: 'TOKEN_REVOKED', reason: 'token revoked' });
  assert.equal(close.code, 4401);
  assert.equal(close.reason, 'token revoked');
});

test('M3B metrics 统计活体 HTTP relay session', async (t) => {
  const mockDsh = await startHoldingMockDsh(t);
  const { server, baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-metrics-http' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '127.0.0.1', port: mockDsh.port },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const relay = new ClientRelay({ send: (obj) => ws.send(JSON.stringify(obj)) });
  relay.setTarget({ host: '127.0.0.1', port: mockDsh.port });
  relay.setLimits(ws.welcome.limits);
  ws.on('message', (data) => relay.handleFrame(parseJson(data.toString())));

  const base = new URL(baseUrl);
  const pendingReq = http.request({
    hostname: base.hostname,
    port: base.port,
    path: '/hold',
    headers: { host: `${join.instanceId}.localhost` },
  });
  const pendingDone = new Promise((resolve) => {
    pendingReq.on('response', (res) => {
      res.resume();
      res.on('end', resolve);
    });
  });
  pendingReq.on('error', () => {});
  pendingReq.end();
  t.after(() => {
    mockDsh.releaseResponse();
    pendingReq.destroy();
  });

  await waitForCondition(
    () => server.tunnels.get(join.instanceId)?.sessions.size === 1,
    'active HTTP relay session',
  );
  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_relay_sessions_active 1$/m);
  assert.match(metrics, /^dsh_hub_relay_sessions_by_type\{type="http"\} 1$/m);
  mockDsh.releaseResponse();
  await pendingDone;
  const afterResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(afterResponse.status, 200);
  const afterMetrics = await afterResponse.text();
  assert.doesNotMatch(afterMetrics, /^dsh_hub_relay_terminal_frames_total\{type="ws_error",code="OTHER"\}/m);
});

test('M3B metrics 统计 pending WebSocket relay session', async (t) => {
  const { server, baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-metrics-ws-pending' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  const base = new URL(baseUrl);
  const browserWs = new WebSocket(`ws://${base.host}/api/events.mux`, {
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
    },
  });
  browserWs.on('error', () => {});
  t.after(() => {
    try { browserWs.close(); } catch { /* noop */ }
  });

  await waitForCondition(
    () => [...(server.tunnels.get(join.instanceId)?.sessions.values() ?? [])]
      .some((session) => session?.constructor?.name === 'PendingWSSession'),
    'pending WebSocket relay session',
  );
  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_relay_sessions_active 1$/m);
  assert.match(metrics, /^dsh_hub_relay_sessions_by_type\{type="websocket_pending"\} 1$/m);
});

test('pending WebSocket 浏览器 open 前断开会立即清理并取消上游', () => {
  const sent = [];
  const detached = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.off = socket.removeListener.bind(socket);
  socket.destroy = () => { socket.destroyed = true; };
  const tunnel = {
    limits: { ...DEFAULT_LIMITS, wsOpenTimeoutMs: 1_000 },
    send: (frame) => {
      sent.push(frame);
      return true;
    },
    detachSession: (id) => detached.push(id),
  };
  let rejected = false;
  const session = new PendingWSSession({
    id: 'pending-close',
    tunnel,
    req: {
      url: '/api/events.mux?probe=1',
      headers: { host: 'inst-test.localhost' },
    },
    socket,
    head: Buffer.alloc(0),
    wss: { handleUpgrade: () => { throw new Error('should not upgrade'); } },
    rejectUpgrade: () => { rejected = true; },
    openTimeoutMs: 1_000,
  });

  session.start({}, []);
  socket.emit('end');

  assert.deepEqual(sent, [
    { type: MSG.WS_REQ, id: 'pending-close', path: '/api/events.mux?probe=1', headers: {}, protocols: [] },
    { type: MSG.CANCEL, id: 'pending-close', code: 'CLIENT_GONE', message: 'browser websocket closed before upstream open' },
  ]);
  assert.deepEqual(detached, ['pending-close']);
  assert.equal(rejected, false);
  assert.equal(socket.destroyed, true);
});

test('pending WebSocket 上游请求发送失败会立即拒绝', () => {
  const detached = [];
  const socket = new EventEmitter();
  socket.writable = true;
  socket.destroyed = false;
  socket.write = () => {};
  socket.destroy = () => {};
  socket.off = socket.removeListener.bind(socket);
  const tunnel = {
    limits: { ...DEFAULT_LIMITS, wsOpenTimeoutMs: 1_000 },
    send: () => false,
    detachSession: (id) => detached.push(id),
  };
  let rejectedStatus = null;
  const session = new PendingWSSession({
    id: 'send-failed',
    tunnel,
    req: {
      url: '/api/events.mux',
      headers: { host: 'inst-test.localhost' },
    },
    socket,
    head: Buffer.alloc(0),
    wss: { handleUpgrade: () => { throw new Error('should not upgrade'); } },
    rejectUpgrade: (_targetSocket, status) => { rejectedStatus = status; },
    openTimeoutMs: 1_000,
  });

  session.start({}, []);

  assert.equal(rejectedStatus, 502);
  assert.deepEqual(detached, ['send-failed']);
});

test('pending WebSocket 收到上游 open 前 WS_END 会立即拒绝而不是超时', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, {
    protocolLimits: { ...DEFAULT_LIMITS, wsOpenTimeoutMs: 2_000 },
  });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'ws-preopen-end' });
  const tunnel = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { tunnel.close(); } catch { /* noop */ }
  });

  const wsReqPromise = waitForJsonMessage(tunnel);
  const base = new URL(baseUrl);
  const browserWs = new WebSocket(`ws://${base.host}/api/events.mux`, {
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
    },
  });
  browserWs.on('error', () => {});
  t.after(() => {
    try { browserWs.close(); } catch { /* noop */ }
  });
  const rejectPromise = new Promise((resolve) => {
    browserWs.once('unexpected-response', (_req, res) => resolve(res.statusCode));
  });

  const wsReq = await wsReqPromise;
  assert.equal(wsReq.type, MSG.WS_REQ);
  tunnel.send(JSON.stringify({
    type: MSG.WS_END,
    id: wsReq.id,
    code: 1000,
    reason: 'closed before open',
  }));

  assert.equal(await rejectPromise, 502);
  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /^dsh_hub_ws_upgrade_rejections_total\{status="502"\} 1$/m);
  assert.doesNotMatch(metrics, /^dsh_hub_ws_upgrade_rejections_total\{status="504"\}/m);
});

test('pending WebSocket 收到上游 ERROR 会立即按上游错误拒绝', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, {
    protocolLimits: { ...DEFAULT_LIMITS, wsOpenTimeoutMs: 2_000 },
  });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'ws-preopen-error' });
  const tunnel = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { tunnel.close(); } catch { /* noop */ }
  });

  const wsReqPromise = waitForJsonMessage(tunnel);
  const base = new URL(baseUrl);
  const browserWs = new WebSocket(`ws://${base.host}/api/events.mux`, {
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
    },
  });
  browserWs.on('error', () => {});
  t.after(() => {
    try { browserWs.close(); } catch { /* noop */ }
  });
  const rejectPromise = new Promise((resolve) => {
    browserWs.once('unexpected-response', (_req, res) => resolve(res.statusCode));
  });

  const wsReq = await wsReqPromise;
  assert.equal(wsReq.type, MSG.WS_REQ);
  tunnel.send(JSON.stringify({
    type: MSG.ERROR,
    id: wsReq.id,
    code: 'UPSTREAM_DOWN',
    message: 'local DSH websocket closed before open',
  }));

  assert.equal(await rejectPromise, 502);
  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /^dsh_hub_ws_upgrade_rejections_total\{status="502"\} 1$/m);
  assert.match(metrics, /^dsh_hub_relay_terminal_frames_total\{type="error",code="UPSTREAM_DOWN"\} 1$/m);
  assert.doesNotMatch(metrics, /^dsh_hub_ws_upgrade_rejections_total\{status="504"\}/m);
});

test('M3B metrics 统计活体 WebSocket relay session', async (t) => {
  const mockDsh = await startHoldingWebSocketMockDsh(t);
  const { server, baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-metrics-ws-active' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '127.0.0.1', port: mockDsh.port },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const relay = new ClientRelay({ send: (obj) => ws.send(JSON.stringify(obj)) });
  relay.setTarget({ host: '127.0.0.1', port: mockDsh.port });
  relay.setLimits(ws.welcome.limits);
  ws.on('message', (data) => relay.handleFrame(parseJson(data.toString())));

  const base = new URL(baseUrl);
  const browserWs = new WebSocket(`ws://${base.host}/api/events.mux`, {
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
    },
  });
  browserWs.on('error', () => {});
  t.after(() => {
    try { browserWs.close(); } catch { /* noop */ }
  });
  await new Promise((resolve) => browserWs.once('open', resolve));

  await waitForCondition(
    () => [...(server.tunnels.get(join.instanceId)?.sessions.values() ?? [])]
      .some((session) => session?.constructor?.name === 'WSSession'),
    'active WebSocket relay session',
  );
  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_relay_sessions_active 1$/m);
  assert.match(metrics, /^dsh_hub_relay_sessions_by_type\{type="websocket"\} 1$/m);
});

test('M3B metrics 观测 HTTP request credit wait 和排队字节', async (t) => {
  const { server, baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-backpressure-http' });
  const limits = offeredLimits({
    maxTunnelMessageBytes: 2048,
    maxChunkDecodedBytes: 512,
    maxWsMessageBytes: 1024,
    initialStreamCreditBytes: 1024,
    maxUncreditedBytesPerTunnel: 2048,
    highWaterBytes: 1536,
    lowWaterBytes: 512,
  });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    offeredLimits: limits,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  const base = new URL(baseUrl);
  const body = Buffer.alloc(2048, 'a');
  const req = http.request({
    hostname: base.hostname,
    port: base.port,
    method: 'POST',
    path: '/api/slow-upload',
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
      'content-length': String(body.length),
    },
  });
  req.on('error', () => {});
  req.write(body);
  req.end();
  t.after(() => req.destroy());

  await waitForCondition(() => {
    const session = [...(server.tunnels.get(join.instanceId)?.sessions.values() ?? [])]
      .find((item) => item?.constructor?.name === 'HttpSession');
    return session?.metricsSnapshot?.().reqCreditWaiters === 1;
  }, 'HTTP request waiting for relay credit');

  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_relay_uncredited_bytes\{direction="browser_to_instance",statistic="sum"\} 1024$/m);
  assert.match(metrics, /^dsh_hub_relay_credit_waiters\{stream="req",statistic="sum"\} 1$/m);
  assert.match(metrics, /^dsh_hub_relay_credit_wait_bytes\{stream="req",statistic="sum"\} 512$/m);
  assert.match(metrics, /^dsh_hub_relay_queued_bytes\{direction="browser_to_instance",statistic="sum"\} [1-9]\d*$/m);
  assert.doesNotMatch(metrics, /inst-[a-z2-7]{26}|ns_[0-9a-f]{16}|\/api\/slow-upload|127\.0\.0\.1:\d+/i);
  req.destroy();
  server.tunnels.get(join.instanceId)?.closeSessions('test-cleanup');
});

test('M3B metrics 观测 WebSocket credit wait 和排队字节', async (t) => {
  const { server, baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-backpressure-ws' });
  const limits = offeredLimits({
    maxTunnelMessageBytes: 2048,
    maxChunkDecodedBytes: 512,
    maxWsMessageBytes: 1024,
    initialStreamCreditBytes: 1024,
    maxUncreditedBytesPerTunnel: 2048,
    highWaterBytes: 1536,
    lowWaterBytes: 512,
  });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    offeredLimits: limits,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  const wsReqPromise = waitForJsonMessage(ws);
  const base = new URL(baseUrl);
  const browserWs = new WebSocket(`ws://${base.host}/api/events.mux`, {
    headers: {
      host: `${join.instanceId}.localhost`,
      origin: `http://${join.instanceId}.localhost`,
    },
  });
  browserWs.on('error', () => {});
  t.after(() => {
    try { browserWs.close(); } catch { /* noop */ }
  });
  const wsReq = await wsReqPromise;
  assert.equal(wsReq.type, MSG.WS_REQ);
  ws.send(JSON.stringify({ type: MSG.WS_OPEN, id: wsReq.id, protocol: null }));
  await new Promise((resolve) => browserWs.once('open', resolve));

  browserWs.send(Buffer.alloc(1024, 'a'));
  browserWs.send(Buffer.alloc(1024, 'b'));
  await waitForCondition(() => {
    const session = [...(server.tunnels.get(join.instanceId)?.sessions.values() ?? [])]
      .find((item) => item?.constructor?.name === 'WSSession');
    return session?.metricsSnapshot?.().wsCreditWaiters === 1;
  }, 'WebSocket message waiting for relay credit');

  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_relay_uncredited_bytes\{direction="browser_to_instance",statistic="sum"\} 1024$/m);
  assert.match(metrics, /^dsh_hub_relay_credit_waiters\{stream="ws_c2i",statistic="sum"\} 1$/m);
  assert.match(metrics, /^dsh_hub_relay_credit_wait_bytes\{stream="ws_c2i",statistic="sum"\} 512$/m);
  assert.match(metrics, /^dsh_hub_relay_queued_bytes\{direction="browser_to_instance",statistic="sum"\} 1024$/m);
  assert.doesNotMatch(metrics, /inst-[a-z2-7]{26}|ns_[0-9a-f]{16}|\/api\/events\.mux|127\.0\.0\.1:\d+/i);
});

test('M3B metrics 统计 heartbeat age、DSH health 和 relay cancel', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-metrics-health' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  const pongPromise = waitForJsonMessage(ws);
  ws.send(JSON.stringify({ type: MSG.HEARTBEAT, seq: 1, sentAt: Date.now() - 250 }));
  const pong = await pongPromise;
  assert.equal(pong.type, MSG.PONG);
  assert.equal(pong.seq, 1);

  ws.send(JSON.stringify({ type: MSG.HEALTH, dshOnline: false }));
  ws.send(JSON.stringify({ type: MSG.CANCEL, id: 'missing-session', code: 'CLIENT_GONE', message: 'browser closed' }));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_heartbeat_sent_at_age_seconds_count 1$/m);
  assert.match(metrics, /^dsh_hub_heartbeat_sent_at_age_seconds_sum [0-9.]+$/m);
  assert.match(metrics, /^dsh_hub_tunnels_dsh_reachable\{state="offline"\} 1$/m);
  assert.match(metrics, /^dsh_hub_relay_terminal_frames_total\{type="cancel",code="CLIENT_GONE"\} 1$/m);
  assert.match(metrics, /^dsh_hub_sqlite_write_seconds_count\{operation="instance_connection_update"\} [1-9]\d*$/m);
});

test('M3B metrics 统计 DSH health stale 状态', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, { healthStaleAfterMs: 5 });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3b-metrics-stale' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });

  ws.send(JSON.stringify({ type: MSG.HEALTH, dshOnline: true }));
  await new Promise((resolve) => setTimeout(resolve, 20));

  const response = await fetch(`${baseUrl}/metrics`);
  assert.equal(response.status, 200);
  const metrics = await response.text();
  assert.match(metrics, /^dsh_hub_tunnels_dsh_reachable\{state="online"\} 0$/m);
  assert.match(metrics, /^dsh_hub_tunnels_dsh_reachable\{state="stale"\} 1$/m);
});

test('M3A diagnostics API 通过在线 tunnel 只读采集 DSH API/WS 摘要且不泄露 workspace 路径', async (t) => {
  const mockDsh = await startDiagnosticMockDsh(t);
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3a-diagnostics' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '127.0.0.1', port: mockDsh.port },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const relay = new ClientRelay({ send: (obj) => ws.send(JSON.stringify(obj)) });
  relay.setTarget({ host: '127.0.0.1', port: mockDsh.port });
  relay.setLimits(ws.welcome.limits);
  ws.on('message', (data) => {
    const msg = parseJson(data.toString());
    relay.handleFrame(msg);
  });

  const diagnostics = await api(`${baseUrl}/api/instances/${join.instanceId}/diagnostics?refresh=1`);
  assert.equal(diagnostics.instance.instanceId, join.instanceId);
  assert.equal(diagnostics.relay.connectionState, 'online');
  assert.equal(diagnostics.dshApi.sessionList.ok, true);
  assert.equal(diagnostics.dshApi.sessionList.itemCount, 3);
  assert.equal(diagnostics.dshApi.workspaceList.ok, true);
  assert.equal(diagnostics.dshApi.workspaceList.itemCount, 2);
  assert.equal(diagnostics.workspaceMapping.sessionCount, 3);
  assert.equal(diagnostics.workspaceMapping.workspaceCount, 2);
  assert.equal(diagnostics.workspaceMapping.linkedSessionCount, 2);
  assert.equal(diagnostics.workspaceMapping.unlinkedSessionCount, 1);
  assert.equal(diagnostics.workspaceMapping.staleWorkspaceSessionCount, 1);
  assert.equal(diagnostics.websocket.eventsMux.opened, true);
  assert.ok(diagnostics.websocket.eventsMux.messages >= 1);
  assert.equal(diagnostics.websocket.eventsHost.opened, true);
  assert.equal(diagnostics.websocket.eventsHost.idle, true);
  assert.equal(diagnostics.hostCapabilities.remoteLimited, true);
  assert.ok(diagnostics.recommendations.some((item) => item.code === 'UNLINKED_SESSIONS'));
  assert.ok(diagnostics.recommendations.some((item) => item.code === 'STALE_WORKSPACE_SESSION_IDS'));
  assert.equal(JSON.stringify(diagnostics).includes('/very/secret'), false);
});

test('M3A diagnostics API 脱敏 DSH RPC error，避免错误路径泄露本机路径', async (t) => {
  const mockDsh = await startDiagnosticMockDsh(t, { errorSessionList: true });
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3a-error-redact' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '127.0.0.1', port: mockDsh.port },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const relay = new ClientRelay({ send: (obj) => ws.send(JSON.stringify(obj)) });
  relay.setTarget({ host: '127.0.0.1', port: mockDsh.port });
  relay.setLimits(ws.welcome.limits);
  ws.on('message', (data) => relay.handleFrame(parseJson(data.toString())));

  const diagnostics = await api(`${baseUrl}/api/instances/${join.instanceId}/diagnostics?refresh=1`);
  assert.equal(diagnostics.dshApi.sessionList.ok, false);
  assert.deepEqual(diagnostics.dshApi.sessionList.error, {
    code: 'E_SECRET_PATH',
    type: 'LocalPathError',
    message: 'DSH RPC returned an error',
  });
  assert.equal(JSON.stringify(diagnostics).includes('/very/secret'), false);
  assert.ok(diagnostics.recommendations.some((item) => item.code === 'DSH_API_PROBE_FAILED'));
});

test('M3A diagnostics HTTP probe 超时时会取消实例侧本地请求', async (t) => {
  const mockDsh = await startDiagnosticMockDsh(t, { hangSessionList: true });
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'm3a-timeout-cancel' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '127.0.0.1', port: mockDsh.port },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  const relay = new ClientRelay({ send: (obj) => ws.send(JSON.stringify(obj)) });
  relay.setTarget({ host: '127.0.0.1', port: mockDsh.port });
  relay.setLimits(ws.welcome.limits);
  ws.on('message', (data) => relay.handleFrame(parseJson(data.toString())));

  const diagnostics = await api(`${baseUrl}/api/instances/${join.instanceId}/diagnostics?refresh=1`);
  assert.equal(diagnostics.dshApi.sessionList.transportError, 'diagnostic HTTP probe timeout');
  assert.equal(relay.httpSessions.size, 0);
  assert.ok(diagnostics.recommendations.some((item) => item.code === 'DSH_API_PROBE_FAILED'));
});

test('v1.1 tunnel welcome 返回协商后的协议版本和 limits', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, {
    protocolLimits: { ...DEFAULT_LIMITS, maxSessions: 4 },
  });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'welcome-limits' });
  const ws = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    offeredLimits: { ...DEFAULT_LIMITS, maxSessions: 2 },
  });
  t.after(() => {
    try { ws.close(); } catch { /* noop */ }
  });
  assert.equal(ws.welcome.proto, 1);
  assert.equal(ws.welcome.minor, PROTO_MINOR);
  assert.deepEqual(ws.welcome.requiredCapabilities, REQUIRED_CAPABILITIES);
  assert.equal(ws.welcome.limits.maxSessions, 2);
  assert.equal(ws.welcome.limits.maxChunkDecodedBytes, DEFAULT_LIMITS.maxChunkDecodedBytes);
});

test('v1.1 tunnel 拒绝低 minor、缺 capability 和非法 limits', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'bad-protocol' });

  const lowMinor = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    minor: 0,
  });
  assert.equal(lowMinor.message.code, 'BAD_MINOR');
  assert.equal(lowMinor.close.code, 4403);

  const missingCapability = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    capabilities: REQUIRED_CAPABILITIES.filter((capability) => capability !== 'credit-flow-v1'),
  });
  assert.equal(missingCapability.message.code, 'MISSING_CAPABILITY');

  const badLimits = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    offeredLimits: { ...DEFAULT_LIMITS, maxChunkDecodedBytes: 0 },
  });
  assert.equal(badLimits.message.code, 'BAD_LIMITS');

  const missingTarget = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    includeTarget: false,
  });
  assert.equal(missingTarget.message.code, 'BAD_TARGET');

  const stringTarget = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: '127.0.0.1:3080',
  });
  assert.equal(stringTarget.message.code, 'BAD_TARGET');

  const portOnlyTarget = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: '3080',
  });
  assert.equal(portOnlyTarget.message.code, 'BAD_TARGET');

  const metrics = await fetch(`${baseUrl}/metrics`);
  assert.equal(metrics.status, 200);
  const body = await metrics.text();
  assert.match(body, /^dsh_hub_tunnel_handshake_failures_total\{code="BAD_MINOR"\} 1$/m);
  assert.match(body, /^dsh_hub_tunnel_handshake_failures_total\{code="MISSING_CAPABILITY"\} 1$/m);
  assert.match(body, /^dsh_hub_tunnel_handshake_failures_total\{code="BAD_LIMITS"\} 1$/m);
  assert.match(body, /^dsh_hub_tunnel_handshake_failures_total\{code="BAD_TARGET"\} 3$/m);
});

test('token rotate 到 overlap 后关闭旧 token tunnel，新 token 可接管', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, { instanceTokenOverlapMs: 40 });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'rotate-overlap' });
  const oldWs = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { oldWs.close(); } catch { /* noop */ }
  });

  const rotateResponse = await fetch(`${baseUrl}/api/instances/${join.instanceId}/tokens/rotate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${join.instanceToken}`,
      'idempotency-key': 'rotate-overlap-idempotency-001',
    },
  });
  assert.equal(rotateResponse.status, 200);
  const rotated = await rotateResponse.json();

  const byePromise = waitForJsonMessage(oldWs);
  const closePromise = new Promise((resolve) => {
    oldWs.once('close', (code, reasonBuffer) => {
      resolve({ code, reason: reasonBuffer.toString() });
    });
  });
  const bye = await byePromise;
  const close = await closePromise;
  assert.deepEqual(bye, { type: MSG.BYE, code: 'TOKEN_ROTATED', reason: 'token rotated' });
  assert.equal(close.code, 4401);
  assert.equal(close.reason, 'token rotated');

  const newWs = await connectTunnel(wsUrl, {
    token: rotated.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { newWs.close(); } catch { /* noop */ }
  });
  newWs.close();
});

test('新 token 在 overlap 内接管时旧 tunnel 收到 TOKEN_ROTATED，旧 token 不能再踢掉新 tunnel', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, { instanceTokenOverlapMs: 500 });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'rotate-takeover' });
  const oldWs = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { oldWs.close(); } catch { /* noop */ }
  });

  const rotateResponse = await fetch(`${baseUrl}/api/instances/${join.instanceId}/tokens/rotate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${join.instanceToken}`,
      'idempotency-key': 'rotate-takeover-idempotency-01',
    },
  });
  assert.equal(rotateResponse.status, 200);
  const rotated = await rotateResponse.json();

  const oldByePromise = waitForJsonMessage(oldWs);
  const oldClosePromise = new Promise((resolve) => {
    oldWs.once('close', (code, reasonBuffer) => {
      resolve({ code, reason: reasonBuffer.toString() });
    });
  });
  const newWs = await connectTunnel(wsUrl, {
    token: rotated.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { newWs.close(); } catch { /* noop */ }
  });
  assert.deepEqual(await oldByePromise, { type: MSG.BYE, code: 'TOKEN_ROTATED', reason: 'token rotated' });
  assert.deepEqual(await oldClosePromise, { code: 4401, reason: 'token rotated' });

  const rejected = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  assert.equal(rejected.message.code, 'TOKEN_ROTATED');
  assert.equal(rejected.close.code, 4401);
  assert.equal(newWs.readyState, WebSocket.OPEN);
  newWs.close();
});

test('多跳 token 链路中最旧 token 不能踢掉最新 tunnel', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, { instanceTokenOverlapMs: 500 });
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'rotate-chain' });
  const oldWs = await connectTunnel(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { oldWs.close(); } catch { /* noop */ }
  });

  const firstRotate = await fetch(`${baseUrl}/api/instances/${join.instanceId}/tokens/rotate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${join.instanceToken}`,
      'idempotency-key': 'rotate-chain-idempotency-0001',
    },
  });
  assert.equal(firstRotate.status, 200);
  const middle = await firstRotate.json();
  const secondRotate = await fetch(`${baseUrl}/api/instances/${join.instanceId}/tokens/rotate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${middle.instanceToken}`,
      'idempotency-key': 'rotate-chain-idempotency-0002',
    },
  });
  assert.equal(secondRotate.status, 200);
  const latest = await secondRotate.json();

  const oldByePromise = waitForJsonMessage(oldWs);
  const latestWs = await connectTunnel(wsUrl, {
    token: latest.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  t.after(() => {
    try { latestWs.close(); } catch { /* noop */ }
  });
  assert.deepEqual(await oldByePromise, { type: MSG.BYE, code: 'TOKEN_ROTATED', reason: 'token rotated' });

  const rejected = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  assert.equal(rejected.message.code, 'TOKEN_ROTATED');
  assert.equal(latestWs.readyState, WebSocket.OPEN);
  latestWs.close();
});

test('grace 内过期 token 建 tunnel 返回 TOKEN_EXPIRED，overlap 后旧 token 返回 TOKEN_ROTATED', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t, {
    instanceTokenTtlMs: 100,
    instanceTokenRenewalGraceMs: 500,
    instanceTokenOverlapMs: 20,
  });
  const { join: expiredJoin, installationId: expiredInstallation } = await joinInstance(baseUrl, {
    idempotencyPrefix: 'expired-tunnel',
  });
  await new Promise((resolve) => setTimeout(resolve, 130));
  const expired = await connectRejected(wsUrl, {
    token: expiredJoin.instanceToken,
    instanceId: expiredJoin.instanceId,
    installationId: expiredInstallation,
  });
  assert.equal(expired.message.code, 'TOKEN_EXPIRED');

  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'rotated-tunnel' });
  const rotateResponse = await fetch(`${baseUrl}/api/instances/${join.instanceId}/tokens/rotate`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${join.instanceToken}`,
      'idempotency-key': 'rotated-tunnel-idempotency-01',
    },
  });
  assert.equal(rotateResponse.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 35));
  const rotated = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
  });
  assert.equal(rotated.message.code, 'TOKEN_ROTATED');
});

test('tunnel hello 拒绝非 loopback target', async (t) => {
  const { baseUrl, wsUrl } = await startHub(t);
  const { join, installationId } = await joinInstance(baseUrl, { idempotencyPrefix: 'target-boundary' });

  const rejected = await connectRejected(wsUrl, {
    token: join.instanceToken,
    instanceId: join.instanceId,
    installationId,
    target: { host: '192.168.1.10', port: 3080 },
  });
  assert.equal(rejected.message.type, MSG.ERROR);
  assert.equal(rejected.message.code, 'TARGET_NOT_ALLOWED');
  assert.equal(rejected.close.code, 4403);
});
