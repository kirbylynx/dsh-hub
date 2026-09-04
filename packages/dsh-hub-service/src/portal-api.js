export const portalApiScript = String.raw`
async function api(url, opts) {
  const r = await fetch(url, opts || {});
  if (!r.ok) {
    const body = await r.json().catch(function () { return {}; });
    throw new Error((body.error && body.error.message) || body.error || r.statusText);
  }
  if (r.status === 204) return null;
  return r.json();
}

function writeHeaders(extraHeaders) {
  return Object.assign({
    'content-type': 'application/json',
    'X-CSRF-Token': PORTAL.csrfToken,
    'Idempotency-Key': randomIdempotencyKey(),
  }, extraHeaders || {});
}

function postJson(url, body, extraHeaders) {
  return api(url, { method: 'POST', headers: writeHeaders(extraHeaders), body: JSON.stringify(body || {}) });
}

function patchJson(url, body, extraHeaders) {
  return api(url, { method: 'PATCH', headers: writeHeaders(extraHeaders), body: JSON.stringify(body || {}) });
}

function deleteJson(url, extraHeaders) {
  return api(url, { method: 'DELETE', headers: writeHeaders(extraHeaders) });
}

function randomIdempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
}

function queryString(params) {
  const qs = new URLSearchParams();
  Object.keys(params).forEach(function (key) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== '') qs.set(key, params[key]);
  });
  return qs.toString();
}

async function copyText(text) {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function instanceUrl(id) {
  const u = PORTAL.instanceUrl;
  return u.scheme + '://' + id + '.' + u.baseDomain + (u.port ? ':' + u.port : '') + '/';
}
`;
