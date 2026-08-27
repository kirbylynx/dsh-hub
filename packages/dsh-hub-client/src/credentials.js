import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const KEYRING_SERVICE = 'dsh-hub';
const DEFAULT_STORE_MODE = 'auto';

function normalizeStoreMode(mode) {
  const normalized = String(mode ?? DEFAULT_STORE_MODE).trim().toLowerCase();
  return ['auto', 'file', 'keyring'].includes(normalized) ? normalized : DEFAULT_STORE_MODE;
}

function sanitizeCredentials(creds) {
  return {
    endpoint: creds.endpoint,
    instanceId: creds.instanceId,
    installationId: creds.installationId ?? null,
    instanceToken: creds.instanceToken,
    instanceTokenExpiresAt: creds.instanceTokenExpiresAt ?? null,
    instanceTokenRenewalUntil: creds.instanceTokenRenewalUntil ?? null,
    delivery: creds.delivery ?? 'agent',
    target: creds.target,
    hostname: creds.hostname ?? null,
    clientVersion: creds.clientVersion ?? null,
    dshVersion: creds.dshVersion ?? null,
  };
}

function isValidCredentialShape(creds) {
  return !!(creds?.endpoint && creds?.instanceId && creds?.instanceToken);
}

function createInstallationId() {
  return `insl_${randomBytes(16).toString('base64url')}`;
}

function normalizeRegisterJournal(pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (!pending.idempotencyKey || !pending.request || typeof pending.request !== 'object') return null;
  return {
    idempotencyKey: String(pending.idempotencyKey),
    request: {
      endpoint: pending.request.endpoint ?? null,
      credentialKind: pending.request.credentialKind ?? null,
      delivery: pending.request.delivery ?? null,
      hostname: pending.request.hostname ?? null,
      dshVersion: pending.request.dshVersion ?? null,
      installationId: pending.request.installationId ?? null,
      clientVersion: pending.request.clientVersion ?? null,
    },
  };
}

export function keyringAccountForConfigDir(configDir) {
  const resolved = path.resolve(configDir);
  const suffix = createHash('sha256').update(resolved).digest('hex').slice(0, 24);
  return `cfg-${suffix}`;
}

/**
 * Credential store: prefer the system keychain (@napi-rs/keyring), fall back
 * to a 0600 JSON file (zero-dependency alternative, cf. design §5.5).
 * Stored shape:
 *   { endpoint, instanceId, installationId, instanceToken, delivery, target, hostname }
 */
export class CredentialStore {
  constructor(configDir) {
    this.configDir = configDir;
    this.filePath = path.join(configDir, 'credentials.json');
    this.statePath = path.join(configDir, 'client-state.json');
    this.pendingRegisterPath = path.join(configDir, 'pending-register.json');
    this.storeMode = normalizeStoreMode(process.env.DSH_HUB_CLIENT_CREDENTIAL_STORE);
    this.keyringAccount = keyringAccountForConfigDir(configDir);
  }

  async #keyringSet(json) {
    const { Entry } = await import('@napi-rs/keyring').catch(() => null);
    if (!Entry) return false;
    try {
      const e = new Entry(KEYRING_SERVICE, this.keyringAccount);
      e.setPassword(json);
      return true;
    } catch {
      return false;
    }
  }

  async #keyringGet() {
    const { Entry } = await import('@napi-rs/keyring').catch(() => null);
    if (!Entry) return null;
    try {
      const e = new Entry(KEYRING_SERVICE, this.keyringAccount);
      const pwd = e.getPassword();
      return pwd ?? null;
    } catch {
      return null;
    }
  }

  async #keyringDelete() {
    const { Entry } = await import('@napi-rs/keyring').catch(() => null);
    if (!Entry) return false;
    try {
      const e = new Entry(KEYRING_SERVICE, this.keyringAccount);
      e.deletePassword();
      return true;
    } catch {
      return false;
    }
  }

  #fileWrite(json) {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.filePath, json, { mode: 0o600 });
    fs.chmodSync(this.filePath, 0o600);
  }

  #fileRead() {
    try {
      return fs.readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
  }

  #writeJsonFile(filePath, value) {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }

  #readJsonFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async save(creds) {
    const safeCreds = sanitizeCredentials(creds);
    const json = JSON.stringify(safeCreds, null, 2);
    if (this.storeMode === 'file') {
      this.#fileWrite(json);
      return { usedKeyring: false, filePath: this.filePath };
    }

    const usedKeyring = await this.#keyringSet(json);
    if (usedKeyring) return { usedKeyring: true, filePath: this.filePath };
    if (this.storeMode === 'keyring') {
      throw new Error('system keychain unavailable for credential storage');
    }
    this.#fileWrite(json);
    return { usedKeyring: false, filePath: this.filePath };
  }

  async load() {
    let raw = null;
    if (this.storeMode === 'file') {
      raw = this.#fileRead();
    } else {
      raw = await this.#keyringGet();
      if (!raw && this.storeMode === 'auto') raw = this.#fileRead();
    }
    if (!raw) return null;
    try {
      const creds = JSON.parse(raw);
      const safeCreds = sanitizeCredentials(creds);
      if (!isValidCredentialShape(safeCreds)) return null;
      return safeCreds;
    } catch {
      return null;
    }
  }

  async clear() {
    if (this.storeMode !== 'file') await this.#keyringDelete();
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      /* noop */
    }
  }

  async ensureInstallationId() {
    const current = this.loadState();
    if (current.installationId) return current.installationId;
    const installationId = createInstallationId();
    this.saveState({ ...current, installationId });
    return installationId;
  }

  loadState() {
    const state = this.#readJsonFile(this.statePath);
    if (!state || typeof state !== 'object') return {};
    return {
      installationId: typeof state.installationId === 'string' ? state.installationId : null,
    };
  }

  saveState(state) {
    this.#writeJsonFile(this.statePath, {
      installationId: state.installationId ?? null,
    });
  }

  async loadPendingRegister() {
    return normalizeRegisterJournal(this.#readJsonFile(this.pendingRegisterPath));
  }

  async savePendingRegister(pending) {
    const normalized = normalizeRegisterJournal(pending);
    if (!normalized) throw new Error('invalid pending register journal');
    this.#writeJsonFile(this.pendingRegisterPath, normalized);
    return normalized;
  }

  async clearPendingRegister() {
    try {
      fs.rmSync(this.pendingRegisterPath, { force: true });
    } catch {
      /* noop */
    }
  }

  async loadPendingRotate() {
    return normalizeRotateJournal(this.#readJsonFile(path.join(this.configDir, 'pending-rotate-token.json')));
  }

  async savePendingRotate(pending) {
    const normalized = normalizeRotateJournal(pending);
    if (!normalized) throw new Error('invalid pending token rotate journal');
    this.#writeJsonFile(path.join(this.configDir, 'pending-rotate-token.json'), normalized);
    return normalized;
  }

  async clearPendingRotate() {
    try {
      fs.rmSync(path.join(this.configDir, 'pending-rotate-token.json'), { force: true });
    } catch {
      /* noop */
    }
  }
}

function normalizeRotateJournal(pending) {
  if (!pending || typeof pending !== 'object') return null;
  if (!pending.idempotencyKey || !pending.request || typeof pending.request !== 'object') return null;
  return {
    idempotencyKey: String(pending.idempotencyKey),
    request: {
      endpoint: pending.request.endpoint ?? null,
      instanceId: pending.request.instanceId ?? null,
    },
  };
}
