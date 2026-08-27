import assert from 'node:assert/strict';
import test from 'node:test';

import { MSG, STREAMS } from '../src/protocol.js';
import { Tunnel } from '../src/tunnel.js';

class FakeWs {
  constructor() {
    this.OPEN = 1;
    this.CLOSING = 2;
    this.readyState = this.OPEN;
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(payload, callback) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(JSON.parse(payload));
    queueMicrotask(() => callback?.());
  }

  close() {
    this.readyState = this.CLOSING;
  }

  terminate() {
    this.readyState = this.CLOSING;
  }
}

function makeTunnel(limits = {}) {
  const ws = new FakeWs();
  const tunnel = new Tunnel({
    ws,
    instanceId: 'inst-test',
    tokenId: 'tok-test',
    target: { host: '127.0.0.1', port: 3080, authority: '127.0.0.1:3080' },
    delivery: 'agent',
    hostname: 'test-host',
    dshVersion: 'test',
    limits: {
      initialStreamCreditBytes: 1024,
      maxUncreditedBytesPerTunnel: 1024,
      highWaterBytes: 2048,
      lowWaterBytes: 512,
      backpressureTimeoutMs: 1000,
      ...limits,
    },
  });
  return { tunnel, ws };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('M3B-3B service tunnel 数据帧受 tunnel 级未确认总账限制且控制帧不阻塞', async () => {
  const { tunnel, ws } = makeTunnel();

  await tunnel.sendData(
    { type: MSG.REQ_DATA, id: '1', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 1024 },
  );
  assert.equal(tunnel.outboundUncreditedBytes, 1024);

  let secondSent = false;
  const second = tunnel.sendData(
    { type: MSG.REQ_DATA, id: '2', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 512 },
  ).then(() => {
    secondSent = true;
  });
  await nextTick();

  assert.equal(secondSent, false);
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.REQ_DATA]);

  tunnel.send({ type: MSG.CANCEL, id: '2', code: 'TEST', message: 'control frame' });
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.REQ_DATA, MSG.CANCEL]);

  tunnel.releaseDataCredit('1', STREAMS.REQ, 1024);
  await second;

  assert.equal(secondSent, true);
  assert.equal(tunnel.outboundUncreditedBytes, 512);
  assert.deepEqual(ws.sent.map((frame) => frame.type), [MSG.REQ_DATA, MSG.CANCEL, MSG.REQ_DATA]);
});

test('M3B-3B service tunnel detachSession 释放未确认总账避免后续 session 饿死', async () => {
  const { tunnel, ws } = makeTunnel();

  await tunnel.sendData(
    { type: MSG.WS_DATA, id: '1', messageId: 0, seq: 0, final: true, binary: false, data: '' },
    { stream: STREAMS.WS_C2I, decodedBytes: 1024 },
  );
  const waiting = tunnel.sendData(
    { type: MSG.REQ_DATA, id: '2', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 512 },
  );
  await nextTick();
  assert.equal(ws.sent.length, 1);

  tunnel.detachSession('1');
  await waiting;

  assert.equal(tunnel.outboundUncreditedBytes, 512);
  assert.equal(ws.sent.length, 2);
});

test('M3B-3B service tunnel 高水位持续超时会拒绝数据帧', async () => {
  const { tunnel, ws } = makeTunnel({
    highWaterBytes: 1024,
    lowWaterBytes: 512,
    backpressureTimeoutMs: 10,
  });
  ws.bufferedAmount = 2048;

  await assert.rejects(
    tunnel.sendData(
      { type: MSG.REQ_DATA, id: '1', seq: 0, data: '' },
      { stream: STREAMS.REQ, decodedBytes: 512 },
    ),
    { code: 'LIMIT_EXCEEDED' },
  );

  assert.equal(ws.sent.length, 0);
  assert.equal(tunnel.outboundUncreditedBytes, 0);
});

test('M3B-3B service tunnel 数据帧发送失败会回滚未确认总账', async () => {
  const { tunnel, ws } = makeTunnel();
  ws.failSend = true;

  await assert.rejects(
    tunnel.sendData(
      { type: MSG.REQ_DATA, id: '1', seq: 0, data: '' },
      { stream: STREAMS.REQ, decodedBytes: 512 },
    ),
    /tunnel send failed/,
  );

  assert.equal(ws.sent.length, 0);
  assert.equal(tunnel.outboundUncreditedBytes, 0);
});

test('M3B-3C service tunnel 高水位下降后通过轮询恢复数据帧发送', async () => {
  const { tunnel, ws } = makeTunnel({
    highWaterBytes: 1024,
    lowWaterBytes: 512,
    backpressureTimeoutMs: 1000,
  });
  ws.bufferedAmount = 2048;

  let sent = false;
  const pending = tunnel.sendData(
    { type: MSG.REQ_DATA, id: '1', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 512 },
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

test('M3B-3C service tunnel 公平调度允许可发送小 session 绕过暂时放不下的大 session', async () => {
  const { tunnel, ws } = makeTunnel();

  await tunnel.sendData(
    { type: MSG.REQ_DATA, id: 'seed', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 768 },
  );

  let bigSent = false;
  const big = tunnel.sendData(
    { type: MSG.REQ_DATA, id: 'big', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 768 },
  ).then(() => {
    bigSent = true;
  });
  let smallSent = false;
  const small = tunnel.sendData(
    { type: MSG.REQ_DATA, id: 'small', seq: 0, data: '' },
    { stream: STREAMS.REQ, decodedBytes: 256 },
  ).then(() => {
    smallSent = true;
  });
  await nextTick();

  assert.equal(bigSent, false);
  assert.equal(smallSent, true);
  assert.deepEqual(ws.sent.map((frame) => frame.id), ['seed', 'small']);
  await small;

  tunnel.releaseDataCredit('seed', STREAMS.REQ, 768);
  await big;

  assert.equal(bigSent, true);
  assert.deepEqual(ws.sent.map((frame) => frame.id), ['seed', 'small', 'big']);
});
