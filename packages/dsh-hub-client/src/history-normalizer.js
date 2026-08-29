export const DEFAULT_HISTORY_MAX_MESSAGES = 20;
export const DEFAULT_HISTORY_TARGET_BYTES = 524_288;
export const DEFAULT_HISTORY_HARD_BYTES = 1_048_576;

const HISTORY_METHODS = new Set(['session.history', 'subagent.history']);
const TOKEN_CHUNK_TYPES = new Set(['text-delta', 'reasoning-delta', 'tool-call-delta']);

export function isDshHistoryMethod(method) {
  return HISTORY_METHODS.has(method);
}

export function normalizeHistoryRequestEnvelope(envelope, options = {}) {
  const maxMessages = normalizeMaxMessages(options.maxMessages ?? DEFAULT_HISTORY_MAX_MESSAGES);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { envelope, changed: false, reason: 'not-object' };
  }
  if (envelope.type !== 'client-request') {
    return { envelope, changed: false, reason: 'not-client-request' };
  }
  if (!isDshHistoryMethod(envelope.method)) {
    return { envelope, changed: false, reason: 'not-history' };
  }
  const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
    ? envelope.payload
    : {};
  const current = payload.maxMessages;
  if (Number.isSafeInteger(current) && current > 0 && current <= maxMessages) {
    return { envelope, changed: false, reason: 'already-bounded', maxMessages: current };
  }
  const next = {
    ...envelope,
    payload: {
      ...payload,
      maxMessages,
    },
  };
  return {
    envelope: next,
    changed: true,
    reason: current === undefined ? 'defaulted' : 'clamped',
    maxMessages,
  };
}

export function normalizeHistoryResponseEnvelope(envelope, options = {}) {
  if (options.method === undefined && options.unsafeAssumeHistory !== true) {
    return unchanged(envelope, 'missing-history-method');
  }
  if (options.method !== undefined && !isDshHistoryMethod(options.method)) {
    return unchanged(envelope, 'not-history');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return unchanged(envelope, 'not-object');
  }
  const result = envelope.result;
  if (!result || typeof result !== 'object' || result.ok !== true) {
    return unchanged(envelope, 'not-ok');
  }
  const value = result.value;
  if (!value || typeof value !== 'object' || !Array.isArray(value.events)) {
    return unchanged(envelope, 'not-history-value');
  }

  const referencedSettledChunkSeqs = settledAssistantChunkSeqs(value.events);
  const preservedTimingChunkSeqs = firstTokenChunkSeqs(value.events, referencedSettledChunkSeqs);
  if (referencedSettledChunkSeqs.size === 0) {
    return {
      envelope,
      changed: false,
      reason: 'no-settled-chunks',
      stats: historyStats(envelope, envelope, value.events, value.events, options),
    };
  }

  const normalizedEvents = value.events.filter((entry) => {
    const event = entry?.event;
    return event?.type !== 'assistant/chunk'
      || !referencedSettledChunkSeqs.has(event.seq)
      || preservedTimingChunkSeqs.has(event.seq);
  });

  if (normalizedEvents.length === value.events.length) {
    return {
      envelope,
      changed: false,
      reason: 'no-covered-chunks-in-page',
      stats: historyStats(envelope, envelope, value.events, normalizedEvents, options),
    };
  }

  const next = {
    ...envelope,
    result: {
      ...result,
      value: {
        ...value,
        events: normalizedEvents,
      },
    },
  };
  return {
    envelope: next,
    changed: true,
    reason: 'settled-assistant-chunks-removed',
    stats: historyStats(envelope, next, value.events, normalizedEvents, options),
  };
}

export function historyEnvelopeByteLength(envelope) {
  return Buffer.byteLength(JSON.stringify(envelope));
}

export function createSyntheticHistoryResponse(options = {}) {
  const {
    rpcId = 'synthetic-history',
    messageCount = 20,
    chunksPerMessage = 1000,
    chunkBytes = 128,
    includeRunningChunk = false,
    hasMore = true,
    includeProjections = true,
    startSeq = 0,
  } = options;
  if (!Number.isSafeInteger(messageCount) || messageCount < 0) throw new Error('messageCount must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunksPerMessage) || chunksPerMessage < 0) throw new Error('chunksPerMessage must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 0) throw new Error('chunkBytes must be a non-negative safe integer');
  if (!Number.isSafeInteger(startSeq) || startSeq < 0) throw new Error('startSeq must be a non-negative safe integer');

  const events = [];
  let seq = startSeq;
  const now = 1_800_000_000_000;
  for (let i = 0; i < messageCount; i += 1) {
    const chunkSeqs = [];
    events.push(historyEntry({ type: 'step/start', seq: seq++, time: now + seq, data: { stepId: `step-${i}` } }));
    for (let j = 0; j < chunksPerMessage; j += 1) {
      chunkSeqs.push(seq);
      events.push(historyEntry({
        type: 'assistant/chunk',
        seq: seq++,
        time: now + seq,
        data: {
          turn: `turn-${i}`,
          step: `step-${i}`,
          chunk: syntheticChunk(chunkBytes, i, j, chunksPerMessage),
        },
      }));
    }
    events.push(historyEntry({
      type: 'assistant/message',
      seq: seq++,
      time: now + seq,
      sourceEventSeqs: chunkSeqs,
      surfaceOp: { op: 'append' },
      data: { role: 'assistant', content: syntheticText(Math.min(chunkBytes, 128), i, 'final') },
    }));
    events.push(historyEntry({ type: 'step/end', seq: seq++, time: now + seq, data: { stepId: `step-${i}` } }));
  }
  if (includeRunningChunk) {
    events.push(historyEntry({
      type: 'assistant/chunk',
      seq: seq++,
      time: now + seq,
      data: {
        turn: 'turn-running',
        step: 'step-running',
        chunk: { type: 'text-delta', index: 0, text: syntheticText(chunkBytes, 'running', 0) },
      },
    }));
  }

  return {
    rpcId,
    result: {
      ok: true,
      value: {
        events,
        hasMore,
        ...(includeProjections ? { projections: { asOfSeq: seq - 1, values: { title: { text: 'Synthetic history' } } } } : {}),
      },
    },
  };
}

function settledAssistantChunkSeqs(entries) {
  const out = new Set();
  for (const entry of entries) {
    const event = entry?.event;
    if (event?.type !== 'assistant/message' || !Array.isArray(event.sourceEventSeqs)) continue;
    for (const seq of event.sourceEventSeqs) {
      if (Number.isSafeInteger(seq) && seq >= 0) out.add(seq);
    }
  }
  return out;
}

function firstTokenChunkSeqs(entries, settledChunkSeqs) {
  const bySeq = new Map();
  for (const entry of entries) {
    const event = entry?.event;
    if (event?.type === 'assistant/chunk' && Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event);
  }
  const out = new Set();
  for (const entry of entries) {
    const event = entry?.event;
    if (event?.type !== 'assistant/message' || !Array.isArray(event.sourceEventSeqs)) continue;
    for (const seq of event.sourceEventSeqs) {
      if (!settledChunkSeqs.has(seq)) continue;
      const chunkEvent = bySeq.get(seq);
      if (isTokenChunk(chunkEvent?.data?.chunk)) {
        out.add(seq);
        break;
      }
    }
  }
  return out;
}

function historyStats(originalEnvelope, normalizedEnvelope, originalEvents, normalizedEvents, options = {}) {
  const originalBytes = historyEnvelopeByteLength(originalEnvelope);
  const normalizedBytes = historyEnvelopeByteLength(normalizedEnvelope);
  const targetBytes = normalizeByteLimit(options.targetBytes ?? DEFAULT_HISTORY_TARGET_BYTES, DEFAULT_HISTORY_TARGET_BYTES);
  const hardBytes = normalizeByteLimit(options.hardBytes ?? DEFAULT_HISTORY_HARD_BYTES, DEFAULT_HISTORY_HARD_BYTES);
  return {
    originalEventCount: originalEvents.length,
    normalizedEventCount: normalizedEvents.length,
    removedEventCount: originalEvents.length - normalizedEvents.length,
    removedAssistantChunkCount: countAssistantChunks(originalEvents) - countAssistantChunks(normalizedEvents),
    originalBytes,
    normalizedBytes,
    savedBytes: Math.max(0, originalBytes - normalizedBytes),
    targetBytes,
    hardBytes,
    overTarget: normalizedBytes > targetBytes,
    overHard: normalizedBytes > hardBytes,
  };
}

function countAssistantChunks(entries) {
  return entries.reduce((count, entry) => count + (entry?.event?.type === 'assistant/chunk' ? 1 : 0), 0);
}

function normalizeMaxMessages(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_HISTORY_MAX_MESSAGES;
  return value;
}

function normalizeByteLimit(value, fallback) {
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

function unchanged(envelope, reason) {
  return { envelope, changed: false, reason };
}

function historyEntry(event) {
  return { event };
}

function syntheticText(bytes, messageIndex, chunkIndex) {
  if (bytes === 0) return '';
  const prefix = `synthetic-${messageIndex}-${chunkIndex}:`;
  return (prefix + 'x'.repeat(Math.max(0, bytes))).slice(0, bytes);
}

function syntheticChunk(bytes, messageIndex, chunkIndex, chunksPerMessage) {
  if (chunkIndex === 0) return { type: 'block-start', index: 0, blockType: 'text' };
  if (chunkIndex === chunksPerMessage - 1) return { type: 'finish', reason: 'stop' };
  return { type: 'text-delta', index: 0, text: syntheticText(bytes, messageIndex, chunkIndex) };
}

function isTokenChunk(chunk) {
  if (!chunk || typeof chunk !== 'object' || !TOKEN_CHUNK_TYPES.has(chunk.type)) return false;
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== '';
  if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined;
  return false;
}
