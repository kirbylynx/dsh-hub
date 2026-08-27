import crypto from 'node:crypto';

const CREDENTIAL_TYPES = new Set(['registry', 'instance', 'replacement']);

export class SecurityConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecurityConfigError';
  }
}

export function parseKeyring(raw, { name, exactBytes = null, minBytes = 32 } = {}) {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SecurityConfigError(`${name} 必须是 JSON object`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SecurityConfigError(`${name} 必须是非空 JSON object`);
  }

  const result = new Map();
  for (const [keyId, encoded] of Object.entries(value)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
      throw new SecurityConfigError(`${name} 包含非法 key ID`);
    }
    if (typeof encoded !== 'string' || !encoded) {
      throw new SecurityConfigError(`${name}.${keyId} 必须是 base64/base64url 字符串`);
    }
    let key;
    try {
      key = Buffer.from(encoded, 'base64url');
    } catch {
      throw new SecurityConfigError(`${name}.${keyId} 无法解码`);
    }
    if ((exactBytes !== null && key.length !== exactBytes) || key.length < minBytes) {
      const requirement = exactBytes === null ? `至少 ${minBytes}` : `恰好 ${exactBytes}`;
      throw new SecurityConfigError(`${name}.${keyId} 解码后必须为${requirement} bytes`);
    }
    result.set(keyId, key);
  }
  if (result.size === 0) throw new SecurityConfigError(`${name} 不能为空`);
  return result;
}

export function requireCurrentKey(keyring, keyId, name) {
  if (!keyId || !keyring.has(keyId)) {
    throw new SecurityConfigError(`${name} 必须引用 keyring 中存在的 key ID`);
  }
}

export function makeCredential(type) {
  const prefixes = { registry: 'dhk_', instance: 'dht_', replacement: 'dhr_' };
  if (!CREDENTIAL_TYPES.has(type)) throw new TypeError(`未知凭据类型: ${type}`);
  return prefixes[type] + crypto.randomBytes(24).toString('base64url');
}

export function credentialPrefix(raw) {
  return String(raw).slice(0, 12);
}

export function credentialDigest(key, type, raw) {
  if (!CREDENTIAL_TYPES.has(type)) throw new TypeError(`未知凭据类型: ${type}`);
  return crypto.createHmac('sha256', key)
    .update(type, 'utf8')
    .update(Buffer.from([0]))
    .update(String(raw), 'utf8')
    .digest();
}

export function verifyCredential({ raw, type, digest, pepperKeyId, keyring }) {
  const key = keyring.get(pepperKeyId);
  if (!key || !digest) return false;
  const actual = credentialDigest(key, type, raw);
  const expected = Buffer.isBuffer(digest) ? digest : Buffer.from(digest);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function makeInstanceId() {
  return `inst-${base32LowerNoPadding(crypto.randomBytes(16))}`;
}

export function makeInstallationId() {
  return `insl_${crypto.randomBytes(16).toString('base64url')}`;
}

function base32LowerNoPadding(input) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON 数字必须有限');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError('值不能规范化为 JSON');
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

export function validateIdempotencyKey(value) {
  return typeof value === 'string'
    && value.length >= 22
    && value.length <= 128
    && /^[A-Za-z0-9._~-]+$/.test(value);
}

export function encryptJson({ key, keyId, value, aad }) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    keyId,
    payload: Buffer.concat([nonce, tag, ciphertext]),
  };
}

export function decryptJson({ key, payload, aad }) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (data.length < 28) throw new Error('幂等响应密文长度非法');
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
