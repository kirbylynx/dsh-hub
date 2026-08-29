import { randomBytes } from 'node:crypto';

/**
 * Register this machine with the hub: POST <endpoint>/api/register using the
 * namespace registry key; returns { instanceId, instanceToken, ... }.
 */
function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

function normalizeRegisterRequest({ endpoint, delivery, hostname, dshVersion, installationId, clientVersion, credentialKind }) {
  return {
    endpoint: normalizeEndpoint(endpoint),
    credentialKind,
    delivery,
    hostname: hostname ?? null,
    dshVersion: dshVersion ?? null,
    installationId,
    clientVersion: clientVersion ?? '0.1.2',
  };
}

function sameRegisterRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createIdempotencyKey() {
  return `idem_reg_${randomBytes(18).toString('base64url')}`;
}

function parseRetryAfterMs(value, attempt) {
  const seconds = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5000);
  return Math.min(250 * attempt, 1000);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function registerWithHub({
  endpoint,
  registryKey,
  replacementGrant,
  delivery,
  hostname,
  dshVersion,
  installationId,
  clientVersion,
  store,
}) {
  if (!!registryKey === !!replacementGrant) {
    throw new Error('exactly one of registryKey or replacementGrant is required');
  }
  const normalized = normalizeRegisterRequest({
    endpoint,
    delivery,
    hostname,
    dshVersion,
    installationId,
    clientVersion,
    credentialKind: registryKey ? 'registry' : 'replacement',
  });
  const payload = {
    ...(registryKey ? { registryKey } : { replacementGrant }),
    delivery,
    hostname: hostname ?? null,
    dshVersion: dshVersion ?? null,
    installationId,
    clientVersion: normalized.clientVersion,
  };

  let pending = store ? await store.loadPendingRegister() : null;
  if (!pending || !sameRegisterRequest(pending.request, normalized)) {
    pending = {
      idempotencyKey: createIdempotencyKey(),
      request: normalized,
    };
    await store?.savePendingRegister(pending);
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(`${normalized.endpoint}/api/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': pending.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      if (attempt < 2) {
        await sleep(parseRetryAfterMs(null, attempt));
        continue;
      }
      throw new Error(`register failed: ${err.message}`);
    }

    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      if (!body.instanceId || !body.instanceToken) {
        throw new Error('register failed: missing instanceId/instanceToken in response');
      }
      await store?.clearPendingRegister();
      return body;
    }

    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        await sleep(parseRetryAfterMs(res.headers.get('retry-after'), attempt));
        continue;
      }
      throw new Error(`register failed (${res.status}): ${body.error ?? res.statusText}`);
    }

    await store?.clearPendingRegister();
    throw new Error(`register failed (${res.status}): ${body.error ?? res.statusText}`);
  }

  throw new Error('register failed: exhausted retries');
}
