import { inspect } from 'node:util';

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

export function base64(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('base64') : Buffer.from(buf).toString('base64');
}

/** Split a "host:port" target into {host, port}. */
export function parseTarget(target) {
  const m = String(target).match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  let host;
  let port;
  if (m) {
    host = (m[1] || m[2]).toLowerCase();
    port = parseInt(m[3], 10);
  } else {
    const p = parseInt(target, 10);
    if (Number.isNaN(p)) throw new Error('target must be loopback host:port');
    host = '127.0.0.1';
    port = p;
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('target port out of range');
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('target host must be 127.0.0.1 or ::1');
  }
  return { host, port };
}

/** Convert an http(s) endpoint base URL to a ws(s) URL joined with a path. */
export function wsUrlFor(endpoint, pathname) {
  const base = String(endpoint).replace(/\/+$/, '');
  const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return wsBase + pathname;
}

/** Normalize raw Node http headers to a plain object of string[] values. */
export function normalizeHeaders(raw = {}) {
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : [String(v)];
  }
  return out;
}
