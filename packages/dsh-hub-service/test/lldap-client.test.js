import assert from 'node:assert/strict';
import test from 'node:test';

import { GraphqlLldapClient } from '../src/lldap-client.js';

test('LLDAP admission group 缺失时会自动创建再加入用户', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).endsWith('/auth/simple/login')) {
      return jsonResponse(200, { token: 'jwt-token' });
    }
    if (body.query.includes('query Groups')) {
      return jsonResponse(200, { data: { groups: [] } });
    }
    if (body.query.includes('mutation CreateGroup')) {
      assert.equal(body.variables.name, 'dsh-hub-users');
      return jsonResponse(200, { data: { createGroup: { id: 42, displayName: 'dsh-hub-users' } } });
    }
    if (body.query.includes('mutation AddUserToGroup')) {
      assert.deepEqual(body.variables, { userId: 'alice', groupId: 42 });
      return jsonResponse(200, { data: { addUserToGroup: { ok: true } } });
    }
    return jsonResponse(500, {});
  };

  const client = new GraphqlLldapClient({
    httpUrl: 'http://lldap.test',
    ldapUrl: 'ldap://lldap.test:3890',
    adminUsername: 'admin',
    adminPassword: 'password',
    baseDn: 'dc=dsh,dc=hub',
    admissionGroup: 'dsh-hub-users',
  });

  await client.addUserToAdmissionGroup('alice');

  assert.deepEqual(calls.map((call) => {
    if (call.url.endsWith('/auth/simple/login')) return 'login';
    if (call.body.query.includes('query Groups')) return 'groups';
    if (call.body.query.includes('mutation CreateGroup')) return 'createGroup';
    if (call.body.query.includes('mutation AddUserToGroup')) return 'addUserToGroup';
    return 'unknown';
  }), ['login', 'groups', 'createGroup', 'addUserToGroup']);
});

test('LLDAP fetch operation uses timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url, options = {}) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });

  const client = new GraphqlLldapClient({
    httpUrl: 'http://lldap.test',
    ldapUrl: 'ldap://lldap.test:3890',
    adminUsername: 'admin',
    adminPassword: 'password',
    baseDn: 'dc=dsh,dc=hub',
    admissionGroup: 'dsh-hub-users',
    timeoutMs: 1,
  });

  await assert.rejects(
    () => client.addUserToAdmissionGroup('alice'),
    (error) => error.code === 'LLDAP_TIMEOUT',
  );
});

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}
