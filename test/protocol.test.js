import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import * as serviceProtocol from '../packages/dsh-hub-service/src/protocol.js';
import * as clientProtocol from '../packages/dsh-hub-client/src/protocol.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./protocol-fixtures/v1.1-handshake.json', import.meta.url), 'utf8'));

test('service/client protocol constants and required capabilities stay aligned', () => {
  assert.equal(clientProtocol.PROTO_VERSION, serviceProtocol.PROTO_VERSION);
  assert.equal(clientProtocol.PROTO_MINOR, serviceProtocol.PROTO_MINOR);
  assert.deepEqual(clientProtocol.REQUIRED_CAPABILITIES, serviceProtocol.REQUIRED_CAPABILITIES);
  assert.deepEqual(clientProtocol.DEFAULT_LIMITS, serviceProtocol.DEFAULT_LIMITS);
  assert.deepEqual(clientProtocol.MSG, serviceProtocol.MSG);
});

test('v1.1 handshake fixture satisfies capability and limits contract on both sides', () => {
  const hello = fixture.hello;
  assert.deepEqual(hello.capabilities, serviceProtocol.REQUIRED_CAPABILITIES);
  assert.deepEqual(hello.offeredLimits, serviceProtocol.DEFAULT_LIMITS);
  assert.equal(serviceProtocol.validateHandshakeCapabilities(hello).ok, true);
  assert.equal(clientProtocol.validateHandshakeCapabilities(hello).ok, true);
  assert.deepEqual(serviceProtocol.negotiateLimits(hello.offeredLimits).limits, serviceProtocol.DEFAULT_LIMITS);
  assert.deepEqual(clientProtocol.negotiateLimits(hello.offeredLimits).limits, clientProtocol.DEFAULT_LIMITS);
});

test('base64 chunk validation rejects non-canonical data before allocating large buffers', () => {
  assert.throws(() => serviceProtocol.decodeChunk('AA', serviceProtocol.DEFAULT_LIMITS), /canonical base64/);
  assert.throws(() => clientProtocol.decodeChunk('Zm9v\n', clientProtocol.DEFAULT_LIMITS), /canonical base64/);
  const encoded = serviceProtocol.encodeChunk(Buffer.from('hello'));
  assert.equal(encoded, 'aGVsbG8=');
  assert.equal(serviceProtocol.decodeChunk(encoded, serviceProtocol.DEFAULT_LIMITS).toString('utf8'), 'hello');
});

test('limit validation rejects missing fields on both service and client helpers', () => {
  const incomplete = { ...serviceProtocol.DEFAULT_LIMITS };
  delete incomplete.maxSessions;
  assert.equal(serviceProtocol.validateLimits(incomplete).ok, false);
  assert.equal(clientProtocol.validateLimits(incomplete).ok, false);
});
