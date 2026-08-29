import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_HISTORY_MAX_MESSAGES,
  DEFAULT_HISTORY_TARGET_BYTES,
  createSyntheticHistoryResponse,
  historyEnvelopeByteLength,
  isDshHistoryMethod,
  normalizeHistoryRequestEnvelope,
  normalizeHistoryResponseEnvelope,
} from '../src/history-normalizer.js';

test('G1 history normalizer 识别 DSH 历史 RPC 方法', () => {
  assert.equal(isDshHistoryMethod('session.history'), true);
  assert.equal(isDshHistoryMethod('subagent.history'), true);
  assert.equal(isDshHistoryMethod('session.list'), false);
});

test('G1 history normalizer 为远程历史请求补充安全 maxMessages 默认值', () => {
  const input = {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };

  const result = normalizeHistoryRequestEnvelope(input);

  assert.equal(result.changed, true);
  assert.equal(result.reason, 'defaulted');
  assert.equal(result.envelope.payload.maxMessages, DEFAULT_HISTORY_MAX_MESSAGES);
  assert.equal(input.payload.maxMessages, undefined);
});

test('G1 history normalizer 不改写非 client-request 请求', () => {
  const input = {
    rpcId: 'r1',
    method: 'session.history',
    payload: { sessionId: 'sess-1' },
  };

  const result = normalizeHistoryRequestEnvelope(input);

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'not-client-request');
  assert.equal(result.envelope, input);
});

test('G1 history normalizer 将过大的 maxMessages 限制到配置上限', () => {
  const input = {
    type: 'client-request',
    rpcId: 'r1',
    method: 'subagent.history',
    payload: {
      parentSessionId: 'parent',
      childSessionId: 'child',
      mode: 'direct',
      maxMessages: 200,
    },
  };

  const result = normalizeHistoryRequestEnvelope(input, { maxMessages: 20 });

  assert.equal(result.changed, true);
  assert.equal(result.reason, 'clamped');
  assert.equal(result.envelope.payload.maxMessages, 20);
  assert.equal(input.payload.maxMessages, 200);
});

test('G1 history normalizer 保留已经低于上限的 maxMessages', () => {
  const input = {
    type: 'client-request',
    rpcId: 'r1',
    method: 'session.history',
    payload: { sessionId: 'sess-1', maxMessages: 10 },
  };

  const result = normalizeHistoryRequestEnvelope(input, { maxMessages: 20 });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'already-bounded');
  assert.equal(result.envelope, input);
});

test('G1 history normalizer 删除 settled chunk 但保留每条消息的首个 token chunk', () => {
  const input = createSyntheticHistoryResponse({
    messageCount: 20,
    chunksPerMessage: 1000,
    chunkBytes: 128,
    includeRunningChunk: true,
  });
  const originalBytes = historyEnvelopeByteLength(input);

  const result = normalizeHistoryResponseEnvelope(input, { method: 'session.history' });
  const normalizedBytes = historyEnvelopeByteLength(result.envelope);

  assert.equal(result.changed, true);
  assert.equal(result.reason, 'settled-assistant-chunks-removed');
  assert.equal(result.stats.removedAssistantChunkCount, 19_980);
  assert.ok(normalizedBytes < originalBytes / 5);
  assert.equal(result.stats.originalBytes, originalBytes);
  assert.equal(result.stats.normalizedBytes, normalizedBytes);
  assert.equal(result.stats.targetBytes, DEFAULT_HISTORY_TARGET_BYTES);
  assert.equal(result.stats.overHard, false);
  assert.equal(result.envelope.result.value.hasMore, input.result.value.hasMore);
  assert.deepEqual(result.envelope.result.value.projections, input.result.value.projections);
  assert.equal(input.result.value.events.length, 20 * (1000 + 3) + 1);

  const remainingTypes = result.envelope.result.value.events.map((entry) => entry.event.type);
  assert.equal(remainingTypes.filter((type) => type === 'assistant/message').length, 20);
  assert.equal(remainingTypes.filter((type) => type === 'assistant/chunk').length, 21);
  const keptSettledChunks = result.envelope.result.value.events
    .filter((entry) => entry.event.type === 'assistant/chunk' && entry.event.data.step !== 'step-running');
  assert.equal(keptSettledChunks.length, 20);
  assert.ok(keptSettledChunks.every((entry) => entry.event.data.chunk.type === 'text-delta'));
});

test('G1 history normalizer 不删除未被最终 message 引用的 running chunk', () => {
  const input = {
    rpcId: 'r1',
    result: {
      ok: true,
      value: {
        events: [
          { event: { type: 'assistant/chunk', seq: 1, time: 1, data: { delta: 'still streaming' } } },
        ],
        hasMore: false,
      },
    },
  };

  const result = normalizeHistoryResponseEnvelope(input, { method: 'session.history' });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-settled-chunks');
  assert.equal(result.envelope, input);
});

test('G1 history normalizer 在指定非 history method 时不改写 events 响应', () => {
  const input = createSyntheticHistoryResponse({
    messageCount: 1,
    chunksPerMessage: 10,
    chunkBytes: 64,
  });

  const result = normalizeHistoryResponseEnvelope(input, { method: 'session.events' });

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'not-history');
  assert.equal(result.envelope, input);
});

test('G1 history normalizer 默认要求显式 history method 防止误改写', () => {
  const input = createSyntheticHistoryResponse({
    messageCount: 1,
    chunksPerMessage: 10,
    chunkBytes: 64,
  });

  const result = normalizeHistoryResponseEnvelope(input);

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'missing-history-method');
  assert.equal(result.envelope, input);
});

test('G1 history normalizer 暴露瘦身后超过硬上限的统计', () => {
  const input = createSyntheticHistoryResponse({
    messageCount: 1,
    chunksPerMessage: 2,
    chunkBytes: 8,
  });

  const result = normalizeHistoryResponseEnvelope(input, { method: 'session.history', hardBytes: 100, targetBytes: 50 });

  assert.equal(result.stats.overTarget, true);
  assert.equal(result.stats.overHard, true);
  assert.equal(result.stats.hardBytes, 100);
  assert.equal(result.stats.targetBytes, 50);
});

test('G1 history normalizer 对非 history 响应和错误响应保持原样', () => {
  const bad = { rpcId: 'r1', result: { ok: false, error: { code: 'internal', message: 'x' } } };
  const list = { rpcId: 'r2', result: { ok: true, value: { items: [] } } };

  assert.equal(normalizeHistoryResponseEnvelope(bad, { method: 'session.history' }).envelope, bad);
  assert.equal(normalizeHistoryResponseEnvelope(list, { method: 'session.history' }).envelope, list);
});
