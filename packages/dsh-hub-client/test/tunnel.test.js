import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';

import { DEFAULT_LIMITS, MSG, PROTO_MINOR, PROTO_VERSION, REQUIRED_CAPABILITIES, STREAMS } from '../src/protocol.js';
import { ClientRelay } from '../src/relay.js';
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
