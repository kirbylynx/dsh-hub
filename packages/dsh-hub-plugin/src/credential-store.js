import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createInstallationId() {
  return `insl_${randomBytes(16).toString('base64url')}`;
}

function normalizeEndpoint(endpoint) {
  const value = cleanText(endpoint).replace(/\/+$/, '');
  return value || null;
}

function normalizeCredentials(creds) {
  if (!creds || typeof creds !== 'object') return null;
  const endpoint = normalizeEndpoint(creds.endpoint);
  const instanceId = cleanText(creds.instanceId);
  const instanceToken = cleanText(creds.instanceToken);
  const installationId = cleanText(creds.installationId);
  if (!endpoint || !instanceId || !instanceToken || !installationId) return null;
  return {
    endpoint,
    instanceId,
    installationId,
    instanceToken,
    instanceTokenExpiresAt: creds.instanceTokenExpiresAt ?? null,
    instanceTokenRenewalUntil: creds.instanceTokenRenewalUntil ?? null,
    delivery: 'plugin',
    deploymentMode: creds.deploymentMode ?? null,
    target: creds.target ?? null,
    hostname: cleanText(creds.hostname) || null,
    clientVersion: creds.clientVersion ?? '0.1.3',
    dshVersion: creds.dshVersion ?? null,
  };
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
      deploymentMode: pending.request.deploymentMode ?? null,
      hostname: pending.request.hostname ?? null,
      dshVersion: pending.request.dshVersion ?? null,
      installationId: pending.request.installationId ?? null,
      clientVersion: pending.request.clientVersion ?? null,
    },
  };
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

export function resolvePluginConfigDir(config = {}, env = process.env) {
  const configured = cleanText(config.configDir);
  if (configured) return path.resolve(configured);
  const envConfigured = cleanText(env.DSH_HUB_PLUGIN_CONFIG_DIR);
  if (envConfigured) return path.resolve(envConfigured);
  const dshHome = cleanText(env.DSH_HOME) || path.join(os.homedir(), '.dsh');
  return path.join(path.resolve(dshHome), 'dsh-hub-plugin');
}

export class PluginCredentialStore {
  constructor(configDir) {
    this.configDir = path.resolve(configDir);
    this.credentialsPath = path.join(this.configDir, 'credentials.json');
    this.statePath = path.join(this.configDir, 'state.json');
    this.pendingRegisterPath = path.join(this.configDir, 'pending-register.json');
    this.pendingRotatePath = path.join(this.configDir, 'pending-rotate-token.json');
  }

  #writeJsonFile(filePath, value) {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }

  #readJsonFile(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  async load() {
    return normalizeCredentials(this.#readJsonFile(this.credentialsPath));
  }

  async save(creds) {
    const normalized = normalizeCredentials(creds);
    if (!normalized) throw new Error('invalid plugin credentials');
    this.#writeJsonFile(this.credentialsPath, normalized);
    return { usedKeyring: false, filePath: this.credentialsPath };
  }

  async clear() {
    for (const filePath of [this.credentialsPath, this.pendingRegisterPath, this.pendingRotatePath]) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {
        /* noop */
      }
    }
  }

  loadState() {
    const state = this.#readJsonFile(this.statePath);
    return {
      installationId: typeof state?.installationId === 'string' ? state.installationId : null,
    };
  }

  saveState(state) {
    this.#writeJsonFile(this.statePath, {
      installationId: state.installationId ?? null,
    });
  }

  async ensureInstallationId() {
    const current = this.loadState();
    if (current.installationId) return current.installationId;
    const installationId = createInstallationId();
    this.saveState({ installationId });
    return installationId;
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
    return normalizeRotateJournal(this.#readJsonFile(this.pendingRotatePath));
  }

  async savePendingRotate(pending) {
    const normalized = normalizeRotateJournal(pending);
    if (!normalized) throw new Error('invalid pending token rotate journal');
    this.#writeJsonFile(this.pendingRotatePath, normalized);
    return normalized;
  }

  async clearPendingRotate() {
    try {
      fs.rmSync(this.pendingRotatePath, { force: true });
    } catch {
      /* noop */
    }
  }
}
