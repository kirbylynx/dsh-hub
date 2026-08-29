import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { createSyntheticHistoryResponse } from '../src/history-normalizer.js';
import { DEFAULT_LIMITS, MSG, PROTO_MINOR, PROTO_VERSION, REQUIRED_CAPABILITIES, STREAMS, decodeChunk, encodeChunk } from '../src/protocol.js';
import { ClientRelay, historyNormalizerOptionsFromEnv } from '../src/relay.js';
import { OutboundFrameSender, runTunnel } from '../src/tunnel.js';

class FakeWs {
  constructor() {
    this.readyState = 1;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload, callback) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(JSON.parse(payload));
    queueMicrotask(() => callback?.());
  }
}

async function startWsHarness(t, onConnection) {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    wss.close();
    server.close();
  });
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function baseConfig(endpoint) {
  return {
    endpoint,
    heartbeatMs: 60_000,
    healthMs: 60_000,
    dshVersion: null,
  };
}

function baseCreds() {
  return {
    instanceId: 'inst-test',
    installationId: 'insl_abcdefghijklmnopQRSTUV',
    instanceToken: 'dht_test',
    target: '127.0.0.1:3080',
    hostname: 'tester',
    clientVersion: '0.1.0',
  };
}

function welcomeFrame() {
  return {
    type: MSG.WELCOME,
    proto: PROTO_VERSION,
    minor: PROTO_MINOR,
    instanceId: 'inst-test',
    serverVersion: '0.0.1',
    requiredCapabilities: REQUIRED_CAPABILITIES,
    heartbeatIntervalMs: 60_000,
    pongTimeoutMs: 120_000,
    inactiveTimeoutMs: 180_000,
    limits: DEFAULT_LIMITS,
  };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function jsonBody(value) {
  return Buffer.from(JSON.stringify(value));
}

function responseBody(sent, id) {
  return Buffer.concat(
    sent
      .filter((msg) => msg.type === MSG.RESP_DATA && msg.id === id)
      .map((msg) => decodeChunk(msg.data, DEFAULT_LIMITS)),
  );
}

async function waitForCondition(predicate, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('M3B-3B client/plugin outbound sender 执行 tunnel 级总账且不阻塞控制帧', async () => {
  const ws = new FakeWs();
  const sender = new OutboundFrameSender({
    ws,
    limits: {
      ...DEFAULT_LIMITS,
      maxUncreditedBytesPerTunnel: 1024,
      highWaterBytes: 2048,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 1000,
    },
  });

  await sender.send(
    { type: MSG.RESP_DATA, id: '1', seq: 0, data: '' },
    { stream: STREAMS.RESP, decodedBytes: 1024 },
  );
  let secondSent = false;
  const second = sender.send(
    { type: MSG.RESP_DATA, id: '2', seq: 0, data: '' },
    { stream: STREAMS.RESP, decodedBytes: 512 },
  ).then(() => {
    secondSent = true;
  });
  await nextTick();

  assert.equal(secondSent, false);
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.RESP_DATA]);

  await sender.send({ type: MSG.ERROR, id: '2', code: 'TEST', message: 'control frame' });
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.RESP_DATA, MSG.ERROR]);

  sender.releaseDataCredit('1', STREAMS.RESP, 1024);
  await second;

  assert.equal(secondSent, true);
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.RESP_DATA, MSG.ERROR, MSG.RESP_DATA]);
});

test('M3B-3B client/plugin outbound sender 高水位持续超时会拒绝数据帧', async () => {
  const ws = new FakeWs();
  ws.bufferedAmount = 2048;
  const sender = new OutboundFrameSender({
    ws,
    limits: {
      ...DEFAULT_LIMITS,
      maxUncreditedBytesPerTunnel: 4096,
      highWaterBytes: 1024,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 10,
    },
  });

  await assert.rejects(
    sender.send(
      { type: MSG.WS_DATA, id: '1', messageId: 0, seq: 0, final: true, binary: false, data: '' },
      { stream: STREAMS.WS_I2C, decodedBytes: 512 },
    ),
    { code: 'LIMIT_EXCEEDED' },
  );
  assert.equal(ws.sent.length, 0);
});

test('M3B-3B client/plugin outbound sender 数据帧发送失败会回滚未确认总账', async () => {
  const ws = new FakeWs();
  ws.failSend = true;
  const sender = new OutboundFrameSender({
    ws,
    limits: {
      ...DEFAULT_LIMITS,
      maxUncreditedBytesPerTunnel: 1024,
      highWaterBytes: 2048,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 1000,
    },
  });

  await assert.rejects(
    sender.send(
      { type: MSG.RESP_DATA, id: '1', seq: 0, data: '' },
      { stream: STREAMS.RESP, decodedBytes: 512 },
    ),
    /tunnel send failed/,
  );

  assert.equal(ws.sent.length, 0);
  assert.equal(sender.outboundUncreditedBytes, 0);
});

test('M3B-3C client/plugin outbound sender 高水位下降后通过轮询恢复数据帧发送', async () => {
  const ws = new FakeWs();
  ws.bufferedAmount = 2048;
  const sender = new OutboundFrameSender({
    ws,
    limits: {
      ...DEFAULT_LIMITS,
      maxUncreditedBytesPerTunnel: 4096,
      highWaterBytes: 1024,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 1000,
    },
  });

  let sent = false;
  const pending = sender.send(
    { type: MSG.WS_DATA, id: '1', messageId: 0, seq: 0, final: true, binary: false, data: '' },
    { stream: STREAMS.WS_I2C, decodedBytes: 512 },
  ).then(() => {
    sent = true;
  });
  await nextTick();
  assert.equal(sent, false);

  ws.bufferedAmount = 0;
  await pending;

  assert.equal(sent, true);
  assert.equal(ws.sent.length, 1);
});

test('M3B-3C client/plugin outbound sender 公平调度允许可发送小 session 绕过暂时放不下的大 session', async () => {
  const ws = new FakeWs();
  const sender = new OutboundFrameSender({
    ws,
    limits: {
      ...DEFAULT_LIMITS,
      maxUncreditedBytesPerTunnel: 1024,
      highWaterBytes: 2048,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 1000,
    },
  });

  await sender.send(
    { type: MSG.RESP_DATA, id: 'seed', seq: 0, data: '' },
    { stream: STREAMS.RESP, decodedBytes: 768 },
  );

  let bigSent = false;
  const big = sender.send(
    { type: MSG.RESP_DATA, id: 'big', seq: 0, data: '' },
    { stream: STREAMS.RESP, decodedBytes: 768 },
  ).then(() => {
    bigSent = true;
  });
  let smallSent = false;
  const small = sender.send(
    { type: MSG.RESP_DATA, id: 'small', seq: 0, data: '' },
    { stream: STREAMS.RESP, decodedBytes: 256 },
  ).then(() => {
    smallSent = true;
  });
  await nextTick();

  assert.equal(bigSent, false);
  assert.equal(smallSent, true);
  assert.deepEqual(ws.sent.map((frame) => frame.id), ['seed', 'small']);
  await small;

  sender.releaseDataCredit('seed', STREAMS.RESP, 768);
  await big;

  assert.equal(bigSent, true);
  assert.deepEqual(ws.sent.map((frame) => frame.id), ['seed', 'small', 'big']);
});

test('握手阶段仅收到 4403 close 也停止重试', async (t) => {
  let handshakes = 0;
  const endpoint = await startWsHarness(t, (ws) => {
    ws.once('message', () => {
      handshakes++;
      ws.close(4403, 'bad protocol version');
    });
  });

  const statuses = [];
  await runTunnel(baseConfig(endpoint), baseCreds(), {
    onStatus: (level, message) => statuses.push({ level, message }),
  });

  assert.equal(handshakes, 1);
  assert.equal(statuses.filter((item) => item.level === 'stopped').length, 1);
  assert.match(statuses.at(-1).message, /bad protocol version/);
});

test('已连接阶段仅收到 4401 close 也进入终止态', async (t) => {
  let connections = 0;
  const endpoint = await startWsHarness(t, (ws) => {
    ws.once('message', () => {
      connections++;
      ws.send(JSON.stringify(welcomeFrame()));
      setImmediate(() => ws.close(4401, 'token revoked'));
    });
  });

  const statuses = [];
  await runTunnel(baseConfig(endpoint), baseCreds(), {
    onStatus: (level, message) => statuses.push({ level, message }),
  });

  assert.equal(connections, 1);
  assert.equal(statuses.some((item) => item.level === 'connected'), true);
  assert.equal(statuses.filter((item) => item.level === 'stopped').length, 1);
  assert.match(statuses.at(-1).message, /token revoked/);
});

test('client relay 拒绝与 bodyLength 不一致的 reqEnd', async (t) => {
  const local = http.createServer((_req, res) => {
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const relay = new ClientRelay({ send: (msg) => sent.push(msg) });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  relay.handleFrame({
    type: MSG.REQ,
    id: 'length-mismatch',
    method: 'POST',
    path: '/echo',
    headers: {},
    bodyLength: 4,
  });
  relay.handleFrame({
    type: MSG.REQ_END,
    id: 'length-mismatch',
    seq: 0,
    bytes: 0,
  });

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR), {
    type: MSG.ERROR,
    id: 'length-mismatch',
    code: 'PROTOCOL_ERROR',
    message: 'request length mismatch',
  });
});

test('G1-2 client relay 对 DSH history 请求下压 maxMessages 并瘦身响应', async (t) => {
  let captured = null;
  let capturedContentLength = null;
  let capturedAcceptEncoding = null;
  const upstream = createSyntheticHistoryResponse({ messageCount: 2, chunksPerMessage: 8, chunkBytes: 64 });
  const local = http.createServer((req, res) => {
    const parts = [];
    capturedContentLength = req.headers['content-length'];
    capturedAcceptEncoding = req.headers['accept-encoding'];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(parts).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const historyEvents = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    onHistoryEvent: (event) => historyEvents.push(event),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1', maxMessages: 500 },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-normalized',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-normalized', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-normalized', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.RESP_END && msg.id === 'history-normalized'),
    'normalized history response',
  );

  const normalizedRequestBody = jsonBody(captured);
  assert.equal(captured.payload.maxMessages, 20);
  assert.equal(Number(capturedContentLength), normalizedRequestBody.length);
  assert.equal(sent.some((msg) => msg.type === MSG.ERROR), false);
  const response = JSON.parse(responseBody(sent, 'history-normalized').toString('utf8'));
  const respHead = sent.find((msg) => msg.type === MSG.RESP && msg.id === 'history-normalized');
  const normalizedResponseBody = responseBody(sent, 'history-normalized');
  const originalChunkCount = upstream.result.value.events.filter((entry) => entry.event.type === 'assistant/chunk').length;
  const normalizedChunkCount = response.result.value.events.filter((entry) => entry.event.type === 'assistant/chunk').length;
  assert.equal(normalizedChunkCount, 2);
  assert.ok(normalizedChunkCount < originalChunkCount);
  assert.equal(response.result.value.hasMore, upstream.result.value.hasMore);
  assert.deepEqual(response.result.value.projections, upstream.result.value.projections);
  assert.equal(Number(respHead.headers['content-length']), normalizedResponseBody.length);
  assert.equal(capturedAcceptEncoding, 'identity');
  assert.equal(historyEvents.length, 1);
  assert.equal(historyEvents[0].requestId, 'history-normalized');
  assert.equal(historyEvents[0].method, 'session.history');
  assert.equal(historyEvents[0].path, '/api/session.history');
  assert.equal(historyEvents[0].terminalState, 'ok');
  assert.equal(historyEvents[0].status, 200);
  assert.equal(historyEvents[0].normalized, true);
  assert.equal(historyEvents[0].rawResponseBytes > historyEvents[0].normalizedBytes, true);
  assert.equal(historyEvents[0].errorCode, null);
  assert.deepEqual(released, ['history-normalized']);
});

test('G1-2 client relay 对 subagent.history 同样下压请求并瘦身 identity 响应', async (t) => {
  let captured = null;
  let capturedContentLength = null;
  let capturedAcceptEncoding = null;
  const upstream = createSyntheticHistoryResponse({ messageCount: 1, chunksPerMessage: 6, chunkBytes: 48 });
  const local = http.createServer((req, res) => {
    const parts = [];
    capturedContentLength = req.headers['content-length'];
    capturedAcceptEncoding = req.headers['accept-encoding'];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(parts).toString('utf8'));
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'identity',
      });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const relay = new ClientRelay({ send: (msg) => sent.push(msg) });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'subagent.history',
    payload: { sessionId: 'sess-1', subagentId: 'sub-1', maxMessages: 500 },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'subagent-history-normalized',
    method: 'POST',
    path: '/api/subagent.history',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'subagent-history-normalized', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'subagent-history-normalized', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.RESP_END && msg.id === 'subagent-history-normalized'),
    'normalized subagent history response',
  );

  const normalizedRequestBody = jsonBody(captured);
  assert.equal(captured.payload.maxMessages, 20);
  assert.equal(Number(capturedContentLength), normalizedRequestBody.length);
  assert.equal(capturedAcceptEncoding, 'identity');
  const response = JSON.parse(responseBody(sent, 'subagent-history-normalized').toString('utf8'));
  const normalizedChunkCount = response.result.value.events.filter((entry) => entry.event.type === 'assistant/chunk').length;
  assert.equal(normalizedChunkCount, 1);
  const respHead = sent.find((msg) => msg.type === MSG.RESP && msg.id === 'subagent-history-normalized');
  assert.equal(Number(respHead.headers['content-length']), responseBody(sent, 'subagent-history-normalized').length);
});

test('G1-4 client relay 对非 identity history 响应返回明确错误并记录脱敏诊断', async (t) => {
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      res.end(Buffer.from('not-really-gzip-but-not-forwarded'));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const historyEvents = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    onHistoryEvent: (event) => historyEvents.push(event),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-gzip',
    method: 'POST',
    path: '/api/session.history?ignored=1',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-gzip', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-gzip', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-gzip'),
    'history unsupported encoding error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-gzip'), {
    type: MSG.ERROR,
    id: 'history-gzip',
    code: 'HISTORY_UNSUPPORTED_ENCODING',
    message: 'history response uses unsupported content-encoding',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP), false);
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA), false);
  assert.deepEqual(released, ['history-gzip']);
  assert.equal(historyEvents.length, 1);
  assert.deepEqual(historyEvents[0], {
    requestId: 'history-gzip',
    method: 'session.history',
    path: '/api/session.history',
    status: 200,
    requestBytes: body.length,
    rawResponseBytes: 0,
    normalizedBytes: 0,
    elapsedMs: historyEvents[0].elapsedMs,
    errorCode: 'HISTORY_UNSUPPORTED_ENCODING',
    terminalState: 'error',
    contentEncoding: 'gzip',
    normalized: false,
  });
});

test('G1-2 client relay 对超出 history 请求缓冲上限的已知 bodyLength 直接拒绝且不打开本地请求', async (t) => {
  let requestCount = 0;
  const local = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const body = Buffer.alloc(1_048_577, 120);
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-request-known-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    bodyLength: body.length,
  });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-request-known-too-large'),
    'history request known-size rejection',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-request-known-too-large'), {
    type: MSG.ERROR,
    id: 'history-request-known-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history request body too large',
  });
  assert.equal(requestCount, 0);
  assert.deepEqual(released, ['history-request-known-too-large']);
});

test('G1-2 client relay 对超出 history 请求缓冲上限的累计 REQ_DATA 拒绝且不打开本地请求', async (t) => {
  let requestCount = 0;
  const local = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-request-stream-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 0,
    data: encodeChunk(Buffer.alloc(200_000, 120)),
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 1,
    data: encodeChunk(Buffer.alloc(200_000, 121)),
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 2,
    data: encodeChunk(Buffer.alloc(200_000, 122)),
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 3,
    data: encodeChunk(Buffer.alloc(200_000, 123)),
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 4,
    data: encodeChunk(Buffer.alloc(200_000, 124)),
  });
  relay.handleFrame({
    type: MSG.REQ_DATA,
    id: 'history-request-stream-too-large',
    seq: 5,
    data: encodeChunk(Buffer.alloc(48_577, 125)),
  });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-request-stream-too-large'),
    'history request streamed-size rejection',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-request-stream-too-large'), {
    type: MSG.ERROR,
    id: 'history-request-stream-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history request body too large',
  });
  assert.equal(requestCount, 0);
  assert.deepEqual(released, ['history-request-stream-too-large']);
});

test('G1-2 client relay history normalizer 关闭后请求和响应保持原样', async (t) => {
  let captured = null;
  let rawBody = null;
  let capturedContentLength = null;
  let capturedAcceptEncoding = null;
  const upstream = createSyntheticHistoryResponse({ messageCount: 1, chunksPerMessage: 5, chunkBytes: 32 });
  const local = http.createServer((req, res) => {
    const parts = [];
    capturedContentLength = req.headers['content-length'];
    capturedAcceptEncoding = req.headers['accept-encoding'];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => {
      rawBody = Buffer.concat(parts);
      captured = JSON.parse(rawBody.toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    historyNormalizer: { enabled: false },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1', maxMessages: 500 },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-disabled',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-disabled', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-disabled', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.RESP_END && msg.id === 'history-disabled'),
    'raw history response with disabled normalizer',
  );

  assert.equal(captured.payload.maxMessages, 500);
  assert.equal(Number(capturedContentLength), body.length);
  assert.equal(capturedAcceptEncoding, undefined);
  assert.deepEqual(rawBody, body);
  const response = JSON.parse(responseBody(sent, 'history-disabled').toString('utf8'));
  assert.deepEqual(response, upstream);
});

test('G1-2 client relay 只按 HTTP history API path 启用 normalizer', async (t) => {
  let captured = null;
  const upstream = createSyntheticHistoryResponse({ messageCount: 1, chunksPerMessage: 5, chunkBytes: 32 });
  const local = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (chunk) => parts.push(chunk));
    req.on('end', () => {
      captured = JSON.parse(Buffer.concat(parts).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const relay = new ClientRelay({ send: (msg) => sent.push(msg) });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1', maxMessages: 500 },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'not-history-path',
    method: 'POST',
    path: '/api/other',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'not-history-path', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'not-history-path', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.RESP_END && msg.id === 'not-history-path'),
    'non-history response',
  );

  assert.equal(captured.payload.maxMessages, 500);
  const response = JSON.parse(responseBody(sent, 'not-history-path').toString('utf8'));
  assert.deepEqual(response, upstream);
});

test('G1-2 client relay 对瘦身后仍超限的 history 响应返回明确错误', async (t) => {
  const upstream = createSyntheticHistoryResponse({ messageCount: 1, chunksPerMessage: 5, chunkBytes: 64 });
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    historyNormalizer: { hardBytes: 100 },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-too-large'),
    'history over-hard error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-too-large'), {
    type: MSG.ERROR,
    id: 'history-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response remains too large after normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA), false);
  assert.deepEqual(released, ['history-too-large']);
});

test('G1-2 client relay 对非 events history JSON 也执行最终 hardBytes 闸门', async (t) => {
  const upstream = {
    ok: true,
    result: {
      ok: true,
      value: {
        note: 'x'.repeat(512),
      },
    },
  };
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(upstream));
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    historyNormalizer: { hardBytes: 100 },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-not-events-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-not-events-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-not-events-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-not-events-too-large'),
    'history non-events over-hard error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-not-events-too-large'), {
    type: MSG.ERROR,
    id: 'history-not-events-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response remains too large after normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA && msg.id === 'history-not-events-too-large'), false);
});

test('G1-2 client relay 对缺失 content-type 的 history 响应也执行最终 hardBytes 闸门', async (t) => {
  const upstream = 'x'.repeat(512);
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {});
      res.end(upstream);
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    historyNormalizer: { hardBytes: 100 },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const body = jsonBody({
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  });
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-missing-content-type-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-missing-content-type-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-missing-content-type-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-missing-content-type-too-large'),
    'history missing content-type over-hard error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-missing-content-type-too-large'), {
    type: MSG.ERROR,
    id: 'history-missing-content-type-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response remains too large after normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA && msg.id === 'history-missing-content-type-too-large'), false);
  assert.deepEqual(released, ['history-missing-content-type-too-large']);
});

test('G1-2 client relay 对错误 content-type 的 history 响应也执行最终 hardBytes 闸门', async (t) => {
  const upstream = 'x'.repeat(512);
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(upstream);
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    historyNormalizer: { hardBytes: 100 },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const body = jsonBody({
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  });
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-wrong-content-type-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-wrong-content-type-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-wrong-content-type-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-wrong-content-type-too-large'),
    'history wrong content-type over-hard error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-wrong-content-type-too-large'), {
    type: MSG.ERROR,
    id: 'history-wrong-content-type-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response remains too large after normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA && msg.id === 'history-wrong-content-type-too-large'), false);
  assert.deepEqual(released, ['history-wrong-content-type-too-large']);
});

test('G1-2 client relay 对 malformed JSON 且超过 hardBytes 的 history 响应返回 LIMIT_EXCEEDED', async (t) => {
  const upstream = `{"broken":"${'x'.repeat(512)}`;
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(upstream);
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    historyNormalizer: { hardBytes: 100 },
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const body = jsonBody({
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  });
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-malformed-json-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-malformed-json-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-malformed-json-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-malformed-json-too-large'),
    'history malformed json over-hard error',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-malformed-json-too-large'), {
    type: MSG.ERROR,
    id: 'history-malformed-json-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response remains too large after normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA && msg.id === 'history-malformed-json-too-large'), false);
  assert.deepEqual(released, ['history-malformed-json-too-large']);
});

test('G1-2 client relay 对超过 history raw 上限的响应提前拒绝，避免完整缓冲', async (t) => {
  const upstream = JSON.stringify(createSyntheticHistoryResponse({
    messageCount: 1,
    chunksPerMessage: 8,
    chunkBytes: 128,
  }));
  const local = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(upstream);
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const historyEvents = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
    historyNormalizer: { maxRawBytes: 100 },
    onHistoryEvent: (event) => historyEvents.push(event),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const body = jsonBody({
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  });
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-raw-too-large',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json' },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-raw-too-large', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-raw-too-large', seq: 1, bytes: body.length });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR && msg.id === 'history-raw-too-large'),
    'history raw response rejection',
  );

  assert.deepEqual(sent.find((msg) => msg.type === MSG.ERROR && msg.id === 'history-raw-too-large'), {
    type: MSG.ERROR,
    id: 'history-raw-too-large',
    code: 'LIMIT_EXCEEDED',
    message: 'history response raw body too large before normalization',
  });
  assert.equal(sent.some((msg) => msg.type === MSG.RESP), false);
  assert.equal(sent.some((msg) => msg.type === MSG.RESP_DATA), false);
  assert.deepEqual(released, ['history-raw-too-large']);
  assert.equal(historyEvents.length, 1);
  assert.equal(historyEvents[0].terminalState, 'error');
  assert.equal(historyEvents[0].errorCode, 'LIMIT_EXCEEDED');
  assert.equal(historyEvents[0].rawResponseBytes > 100, true);
});

test('G1-2 client relay history 请求在 REQ_END 前 cancel 不打开本地请求，迟到的 REQ_END 也不会重开', async (t) => {
  let requestCount = 0;
  const local = http.createServer((req, res) => {
    requestCount += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits(DEFAULT_LIMITS);

  const request = {
    type: 'client-request',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };
  const body = jsonBody(request);
  relay.handleFrame({
    type: MSG.REQ,
    id: 'history-cancel-before-end',
    method: 'POST',
    path: '/api/session.history',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    bodyLength: body.length,
  });
  relay.handleFrame({ type: MSG.REQ_DATA, id: 'history-cancel-before-end', seq: 0, data: encodeChunk(body) });
  relay.handleFrame({ type: MSG.CANCEL, id: 'history-cancel-before-end' });
  relay.handleFrame({ type: MSG.REQ_END, id: 'history-cancel-before-end', seq: 1, bytes: body.length });

  await waitForCondition(() => released.includes('history-cancel-before-end'), 'history cancel release');

  assert.equal(requestCount, 0);
  assert.equal(sent.some((msg) => msg.id === 'history-cancel-before-end' && msg.type === MSG.RESP), false);
  assert.deepEqual(released, ['history-cancel-before-end']);
});

test('G1-2 history normalizer 环境变量解析支持关闭和上限覆盖', () => {
  assert.deepEqual(historyNormalizerOptionsFromEnv({
    DSH_HUB_HISTORY_NORMALIZER: 'off',
    DSH_HUB_HISTORY_MAX_MESSAGES: '12',
    DSH_HUB_HISTORY_TARGET_BYTES: '1234',
    DSH_HUB_HISTORY_HARD_BYTES: '5678',
    DSH_HUB_HISTORY_MAX_RAW_BYTES: '9012',
  }), {
    enabled: false,
    maxMessages: 12,
    targetBytes: 1234,
    hardBytes: 5678,
    maxRawBytes: 9012,
  });
  assert.equal(historyNormalizerOptionsFromEnv({}).enabled, true);
});

test('client relay 将本地 WebSocket open 前关闭转换为上游错误', async (t) => {
  const local = http.createServer();
  local.on('upgrade', (_req, socket) => {
    socket.destroy();
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => local.close());

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits({ ...DEFAULT_LIMITS, wsOpenTimeoutMs: 500 });

  relay.handleFrame({
    type: MSG.WS_REQ,
    id: 'ws-preopen-close',
    path: '/api/events.mux',
    headers: {},
    protocols: [],
  });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR),
    'local WebSocket pre-open error frame',
  );
  const error = sent.find((msg) => msg.type === MSG.ERROR);
  assert.equal(error.type, MSG.ERROR);
  assert.equal(error.id, 'ws-preopen-close');
  assert.equal(error.code, 'UPSTREAM_DOWN');
  assert.match(error.message, /socket|hang up|closed/i);
  assert.deepEqual(released, ['ws-preopen-close']);
  assert.equal(sent.some((msg) => msg.type === MSG.WS_END), false);
});

test('client relay 将本地 WebSocket open 卡住转换为上游超时', async (t) => {
  const sockets = new Set();
  const local = http.createServer();
  local.on('upgrade', (_req, socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    local.close();
  });

  const sent = [];
  const released = [];
  const relay = new ClientRelay({
    send: (msg) => sent.push(msg),
    releaseSession: (id) => released.push(id),
  });
  relay.setTarget({ host: '127.0.0.1', port: local.address().port });
  relay.setLimits({ ...DEFAULT_LIMITS, wsOpenTimeoutMs: 50 });

  relay.handleFrame({
    type: MSG.WS_REQ,
    id: 'ws-preopen-timeout',
    path: '/api/events.mux',
    headers: {},
    protocols: [],
  });

  await waitForCondition(
    () => sent.some((msg) => msg.type === MSG.ERROR),
    'local WebSocket pre-open timeout frame',
  );
  const error = sent.find((msg) => msg.type === MSG.ERROR);
  assert.deepEqual(error, {
    type: MSG.ERROR,
    id: 'ws-preopen-timeout',
    code: 'UPSTREAM_TIMEOUT',
    message: 'local DSH websocket open timeout',
  });
  assert.deepEqual(released, ['ws-preopen-timeout']);
  assert.equal(sent.some((msg) => msg.type === MSG.WS_OPEN), false);
  assert.equal(sent.some((msg) => msg.type === MSG.WS_END), false);
});
