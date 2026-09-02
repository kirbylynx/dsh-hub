import { Client } from 'ldapts';

export class LldapProvisioningError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LldapProvisioningError';
    this.code = code;
  }
}

export class NoopLldapClient {
  constructor({ enabled = false } = {}) {
    this.enabled = enabled;
  }

  async createUserWithPasswordAndGroup() {
    if (!this.enabled) throw new LldapProvisioningError('LLDAP_DISABLED', 'LLDAP provisioning is disabled');
  }

  async addUserToAdmissionGroup() {
    if (!this.enabled) throw new LldapProvisioningError('LLDAP_DISABLED', 'LLDAP provisioning is disabled');
  }

  async removeUserFromAdmissionGroup() {
    if (!this.enabled) throw new LldapProvisioningError('LLDAP_DISABLED', 'LLDAP provisioning is disabled');
  }
}

export class GraphqlLldapClient {
  constructor({
    httpUrl,
    ldapUrl,
    adminUsername,
    adminPassword,
    baseDn,
    admissionGroup = 'dsh-hub-users',
    timeoutMs = 5000,
  }) {
    this.httpUrl = stripTrailingSlash(httpUrl);
    this.ldapUrl = ldapUrl;
    this.adminUsername = adminUsername;
    this.adminPassword = adminPassword;
    this.baseDn = baseDn;
    this.admissionGroup = admissionGroup;
    this.timeoutMs = timeoutMs;
    if (!this.httpUrl || !this.ldapUrl || !this.adminUsername || !this.adminPassword || !this.baseDn) {
      throw new LldapProvisioningError('LLDAP_CONFIG_INVALID', 'LLDAP configuration is incomplete');
    }
  }

  async createUserWithPasswordAndGroup({ username, email, displayName, password }) {
    let userCreated = false;
    try {
      await this.#graphql(`
        mutation CreateUser($user: CreateUserInput!) {
          createUser(user: $user) { id }
        }
      `, {
        user: { id: username, email: email || null, displayName: displayName || username },
      });
      userCreated = true;
      await this.#setPassword(username, password);
      await this.addUserToAdmissionGroup(username);
    } catch (error) {
      if (userCreated && error instanceof LldapProvisioningError) error.partialUserCreated = true;
      throw error;
    }
  }

  async addUserToAdmissionGroup(username) {
    const groupId = await this.#ensureGroupId(this.admissionGroup);
    await this.#graphql(`
      mutation AddUserToGroup($userId: String!, $groupId: Int!) {
        addUserToGroup(userId: $userId, groupId: $groupId) { ok }
      }
    `, { userId: username, groupId });
  }

  async removeUserFromAdmissionGroup(username) {
    const groupId = await this.#groupId(this.admissionGroup);
    await this.#graphql(`
      mutation RemoveUserFromGroup($userId: String!, $groupId: Int!) {
        removeUserFromGroup(userId: $userId, groupId: $groupId) { ok }
      }
    `, { userId: username, groupId });
  }

  async #ensureGroupId(displayName) {
    const result = await this.#graphql(`
      query Groups {
        groups { id displayName }
      }
    `);
    const group = result.groups?.find((item) => item.displayName === displayName);
    if (group) return group.id;
    const created = await this.#graphql(`
      mutation CreateGroup($name: String!) {
        createGroup(name: $name) { id displayName }
      }
    `, { name: displayName });
    if (!created.createGroup?.id) {
      throw new LldapProvisioningError('LLDAP_GROUP_NOT_FOUND', 'LLDAP admission group not found');
    }
    return created.createGroup.id;
  }

  async #groupId(displayName) {
    const result = await this.#graphql(`
      query Groups {
        groups { id displayName }
      }
    `);
    const group = result.groups?.find((item) => item.displayName === displayName);
    if (!group) throw new LldapProvisioningError('LLDAP_GROUP_NOT_FOUND', 'LLDAP admission group not found');
    return group.id;
  }

  async #graphql(query, variables = {}) {
    const token = await this.#token();
    const response = await fetchWithTimeout(`${this.httpUrl}/api/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    }, this.timeoutMs);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.errors?.length) {
      throw new LldapProvisioningError('LLDAP_GRAPHQL_FAILED', 'LLDAP GraphQL operation failed');
    }
    return body.data ?? {};
  }

  async #token() {
    if (this.tokenExpiresAt && Date.now() < this.tokenExpiresAt && this.token) return this.token;
    const response = await fetchWithTimeout(`${this.httpUrl}/auth/simple/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: this.adminUsername, password: this.adminPassword }),
    }, this.timeoutMs);
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.token) {
      throw new LldapProvisioningError('LLDAP_LOGIN_FAILED', 'LLDAP login failed');
    }
    this.token = body.token;
    this.tokenExpiresAt = Date.now() + 20 * 60 * 1000;
    return this.token;
  }

  async #setPassword(username, password) {
    const client = new Client({
      url: this.ldapUrl,
      timeout: this.timeoutMs,
      connectTimeout: this.timeoutMs,
    });
    try {
      await client.bind(adminBindDn(this.adminUsername, this.baseDn), this.adminPassword);
      await client.exop('1.3.6.1.4.1.4203.1.11.1', encodePasswordModifyRequest({
        userIdentity: userDn(username, this.baseDn),
        newPassword: password,
      }));
    } catch (error) {
      throw new LldapProvisioningError('LLDAP_PASSWORD_SET_FAILED', 'LLDAP password operation failed');
    } finally {
      try { await client.unbind(); } catch { /* noop */ }
    }
  }
}

function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new LldapProvisioningError('LLDAP_TIMEOUT', 'LLDAP operation timed out');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function adminBindDn(username, baseDn) {
  return userDn(username, baseDn);
}

function userDn(username, baseDn) {
  return `uid=${escapeDnValue(username)},ou=people,${baseDn}`;
}

function escapeDnValue(value) {
  return String(value).replace(/[\\,+"<>;=#]/g, (ch) => `\\${ch}`);
}

function encodePasswordModifyRequest({ userIdentity, newPassword }) {
  const fields = [
    encodeContextOctetString(0, userIdentity),
    encodeContextOctetString(2, newPassword),
  ];
  return encodeSequence(Buffer.concat(fields));
}

function encodeSequence(value) {
  return Buffer.concat([Buffer.from([0x30]), encodeLength(value.length), value]);
}

function encodeContextOctetString(tag, value) {
  const payload = Buffer.from(String(value), 'utf8');
  return Buffer.concat([Buffer.from([0x80 + tag]), encodeLength(payload.length), payload]);
}

function encodeLength(length) {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
