import { randomBytes } from 'node:crypto';

function normalizeEndpoint(endpoint) {
  return endpoint.replace(/\/+$/, '');
}

function createIdempotencyKey() {
  return `idem_rot_${randomBytes(18).toString('base64url')}`;
}

function sameRequest(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errorCode(body) {
  if (typeof body?.error === 'string') return body.error;
  return body?.error?.code ?? null;
}

export async function rotateTokenWithHub({ creds, store }) {
  const request = {
    endpoint: normalizeEndpoint(creds.endpoint),
    instanceId: creds.instanceId,
  };
  let pending = await store.loadPendingRotate();
  if (!pending || !sameRequest(pending.request, request)) {
    pending = { idempotencyKey: createIdempotencyKey(), request };
    await store.savePendingRotate(pending);
  }

  let response;
  try {
    response = await fetch(`${request.endpoint}/api/instances/${request.instanceId}/tokens/rotate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${creds.instanceToken}`,
        'idempotency-key': pending.idempotencyKey,
      },
    });
  } catch (error) {
    throw new Error(`token rotate failed: ${error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status < 500 && response.status !== 429) await store.clearPendingRotate();
    throw new Error(`token rotate failed (${response.status}): ${errorCode(body) ?? response.statusText}`);
  }
  if (!body.instanceToken) throw new Error('token rotate failed: missing instanceToken in response');
  const nextCreds = {
    ...creds,
    instanceToken: body.instanceToken,
    instanceTokenExpiresAt: body.instanceTokenExpiresAt ?? null,
    instanceTokenRenewalUntil: body.instanceTokenRenewalUntil ?? null,
  };
  await store.save(nextCreds);
  await store.clearPendingRotate();
  return { body, creds: nextCreds };
}

export async function revokeSelfWithHub({ creds, store }) {
  const endpoint = normalizeEndpoint(creds.endpoint);
  const response = await fetch(`${endpoint}/api/instances/${creds.instanceId}/revoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.instanceToken}`,
    },
  });
  if (response.status === 204) {
    await store.clear();
    return { cleared: true, alreadyRevoked: false };
  }
  const body = await response.json().catch(() => ({}));
  if (response.status === 403 && errorCode(body) === 'TOKEN_REVOKED') {
    await store.clear();
    return { cleared: true, alreadyRevoked: true };
  }
  throw new Error(`leave failed (${response.status}): ${errorCode(body) ?? response.statusText}`);
}
