import fs from 'node:fs';

import { parseKeyring, requireCurrentKey } from './security.js';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8081,
  dbPath: './data/hub.db',
  baseDomain: 'localhost',
  portalHost: null,
  controlHost: null,
  instanceBaseDomain: null,
  publicScheme: 'http',
  publicPort: null,
  trustedProxyCidrs: '127.0.0.1/32,::1/128',
  trustedUserHeader: 'remote-user',
  proxyKey: null,
  inactiveMs: 60000,
  busyTimeoutMs: 5000,
  instanceTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
  instanceTokenRenewalGraceMs: 7 * 24 * 60 * 60 * 1000,
  instanceTokenOverlapMs: 5 * 60 * 1000,
  replacementGrantTtlMs: 10 * 60 * 1000,
  idempotencyResponseTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTombstoneTtlMs: 30 * 24 * 60 * 60 * 1000,
  inviteTtlMs: 24 * 60 * 60 * 1000,
  invitePowTtlMs: 5 * 60 * 1000,
  invitePowDifficulty: 16,
  bootstrapSystemAdminUsername: 'owner',
  authLogoutUrl: null,
  lldapMode: 'disabled',
  lldapHttpUrl: null,
  lldapLdapUrl: null,
  lldapAdminUsername: null,
  lldapAdminPassword: null,
  lldapBaseDn: null,
  lldapAdmissionGroup: 'dsh-hub-users',
  lldapTimeoutMs: 5000,
};

export function parseConfig(argv = process.argv.slice(2), env = process.env) {
  const cfg = {
    ...DEFAULTS,
    devAuthUser: env.DEV_AUTH_USER ?? null,
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS ?? DEFAULTS.trustedProxyCidrs,
    trustedUserHeader: env.TRUSTED_USER_HEADER ?? DEFAULTS.trustedUserHeader,
    proxyKey: readSecretEnv(env, 'DSH_HUB_PROXY_KEY', { optional: true }),
    publicScheme: env.PUBLIC_SCHEME ?? DEFAULTS.publicScheme,
    publicPort: env.PUBLIC_PORT ? parseInteger(env.PUBLIC_PORT, null, 'PUBLIC_PORT', 1, 65535) : null,
    bootstrapSystemAdminUsername: env.BOOTSTRAP_SYSTEM_ADMIN_USERNAME ?? DEFAULTS.bootstrapSystemAdminUsername,
    authLogoutUrl: env.AUTH_LOGOUT_URL ?? DEFAULTS.authLogoutUrl,
    inviteTtlMs: env.INVITE_TTL_MS ? parseInteger(env.INVITE_TTL_MS, DEFAULTS.inviteTtlMs, 'INVITE_TTL_MS', 60_000, 30 * 24 * 60 * 60 * 1000) : DEFAULTS.inviteTtlMs,
    invitePowTtlMs: env.INVITE_POW_TTL_MS ? parseInteger(env.INVITE_POW_TTL_MS, DEFAULTS.invitePowTtlMs, 'INVITE_POW_TTL_MS', 30_000, 60 * 60 * 1000) : DEFAULTS.invitePowTtlMs,
    invitePowDifficulty: env.INVITE_POW_DIFFICULTY ? parseInteger(env.INVITE_POW_DIFFICULTY, DEFAULTS.invitePowDifficulty, 'INVITE_POW_DIFFICULTY', 0, 30) : DEFAULTS.invitePowDifficulty,
    lldapMode: env.LLDAP_MODE ?? DEFAULTS.lldapMode,
    lldapHttpUrl: env.LLDAP_HTTP_URL ?? DEFAULTS.lldapHttpUrl,
    lldapLdapUrl: env.LLDAP_LDAP_URL ?? DEFAULTS.lldapLdapUrl,
    lldapAdminUsername: env.LLDAP_ADMIN_USERNAME ?? DEFAULTS.lldapAdminUsername,
    lldapAdminPassword: readSecretEnv(env, 'LLDAP_ADMIN_PASSWORD', { optional: true }),
    lldapBaseDn: env.LLDAP_BASE_DN ?? DEFAULTS.lldapBaseDn,
    lldapAdmissionGroup: env.LLDAP_ADMISSION_GROUP ?? DEFAULTS.lldapAdmissionGroup,
    lldapTimeoutMs: env.LLDAP_TIMEOUT_MS ? parseInteger(env.LLDAP_TIMEOUT_MS, DEFAULTS.lldapTimeoutMs, 'LLDAP_TIMEOUT_MS', 1000, 60000) : DEFAULTS.lldapTimeoutMs,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    let val = eq >= 0 ? a.slice(eq + 1) : null;
    if (val === null && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      val = argv[++i];
    }
    switch (key) {
      case 'host': cfg.host = val ?? DEFAULTS.host; break;
      case 'port': cfg.port = parseInteger(val, DEFAULTS.port, 'port', 1, 65535); break;
      case 'db': cfg.dbPath = val ?? DEFAULTS.dbPath; break;
      case 'base-domain': cfg.baseDomain = (val ?? DEFAULTS.baseDomain).toLowerCase(); break;
      case 'portal-host': cfg.portalHost = normalizeHost(val ?? ''); break;
      case 'control-host': cfg.controlHost = normalizeHost(val ?? ''); break;
      case 'instance-base-domain': cfg.instanceBaseDomain = normalizeHost(val ?? ''); break;
      case 'public-scheme': cfg.publicScheme = String(val ?? DEFAULTS.publicScheme).toLowerCase(); break;
      case 'public-port': cfg.publicPort = parseInteger(val, null, 'public-port', 1, 65535); break;
      case 'trusted-proxy-cidrs': cfg.trustedProxyCidrs = val ?? DEFAULTS.trustedProxyCidrs; break;
      case 'trusted-user-header': cfg.trustedUserHeader = String(val ?? DEFAULTS.trustedUserHeader).toLowerCase(); break;
      case 'dev-auth-user': cfg.devAuthUser = val ?? null; break;
      case 'bootstrap-system-admin-username': cfg.bootstrapSystemAdminUsername = val ?? DEFAULTS.bootstrapSystemAdminUsername; break;
      case 'auth-logout-url': cfg.authLogoutUrl = val ?? null; break;
      case 'help':
      case 'h':
        cfg.help = true;
        break;
      default: throw new Error(`unknown option: --${key}`);
    }
  }

  if (cfg.help) return cfg;

  cfg.baseDomain = normalizeHost(cfg.baseDomain);
  if (!cfg.portalHost) cfg.portalHost = cfg.baseDomain;
  if (!cfg.controlHost) cfg.controlHost = cfg.baseDomain === 'localhost' ? 'localhost' : `control.${cfg.baseDomain}`;
  if (!cfg.instanceBaseDomain) {
    cfg.instanceBaseDomain = cfg.baseDomain === 'localhost' ? 'localhost' : `instances.${cfg.baseDomain}`;
  }
  cfg.publicScheme = normalizeScheme(cfg.publicScheme);
  cfg.trustedUserHeader = normalizeTrustedUserHeader(cfg.trustedUserHeader);
  cfg.trustedProxyRanges = parseTrustedProxyCidrs(cfg.trustedProxyCidrs);

  cfg.tokenPepperKeyring = parseKeyring(readSecretEnv(env, 'TOKEN_PEPPER_KEYRING'), {
    name: 'TOKEN_PEPPER_KEYRING',
    minBytes: 32,
  });
  cfg.currentTokenPepperKeyId = env.CURRENT_TOKEN_PEPPER_KEY_ID;
  requireCurrentKey(cfg.tokenPepperKeyring, cfg.currentTokenPepperKeyId, 'CURRENT_TOKEN_PEPPER_KEY_ID');

  cfg.idempotencyEncryptionKeyring = parseKeyring(readSecretEnv(env, 'IDEMPOTENCY_ENCRYPTION_KEYRING'), {
    name: 'IDEMPOTENCY_ENCRYPTION_KEYRING',
    exactBytes: 32,
  });
  cfg.currentIdempotencyEncryptionKeyId = env.CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID;
  requireCurrentKey(
    cfg.idempotencyEncryptionKeyring,
    cfg.currentIdempotencyEncryptionKeyId,
    'CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID',
  );
  for (const tokenKey of cfg.tokenPepperKeyring.values()) {
    for (const encryptionKey of cfg.idempotencyEncryptionKeyring.values()) {
      if (tokenKey.equals(encryptionKey)) {
        throw new Error('IDEMPOTENCY_ENCRYPTION_KEYRING 不得复用 TOKEN_PEPPER_KEYRING 的 key material');
      }
    }
  }
  return cfg;
}

function readSecretEnv(env, name, { optional = false } = {}) {
  const direct = env[name];
  const filePath = env[`${name}_FILE`];
  if (direct && filePath) throw new Error(`${name} and ${name}_FILE cannot both be set`);
  if (filePath) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  if (direct !== undefined && direct !== '') return direct;
  return optional ? null : direct;
}

function normalizeHost(raw) {
  const host = String(raw ?? '').trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) throw new Error('host must not be empty');
  if (host.includes('/') || host.includes(':')) throw new Error(`invalid host: ${raw}`);
  return host;
}

function normalizeScheme(raw) {
  const scheme = String(raw ?? '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') throw new Error('public scheme must be http or https');
  return scheme;
}

function normalizeTrustedUserHeader(raw) {
  const header = String(raw ?? '').trim().toLowerCase();
  if (!['remote-user', 'x-authenticated-user'].includes(header)) {
    throw new Error('trusted user header must be remote-user or x-authenticated-user');
  }
  return header;
}

function parseTrustedProxyCidrs(raw) {
  return String(raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [addr, bitsRaw] = part.split('/');
      const family = addr.includes(':') ? 6 : 4;
      const max = family === 4 ? 32 : 128;
      const bits = bitsRaw === undefined ? max : Number(bitsRaw);
      if (!Number.isSafeInteger(bits) || bits < 0 || bits > max) throw new Error(`invalid CIDR: ${part}`);
      const bytes = parseIpBytes(addr, family);
      if (!bytes) throw new Error(`invalid CIDR address: ${part}`);
      return { family, bytes, bits, source: part };
    });
}

function parseIpBytes(addr, family = null) {
  if ((family === null || family === 4) && /^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(parts);
  }
  if (family === 4) return null;
  return parseIpv6Bytes(addr);
}

function parseIpv6Bytes(addr) {
  let value = String(addr).toLowerCase();
  if (value.startsWith('::ffff:')) return Buffer.concat([Buffer.alloc(10), Buffer.from([0xff, 0xff]), parseIpBytes(value.slice(7), 4) ?? Buffer.alloc(0)]);
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parsePart = (part) => {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    return parseInt(part, 16);
  };
  const leftNums = left.map(parsePart);
  const rightNums = right.map(parsePart);
  if (leftNums.includes(null) || rightNums.includes(null)) return null;
  const missing = halves.length === 2 ? 8 - leftNums.length - rightNums.length : 0;
  if (missing < 0 || (halves.length === 1 && leftNums.length !== 8)) return null;
  const nums = [...leftNums, ...Array(missing).fill(0), ...rightNums];
  const out = Buffer.alloc(16);
  nums.forEach((n, i) => out.writeUInt16BE(n, i * 2));
  return out;
}

function parseInteger(raw, fallback, name, min, max) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

export const HELP = `
dsh-hub-service — dsh-hub center (registration + tunnel relay + portal)

Usage:
  dsh-hub-service [options]

Options:
  --host <ip>            bind host (default 127.0.0.1)
  --port <n>             bind port (default 8081)
  --db <path>            SQLite database path (default ./data/hub.db)
  --base-domain <d>      base domain for instance subdomains (default localhost)
  --portal-host <h>      Portal host allowlist entry
  --control-host <h>     control-plane host allowlist entry
  --instance-base-domain <d>
                         instance subdomain suffix
  --public-scheme <s>    public scheme for generated URLs (http or https)
  --public-port <n>      public URL port, omitted by default
  --trusted-proxy-cidrs <cidrs>
                         comma-separated trusted proxy CIDRs
  --trusted-user-header <h>
                         trusted identity header: remote-user or x-authenticated-user
  --dev-auth-user <u>    dev only: always authenticate as this user (or set DEV_AUTH_USER)

Environment:
  DEV_AUTH_USER=<user>                         same as --dev-auth-user
  BOOTSTRAP_SYSTEM_ADMIN_USERNAME=<user>       initial system_admin user (default owner)
  AUTH_LOGOUT_URL=<url>                        optional Authelia logout URL for Portal
  TRUSTED_PROXY_CIDRS=<cidrs>                  trusted proxies for user identity headers
  TRUSTED_USER_HEADER=<header>                 trusted identity header
  DSH_HUB_PROXY_KEY=<secret>                   optional extra proxy key header
  PUBLIC_SCHEME=http|https                     scheme for public URLs
  PUBLIC_PORT=<n>                              port for public URLs
  TOKEN_PEPPER_KEYRING=<json>                  token HMAC keyring (base64url values)
  CURRENT_TOKEN_PEPPER_KEY_ID=<id>              active token pepper key ID
  IDEMPOTENCY_ENCRYPTION_KEYRING=<json>         AES-256-GCM keyring (32-byte values)
  CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID=<id>    active encryption key ID
  INVITE_TTL_MS=<ms>                            invite lifetime (default 24h)
  INVITE_POW_DIFFICULTY=<bits>                  simple invite PoW difficulty (default 16)
  INVITE_POW_TTL_MS=<ms>                        invite PoW challenge lifetime (default 5m)
  LLDAP_MODE=disabled|graphql                   LLDAP provisioning mode
  LLDAP_HTTP_URL=<url>                          LLDAP HTTP/GraphQL URL
  LLDAP_LDAP_URL=<url>                          LLDAP LDAP URL
  LLDAP_ADMIN_USERNAME=<user>                   LLDAP provisioning user
  LLDAP_ADMIN_PASSWORD[_FILE]=<secret>          LLDAP provisioning password
  LLDAP_BASE_DN=<dn>                            LDAP base DN, e.g. dc=example,dc=com
  LLDAP_ADMISSION_GROUP=<name>                  Authelia admission group
  LLDAP_TIMEOUT_MS=<ms>                         LLDAP operation timeout (default 5000)
`;
