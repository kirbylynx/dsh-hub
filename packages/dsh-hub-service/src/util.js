import crypto from 'node:crypto';
import { inspect } from 'node:util';

export const now = () => Date.now();

export const rid = (len = 6) => crypto.randomBytes(len).toString('hex');

export const makeRegistryKey = () => 'dhk_' + crypto.randomBytes(24).toString('base64url');
export const makeInstanceToken = () => 'dht_' + crypto.randomBytes(24).toString('base64url');

const SECRET_TOKEN_PATTERN = /\b(?:dhk|dhr|dht|dit)_[A-Za-z0-9_-]+\b/g;
const SENSITIVE_KEY_NAMES = [
  'registryKey',
  'replacementGrant',
  'instanceToken',
  'authorization',
  'cookie',
  'proxyAuthorization',
  'proxy-authorization',
  'proxyKey',
  'x-dsh-hub-proxy-key',
  'idempotencyKey',
  'idempotency-key',
  'Idempotency-Key',
].join('|');
const QUOTED_SECRET_FIELD_PATTERN = new RegExp(`(["'])(${SENSITIVE_KEY_NAMES})\\1\\s*:\\s*(["'])(?:\\\\.|(?!\\3).)*\\3`, 'gi');
const BARE_QUOTED_SECRET_FIELD_PATTERN = new RegExp(`\\b(${SENSITIVE_KEY_NAMES})\\b\\s*[:=]\\s*(["'])(?:\\\\.|(?!\\2).)*\\2`, 'gi');
const SENSITIVE_HEADER_PATTERN = /\b(authorization|proxy-authorization|cookie|x-dsh-hub-proxy-key|idempotency-key)\s*:\s*[^\r\n]*/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(`\\b(${SENSITIVE_KEY_NAMES})\\b\\s*=\\s*[^\\r\\n]*`, 'gi');
const BARE_SECRET_FIELD_PATTERN = new RegExp(`\\b(${SENSITIVE_KEY_NAMES})\\b\\s*:\\s*[^'",}\\]\\s]+`, 'gi');
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactLogText(text) {
  return String(text)
    .replace(SECRET_TOKEN_PATTERN, '[redacted-secret]')
    .replace(QUOTED_SECRET_FIELD_PATTERN, (_match, keyQuote, key, valueQuote) => `${keyQuote}${key}${keyQuote}: ${valueQuote}[redacted-secret]${valueQuote}`)
    .replace(BARE_QUOTED_SECRET_FIELD_PATTERN, (_match, key, valueQuote) => `${key}: ${valueQuote}[redacted-secret]${valueQuote}`)
    .replace(SENSITIVE_HEADER_PATTERN, (_match, key) => `${key}: [redacted-secret]`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, key) => `${key}=[redacted-secret]`)
    .replace(BEARER_PATTERN, 'Bearer [redacted-secret]')
    .replace(BARE_SECRET_FIELD_PATTERN, (_match, key) => `${key}=[redacted-secret]`);
}

export function redactLogValue(value) {
  if (typeof value === 'string') return redactLogText(value);
  if (value instanceof Error) return redactLogText(value.stack || `${value.name}: ${value.message}`);
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;
  if (value && typeof value === 'object') {
    return redactLogText(inspect(value, {
      depth: 4,
      breakLength: 120,
      maxArrayLength: 20,
      maxStringLength: 2000,
    }));
  }
  return value;
}

export function log(...args) {
  console.log(new Date().toISOString(), ...args.map(redactLogValue));
}

// Hop-by-hop / sensitive headers that must not be forwarded through the relay.
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;
const CENTER_IDENTITY_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
  'remote-user',
  'remote-groups',
  'remote-email',
  'remote-name',
  'x-authenticated-user',
  'x-remote-user',
  'x-dsh-hub-proxy-key',
]);
const WEBSOCKET_HANDSHAKE_HEADERS = new Set([
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
]);
// Headers stripped when relaying a browser request into an instance tunnel.
// (Origin / sec-fetch-* must be dropped so the DSH Host fence sees a
// "same-origin local browser"; Host is rewritten separately.)
const STRIP_ON_FORWARD = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-fetch-user',
]);

/** Normalize a raw headers object (array|string values) to string[] values. */
export function normalizeHeaders(raw = {}) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : [String(v)];
  }
  return out;
}

/** Pick headers to forward to the instance: strip hop-by-hop + origin/sec-fetch. */
export function forwardHeaders(headers, { hostHeader }) {
  const out = {};
  const dynamicHopByHop = connectionHeaderTokens(headers);
  for (const [k, vals] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    if (dynamicHopByHop.has(k)) continue;
    if (CENTER_IDENTITY_HEADERS.has(k)) continue;
    if (WEBSOCKET_HANDSHAKE_HEADERS.has(k)) continue;
    if (STRIP_ON_FORWARD.has(k)) continue;
    if (k === 'forwarded' || k === 'via' || k === 'x-real-ip' || k === 'true-client-ip') continue;
    if (k.startsWith('x-forwarded-') || k.startsWith('cf-')) continue;
    if (k.startsWith('x-dsh-hub-')) continue;
    if (k === 'host') continue; // replaced below
    if (k === 'content-length') continue; // recomputed from buffered body
    out[k] = vals;
  }
  if (hostHeader) out.host = [hostHeader];
  return out;
}

/** Pick response headers to forward back to the browser. */
export function forwardRespHeaders(headers = {}) {
  const out = {};
  const normalized = normalizeHeaders(headers);
  const dynamicHopByHop = connectionHeaderTokens(normalized);
  for (const [k, vals] of Object.entries(normalized)) {
    if (HOP_BY_HOP.has(k)) continue;
    if (dynamicHopByHop.has(k)) continue;
    if (k === 'set-cookie') continue;
    if (k === 'content-length') continue;
    if (k === 'forwarded' || k === 'via' || k === 'x-real-ip' || k === 'true-client-ip') continue;
    if (k.startsWith('x-forwarded-') || k.startsWith('cf-') || k.startsWith('x-accel-')) continue;
    if (k.startsWith('x-dsh-hub-')) continue;
    out[k] = vals;
  }
  return out;
}

export function base64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

function connectionHeaderTokens(headers) {
  const out = new Set();
  for (const value of headers.connection ?? []) {
    for (const rawToken of String(value).split(',')) {
      const token = rawToken.trim().toLowerCase();
      if (!token) continue;
      if (!HEADER_TOKEN.test(token)) {
        const err = new Error('invalid Connection header');
        err.status = 400;
        err.code = 'BAD_HEADER';
        throw err;
      }
      out.add(token);
    }
  }
  return out;
}
