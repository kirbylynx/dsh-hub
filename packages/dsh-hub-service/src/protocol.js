// Relay protocol v1.1 — frame type names and negotiated limits (kept in sync
// with docs/protocol.md and packages/dsh-hub-client/src/protocol.js).
export const PROTO_VERSION = 1;
export const PROTO_MINOR = 1;

export const REQUIRED_CAPABILITIES = Object.freeze([
  'http-chunk-v1',
  'cancel-v1',
  'ws-bidi-chunk-v1',
  'heartbeat-v1',
  'limits-v1',
  'credit-flow-v1',
]);

export const DEFAULT_LIMITS = Object.freeze({
  maxTunnelMessageBytes: 524_288,
  maxChunkDecodedBytes: 262_144,
  maxHeaderBytes: 65_536,
  maxPathBytes: 8_192,
  maxHttpBodyBytes: 33_554_432,
  maxWsMessageBytes: 8_388_608,
  maxSessions: 64,
  maxPendingSessions: 16,
  initialStreamCreditBytes: 8_388_608,
  maxUncreditedBytesPerTunnel: 16_777_216,
  highWaterBytes: 8_388_608,
  lowWaterBytes: 2_097_152,
  backpressureTimeoutMs: 30_000,
  requestIdleTimeoutMs: 120_000,
  wsOpenTimeoutMs: 10_000,
});

export const MSG = Object.freeze({
  HELLO: 'hello',
  WELCOME: 'welcome',
  UNAUTHORIZED: 'unauthorized',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat',
  PONG: 'pong',
  BYE: 'bye',
  // HTTP relay
  REQ: 'req',
  REQ_DATA: 'reqData',
  REQ_END: 'reqEnd',
  RESP: 'resp',
  RESP_DATA: 'respData',
  RESP_END: 'respEnd',
  // WebSocket relay
  WS_REQ: 'wsReq',
  WS_OPEN: 'wsOpen',
  WS_ERR: 'wsErr',
  WS_DATA: 'wsData',
  WS_END: 'wsEnd',
  CANCEL: 'cancel',
  CREDIT: 'credit',
  // health
  HEALTH: 'health',
});

export const STREAMS = Object.freeze({
  REQ: 'req',
  RESP: 'resp',
  WS_C2I: 'ws-c2i',
  WS_I2C: 'ws-i2c',
});

export function negotiateLimits(offered, configured = {}) {
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) {
    return { ok: false, code: 'BAD_LIMITS', message: 'offeredLimits required' };
  }
  const deployment = { ...DEFAULT_LIMITS, ...configured };
  const limits = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = offered[key];
    const cap = deployment[key];
    if (!Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(cap) || cap <= 0) {
      return { ok: false, code: 'BAD_LIMITS', message: `invalid limit: ${key}` };
    }
    limits[key] = Math.min(value, cap);
  }
  const invariant = validateLimits(limits);
  if (!invariant.ok) return invariant;
  return { ok: true, limits };
}

export function validateLimits(limits) {
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0) {
      return { ok: false, code: 'BAD_LIMITS', message: `invalid limit: ${key}` };
    }
  }
  if (!(limits.lowWaterBytes < limits.highWaterBytes
    && limits.highWaterBytes <= limits.maxUncreditedBytesPerTunnel)) {
    return { ok: false, code: 'BAD_LIMITS', message: 'invalid watermarks' };
  }
  if (limits.initialStreamCreditBytes < limits.maxWsMessageBytes
    || limits.maxUncreditedBytesPerTunnel < limits.maxWsMessageBytes) {
    return { ok: false, code: 'BAD_LIMITS', message: 'invalid stream credit limits' };
  }
  const encodedChunk = Math.ceil(limits.maxChunkDecodedBytes / 3) * 4;
  if (limits.maxTunnelMessageBytes < encodedChunk + 512) {
    return { ok: false, code: 'BAD_LIMITS', message: 'maxTunnelMessageBytes too small' };
  }
  return { ok: true };
}

export function helloCapabilities() {
  return [...REQUIRED_CAPABILITIES];
}

export function offeredLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, ...overrides };
}

export function validateHandshakeCapabilities(msg) {
  if (msg.proto !== PROTO_VERSION) {
    return { ok: false, code: 'BAD_PROTO', message: `unsupported proto ${msg.proto}, expected ${PROTO_VERSION}` };
  }
  if (!Number.isSafeInteger(msg.minor) || msg.minor < PROTO_MINOR) {
    return { ok: false, code: 'BAD_MINOR', message: `minor ${msg.minor ?? 'missing'} is not supported` };
  }
  if (!Array.isArray(msg.capabilities)) {
    return { ok: false, code: 'MISSING_CAPABILITY', message: 'capabilities required' };
  }
  const got = new Set(msg.capabilities);
  const missing = REQUIRED_CAPABILITIES.find((cap) => !got.has(cap));
  if (missing) return { ok: false, code: 'MISSING_CAPABILITY', message: `missing capability ${missing}` };
  return { ok: true };
}

export function encodeChunk(buffer) {
  return Buffer.from(buffer).toString('base64');
}

export function decodeChunk(data, limits = DEFAULT_LIMITS) {
  if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    const err = new Error('data must be canonical base64');
    err.code = 'BAD_FRAME';
    throw err;
  }
  const estimated = Math.floor(data.length / 4) * 3;
  if (estimated > limits.maxChunkDecodedBytes + 2) {
    const err = new Error('chunk exceeds decoded size limit');
    err.code = 'BAD_FRAME';
    throw err;
  }
  const decoded = Buffer.from(data, 'base64');
  if (decoded.length > limits.maxChunkDecodedBytes || decoded.toString('base64') !== data) {
    const err = new Error('chunk exceeds limit or is not canonical');
    err.code = 'BAD_FRAME';
    throw err;
  }
  return decoded;
}

export function chunkBuffer(buffer, maxBytes) {
  const source = Buffer.from(buffer);
  const chunks = [];
  for (let offset = 0; offset < source.length; offset += maxBytes) {
    chunks.push(source.subarray(offset, Math.min(source.length, offset + maxBytes)));
  }
  return chunks;
}
