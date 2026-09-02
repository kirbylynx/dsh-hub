# dsh-hub relay protocol v1.1

Language: English | [简体中文](protocol.zh.md)

- Document version: v1.1.
- Wire protocol major version: `proto: 1`.
- Wire protocol minor version: `minor: 1`.
- Date: 2026-09-02.
- Status: v0.1.5 G2 adds LLDAP-backed users, invites, namespace roles, instance
  ACLs, admin user status APIs, and audit/recover Portal APIs. It does not add
  tunnel frame types or change relay semantics; service/client/plugin continue
  to use `proto: 1`, `minor: 1`.
- Related docs:
  [requirements](plans/20260821-v0.1.0-requirements.md) and
  [design](plans/20260821-v0.1.0-design.md).

This file is the single source of truth for the relay wire protocol implemented
by the service, client, and plugin. Protocol changes must update this document,
both endpoint implementations, contract tests, and the implementation-plan state.

This document describes the target v1.1 protocol. v0.1.3 G13 uses
`deploymentMode` only as optional non-secret metadata to distinguish ordinary
remote plugin instances from operator-managed hosted DSH composition. v0.1.5 G2
adds HTTP/Portal authorization APIs around the existing relay. M2
deployment, M3A diagnostics, M4 plugin-first integration, the M3B
metrics/backpressure/alert/recovery/logging baseline, hosted DSH composition,
history lazy loading, and G13 model-settings gating reuse the existing
`req/wsReq`, data, credit, cancel, heartbeat/pong, and health semantics unless a
separate protocol review updates this file and the tests.

## 1. Scope and compatibility policy

The protocol connects an instance-side client/plugin to the center service.
Browsers continue to use ordinary HTTP and WebSocket. After user authentication
and ACL checks, the service converts browser traffic into protocol frames.

v1.1 keeps `proto: 1` and adds `minor` plus capability negotiation. The pre-M1B
prototype that inlined request bodies and lacked capabilities was a v1.0
prototype and does not satisfy this specification. A v1.1 service must reject
old clients that lack required capabilities so revocation, streaming, and
resource boundaries do not silently break.

### 1.1 Required capabilities

```json
[
  "http-chunk-v1",
  "cancel-v1",
  "ws-bidi-chunk-v1",
  "heartbeat-v1",
  "limits-v1",
  "credit-flow-v1"
]
```

Minor-version increments may add negotiable capabilities only. Any change to an
existing frame meaning or security semantic must increment the protocol major
version. A proto-1 v1.1 service requires `minor >= 1`; lower minors receive
`BAD_MINOR`. Higher minors may connect as long as they include every service
required capability. Unknown capabilities are ignored and logged; a higher minor
alone is not a reason to reject a client.

## 2. Entry points, transport, and base constraints

- Registration: `POST https://control.<baseDomain>/api/register`.
- Authenticated namespace creation: `POST https://<baseDomain>/api/namespaces`, with
  browser authentication, Origin, and CSRF.
- Namespace registry-key rotation:
  `POST https://<baseDomain>/api/namespaces/<namespaceId>/rotate`, with browser
  authentication, ACL, Origin, and CSRF.
- Token rotation:
  `POST https://control.<baseDomain>/api/instances/<instanceId>/tokens/rotate`.
- Client self-revoke:
  `POST https://control.<baseDomain>/api/instances/<instanceId>/revoke`, using
  the current instance token.
- Namespace instance revoke:
  `POST https://<baseDomain>/api/instances/<instanceId>/revoke`, with browser
  authentication, ACL, Origin, and CSRF.
- Namespace instance recover:
  `POST https://<baseDomain>/api/instances/<instanceId>/recover`, with browser
  authentication, ACL, Origin, and CSRF.
- Namespace replacement-grant creation:
  `POST https://<baseDomain>/api/instances/<instanceId>/replacement-grants`,
  with browser authentication, ACL, Origin, and CSRF, not a control-plane token.
- Namespace list: `GET https://<baseDomain>/api/namespaces`.
- Namespace instance list:
  `GET https://<baseDomain>/api/namespaces/<namespaceId>/instances`.
- Namespace member list/update:
  `GET/POST/PATCH/DELETE https://<baseDomain>/api/namespaces/<namespaceId>/members`.
- Namespace invite list/create/revoke:
  `GET/POST https://<baseDomain>/api/namespaces/<namespaceId>/invites` and
  `POST https://<baseDomain>/api/invites/<inviteId>/revoke`.
- Public invite registration:
  `GET https://<baseDomain>/invite/<inviteToken>` plus
  `GET /api/invites/<inviteToken>/summary`,
  `POST /api/invites/<inviteToken>/pow`, and
  `POST /api/invites/<inviteToken>/consume`.
- System user list/status:
  `GET https://<baseDomain>/api/system/users` and
  `POST /api/system/users/<userId>/disable|restore`.
- Namespace audit list:
  `GET https://<baseDomain>/api/namespaces/<namespaceId>/audit`.
- Tunnel: `wss://control.<baseDomain>/agent`.
- Instance-side TLS verification is mandatory. Production must not use
  `rejectUnauthorized:false`.
- The tunnel uses UTF-8 JSON WebSocket text messages. One WebSocket message is
  one protocol envelope.
- Binary data is carried as base64 in `data`; decoded bytes are subject to
  negotiated limits.
- The WebSocket transport preserves tunnel message order. Frames with different
  session IDs may interleave; frames for the same ID must use strictly
  increasing `seq` values.
- Plaintext registry keys appear only in namespace create/rotate HTTPS responses
  and new instance registration HTTPS requests. They never enter URLs, tunnel
  frames, or logs.
- Replacement grants appear only in owner create responses and one recovery
  registration HTTPS request. They never enter URLs, tunnel frames, or logs.
- Instance tokens appear only in tunnel hello or HTTPS Authorization for token
  rotation/self-revoke. They do not appear in logs or ordinary relay frames.

## 3. Registration and credential-management HTTPS APIs

For Portal-host APIs, "exact Origin" means the configured Portal public origin.
Production uses `https://<baseDomain>`. Development may use an explicitly
configured `http://...` value. It must not be inferred ad hoc from the request
Host or unverified forwarding headers.

Namespace creation, instance registration, registry-key rotation, instance-token
rotation, and replacement-grant creation issue secrets that cannot be queried
again, so they must include `Idempotency-Key`. Callers generate this value with a
cryptographically secure random source: at least 128 bits, encoded as 22..128
URL-safe ASCII characters. The service stores only a digest. The idempotency
scope is the verified actor, endpoint operation, and key. The request digest
covers path parameters and the canonical JSON body.

- Mutation, request fingerprint, and original HTTP response must commit in the
  same database transaction. Responses are AES-256-GCM encrypted with an
  external keyring separate from token pepper. AAD binds actor scope, operation,
  key digest, request digest, and status.
- By default, within 24 hours, the same scope/key/request returns the exact same
  status/body without re-executing the mutation. The same key with a different
  request returns `409 IDEMPOTENCY_CONFLICT`.
- After an encrypted response expires, ciphertext is deleted but a tombstone is
  kept for 30 days by default. Retrying the same key returns
  `409 IDEMPOTENCY_RESULT_EXPIRED` and never re-executes the mutation.
- Owner-operation actor scope uses canonical user ID plus target resource.
  Control-plane operations use the verified registry key/grant/token record ID.
  Rotated, consumed, updated, or expired credentials may replay only their
  previously committed matching idempotent result; they must not create a new
  mutation.
- Missing or malformed idempotency keys return
  `400 IDEMPOTENCY_REQUIRED/BAD_IDEMPOTENCY_KEY`. Clients/Portal must persist a
  non-secret pending key and canonical non-secret request fields before the first
  request, reuse them on retry, and delete them after a confirmed result.
  Secrets must not be written to that journal.
- A client must not generate a new key and automatically retry after the response
  retention period. Namespace creation should check the list; lost registry keys
  require explicit owner rotation; lost instance registration/token rotation
  results require owner replacement; lost grants require explicit new grants.
- Revoke is terminal and idempotent, does not issue secrets, and does not use the
  response cache above. Its convergence semantics are described in Section 3.5.

### 3.1 Owner creates namespace

```http
POST /api/namespaces
Content-Type: application/json
Origin: https://<baseDomain>
X-CSRF-Token: <portal-csrf-token>
Idempotency-Key: <random-idempotency-key>
```

```json
{"name":"My namespace"}
```

This endpoint lives on the Portal host. The service verifies Authelia user,
exact Origin, and CSRF, then creates a namespace whose creator receives the
`namespace_owner` role plus the first active registry key in one database
transaction. `name` is 1..100 Unicode
characters after trimming and is display-only; it is not used for Host or path
parsing.

The success response shows the full key once:

```json
{"namespaceId":"ns_...","registryKey":"dhk_...","prefix":"dhk_abcd","version":1}
```

### 3.2 New instance registration

Request:

```http
POST /api/register
Content-Type: application/json
Idempotency-Key: <random-idempotency-key>
```

```json
{
  "registryKey": "dhk_...",
  "installationId": "insl_<22-char-base64url>",
  "delivery": "agent",
  "deploymentMode": "remote",
  "hostname": "macbook.example",
  "clientVersion": "0.1.0",
  "dshVersion": "0.1.0-rc.7"
}
```

When an already-bound instance is recovered with explicit owner approval, the
request carries a one-time replacement grant instead. `registryKey` and
`replacementGrant` are mutually exclusive:

```json
{
  "replacementGrant": "dhr_...",
  "installationId": "insl_<22-char-base64url>",
  "delivery": "agent",
  "deploymentMode": "remote",
  "hostname": "macbook.example",
  "clientVersion": "0.1.0",
  "dshVersion": "0.1.0-rc.7"
}
```

Success:

```json
{
  "instanceId": "inst-...",
  "instanceToken": "dht_...",
  "instanceTokenExpiresAt": "2026-09-20T00:00:00.000Z",
  "instanceTokenRenewalUntil": "2026-09-27T00:00:00.000Z",
  "namespaceId": "ns_...",
  "serverVersion": "0.1.0"
}
```

Rules:

- `installationId` is generated on first local join and stored stably. It is
  `insl_` plus a 128-bit random value encoded as unpadded base64url
  (22 characters, total length 27). If it is lost, a replacement grant cannot
  recover the original instance.
- `instanceId` is generated by the service. It is `inst-` plus a 128-bit random
  value encoded as RFC 4648 lowercase unpadded base32 (26 characters, total
  length 31, alphabet `a-z2-7`) and becomes the instance subdomain label.
- Instance IDs use a cryptographically secure random source and a database
  uniqueness constraint. On the extremely unlikely collision, regenerate; never
  overwrite an existing instance.
- `delivery` is `agent` or `plugin`. `deploymentMode` is optional non-secret
  composition metadata and may be `remote` or `hosted`; invalid or missing values
  are treated as missing, not as registration failure. `hostname` is 1..253 UTF-8
  bytes after trimming. `clientVersion`/`dshVersion` are `null` or 1..64
  printable ASCII characters. Control characters are rejected.
- If `(namespaceId, installationId)` is already bound, a registry key must not
  silently overwrite it; return `409 INSTANCE_ALREADY_BOUND`.
- Each namespace has exactly one current registry key. That current key can
  register multiple different installation IDs; successful registration does not
  consume or change the key.
- After owner registry-key rotation, the old version cannot register new
  instances. Invalid or rotated keys return `401 INVALID_REGISTRY_KEY` without
  revealing the exact reason.
- Concurrent registry-key rotation and registration are ordered by database
  transaction commit. If registration commits first, the new instance token is
  valid; if rotation commits first, old-key registration fails. Rotation never
  affects already committed instance tokens.
- A replacement grant is issued by a Portal owner after ACL/CSRF checks. It is
  bound to namespace, original instance ID, and installation ID; it is short
  lived and atomically consumed once. Creating a grant does not change instance
  or token state.
- Consuming a grant keeps the original instance ID, restores the instance to
  active, revokes all old tokens, issues a new token, and marks the grant used
  in one transaction. After commit, the service immediately closes old tunnels
  and related sessions.
- Invalid, expired, used, superseded, or binding-mismatched grants all return
  `401 INVALID_REPLACEMENT_GRANT`. Admin revoke does not automatically issue a
  grant.
- The registration endpoint is rate-limited by source and namespace and records
  audit events. After success, clients do not store registry keys or replacement
  grants by default.

### 3.3 Namespace registry-key rotation

```http
POST /api/namespaces/<namespaceId>/rotate
Content-Type: application/json
Origin: https://<baseDomain>
X-CSRF-Token: <portal-csrf-token>
Idempotency-Key: <random-idempotency-key>
```

```json
{"expectedVersion":1}
```

This Portal-host endpoint verifies Authelia user, namespace-owner ACL, Origin,
and CSRF. `expectedVersion` is the positive integer last observed by the caller
from create/list responses. The service matches the current active version,
marks the old key `rotated`, and creates one new unique `active` key in a single
transaction. Version mismatch returns `409 REGISTRY_VERSION_CONFLICT` without
issuing a key. Success returns the new `registryKey`, `prefix`, `version`, and
`rotatedAt` once.

Rotation only changes future `/api/register` registry-key checks. Existing
instance tokens, online tunnels, and instance state must not change. Old key
digests and versions are retained only for audit and cannot be restored to
active.

### 3.4 Instance-token rotation

```http
POST /api/instances/<instanceId>/tokens/rotate
Authorization: Bearer <current-instance-token>
Idempotency-Key: <random-idempotency-key>
```

Success:

```json
{
  "instanceToken":"dht_...",
  "instanceTokenExpiresAt":"2026-09-20T00:00:00.000Z",
  "instanceTokenRenewalUntil":"2026-09-27T00:00:00.000Z",
  "overlapUntil":"2026-08-21T08:05:00.000Z"
}
```

Default initial token TTL is 30 days, renewal grace is 7 days, and old-token
overlap is 5 minutes. Service time is authoritative. A currently valid token, or
an expired token within `expiresAt < now <= renewalUntil`, may rotate. An
expired token inside grace may call only this endpoint and may not connect a
tunnel. After `renewalUntil`, return `401 TOKEN_EXPIRED`. Admin-revoked tokens
can never rotate.

If the old token is still valid, `overlapUntil = min(now + configuredOverlap,
old.expiresAt)`. If it is already expired, `overlapUntil = now`. The client must
atomically persist the new token before opening a takeover tunnel with the new
token. The service tracks which token ID a tunnel uses; at `overlapUntil`, any
tunnel still using the old token receives `bye {code:"TOKEN_ROTATED"}`, all its
sessions are cancelled, and the connection closes. Instance ID does not change.

The rotation transaction records a unique `rotatedToTokenId` and fixed
`overlapUntil` on the current token row. Retrying the same token with the same
idempotency key replays per Section 3. Concurrent or later requests with
different idempotency keys may issue only one successor; the rest return
`409 TOKEN_ALREADY_ROTATED` and must not fork the token chain.

Main errors:

- `401 TOKEN_INVALID`
- `401 TOKEN_EXPIRED`
- `403 TOKEN_REVOKED`
- `404 INSTANCE_NOT_FOUND`

Admin re-enable uses Portal owner authorization and does not reuse this endpoint.

### 3.5 Instance self-revoke and owner revoke

Client `leave` uses the control host:

```http
POST /api/instances/<instanceId>/revoke
Authorization: Bearer <current-instance-token>
```

Portal owner uses the same path on the Portal host and does not use a Bearer
token:

```http
POST /api/instances/<instanceId>/revoke
Content-Type: application/json
Origin: https://<baseDomain>
X-CSRF-Token: <portal-csrf-token>
```

```json
{"reason":"operator revoked this installation"}
```

Owner requests must include a 1..200-character audit reason. Both calls mark the
instance `revoked` and revoke all tokens in one transaction. Owner success audit
must commit in the same transaction as revoke; if audit fails, revoke must not
silently take effect. After commit, send `bye {code:"TOKEN_REVOKED"}`, close the
tunnel, and cancel all sessions. Success returns `204 No Content`.

Self-revoke requires a current valid Bearer token bound to the path instance ID.
The client cleans local instance credentials only after a successful response. If
the response is lost, a retry may receive `TOKEN_REVOKED`; the client may treat
that as convergence for its local instance ID and clear credentials. The
installation ID is kept for diagnostics and owner-approved recovery.

### 3.6 Owner replacement grant

```http
POST /api/instances/<instanceId>/replacement-grants
Content-Type: application/json
Origin: https://<baseDomain>
X-CSRF-Token: <portal-csrf-token>
Idempotency-Key: <random-idempotency-key>
```

```json
{"reason":"operator approved credential recovery"}
```

This Portal-host endpoint verifies Authelia user, instance-owner ACL, exact
Origin, and CSRF. Requests require a 1..200-character audit reason. Success
shows `replacementGrant` and `expiresAt` once; the default lifetime is
10 minutes. In the same transaction, the service first marks any previous
`status='outstanding'` grant for the same instance, including expired but
uncleaned grants, as `superseded`; then it creates the new outstanding grant. A
database uniqueness constraint ensures at most one outstanding grant per
instance. The service stores only a type-domain-separated digest, binding,
issuer, reason, and consumption state. Grants must not appear in URLs, audit
details, or non-idempotency replay query responses.

### 3.7 User, role, invite, and audit Portal APIs

v0.1.5 introduces Hub user records backed by Authelia/LLDAP identity. The edge
proxy authenticates the browser and forwards a trusted username header only
after stripping spoofed external identity headers. The Hub then maps the
username to an active Hub user and applies action-level authorization.

Roles are namespace-scoped:

- `namespace_owner`: full namespace administration, including registry
  rotation, member/invite management, instance revoke/recover, replacement
  grants, diagnostics, and audit view.
- `namespace_admin`: day-to-day namespace administration, but it cannot grant or
  remove owner privileges.
- `member`: can open assigned namespace instances and run diagnostics.
- `viewer`: can see namespace/instance metadata but cannot open the instance
  relay.

System administrators can list users and disable/restore Hub users. LLDAP has no
portable disabled-account attribute in the supported Authelia LLDAP profile, so
disable removes the user from the configured LLDAP admission group and marks the
Hub user disabled. Restore re-adds that group before marking the Hub user active.

Invite tokens use the `dhi_` credential type, are shown only at creation time,
and are stored as peppered digests with prefix and pepper-key metadata for safe
lookup and future pepper rotation. Public invite consumption requires:

1. reading invite summary;
2. requesting a short-lived PoW challenge;
3. submitting username, optional email/display name, password, challenge ID, and
   nonce;
4. provisioning the user in LLDAP;
5. recording Hub user and namespace membership metadata.

If LLDAP provisioning succeeds but final Hub completion fails, the invite is
marked `failed_needs_admin` so an operator can reconcile manually.

Namespace member, invite, audit, instance recover, and system user status
mutations require exact Portal Origin and CSRF. GET list APIs allow absent
Origin but reject a mismatched Origin. Responses must not expose plaintext
secrets, credential digests, pepper key material, LDAP bind passwords, or
provider API keys.

### 3.8 Role-aware read-only lists

```http
GET /api/namespaces?limit=50&cursor=<opaque>
GET /api/namespaces/<namespaceId>/instances?limit=50&cursor=<opaque>
```

Both endpoints live on the Portal host, use Authelia browser identity, and
enforce namespace ACL. GET does not require CSRF and may omit Origin; if Origin
is present, it must exactly match the Portal public origin. Responses do not
enable cross-origin CORS. `limit` defaults to 50 and accepts 1..100. `cursor` is
an opaque service-issued value sorted by `(createdAt DESC,id DESC)`. Invalid
cursors return `400 BAD_CURSOR`. Namespace list returns only namespaces visible
to the current user. Instance list returns 404 both when the namespace is missing
and when it is not visible to the current user, preventing cross-namespace
enumeration.

Namespace response example:

```json
{
  "items": [
    {
      "namespaceId": "ns_...",
      "name": "My namespace",
      "registryKey": {"prefix":"dhk_abcd","version":2,"issuedAt":"2026-08-21T08:00:00.000Z"},
      "role": "namespace_owner",
      "createdAt": "2026-08-21T07:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

Instance response example:

```json
{
  "items": [
    {
      "instanceId": "inst-...",
      "delivery": "agent",
      "deploymentMode": "remote",
      "hostname": "macbook.example",
      "clientVersion": "0.1.0",
      "dshVersion": "0.1.0-rc.7",
      "state": "active",
      "connectionState": "offline",
      "role": "member",
      "canOpen": true,
      "latestTokenExpiresAt": "2026-09-20T00:00:00.000Z",
      "latestTokenRenewalUntil": "2026-09-27T00:00:00.000Z",
      "dshHealth": {
        "lastReportedOnline": true,
        "observedAt": "2026-08-21T08:00:00.000Z",
        "freshness": "stale"
      },
      "createdAt": "2026-08-21T07:30:00.000Z"
    }
  ],
  "nextCursor": null
}
```

`connectionState` is computed only from the current service process tunnel
registry. `dshHealth.observedAt` uses the service receive time for health
reports. Without observations, `dshHealth` is `null`. After
`healthStaleAfterMs` (default 90,000ms), `freshness="stale"`; otherwise it is
`fresh`. `latestToken*` describes only the latest non-revoked token, may be
`null`, and does not change instance management state.

List responses must not include plaintext or digest registry keys, replacement
grants, plaintext or digest instance tokens, pepper key IDs, installation IDs,
Authelia identity headers, internal database IDs, or `id/status` compatibility
aliases.

### 3.9 HTTPS error format

Non-2xx responses for management APIs use JSON. Automated behavior relies only
on stable `code` values and must not parse `message`:

```json
{
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "instance credential is expired",
    "requestId": "req_..."
  }
}
```

`message` must not contain credentials, digests, bindings, or database details.
Authentication failures use 401/403 as defined by each endpoint. Missing
resources or unauthorized owner access use 404. Input errors use 400, state or
idempotency conflicts use 409, rate limiting uses 429 plus `Retry-After`, and
service failures use 5xx. Write requests with non-`application/json`
Content-Type return 415. Malformed or over-limit bodies return 400/413 and must
not enter mutation transactions.

Management JSON bodies default to a 16 KiB limit and maximum nesting depth 8.
Duplicate keys, dangerous prototype keys, non-UTF-8, non-finite numbers, and
fields outside the schema all return 400. Display strings are trimmed before
length validation and reject C0 control characters.

Network failures, 429, or 5xx may be retried with `Retry-After` or exponential
backoff, but secret-issuing operations must reuse the same pending idempotency
key and original request fields. Unknown 4xx/code stops and asks for manual
state verification. Error paths must never automatically generate a new key and
redo a mutation.

## 4. Generic envelope

```json
{
  "type": "reqData",
  "id": "1",
  "seq": 0,
  "data": "<base64>"
}
```

Rules:

- `type` is required, case-sensitive, and must be in the negotiated frame set.
- `id` identifies a relay session and is assigned by the service. Connection
  frames such as hello/heartbeat/health have no `id`.
- `id` is at most 64 ASCII characters, unique within one tunnel, and must not be
  reused after termination.
- `seq` increments from 0 separately for HTTP request streams and response
  streams. Terminal frames use the next sequence. Each logical WebSocket message
  has its own sequence starting at 0. Duplicates, gaps, and reverse ordering are
  invalid.
- All objects reject dangerous prototype keys and excess nesting/string length.
- Unknown type, wrong field type, over-limit envelope, or a session frame
  missing `id` is `BAD_FRAME`.
- Session-level errors terminate the session. Connection-level protocol errors
  send fatal `error` and close the tunnel.

## 5. Handshake

After connecting to `/agent`, the instance must send exactly one hello within
`helloTimeoutMs`. The timeout is configured and enforced by the service before
welcome; v0.1.0 defaults to 10,000ms. Deployments may lower it or raise it only
after review.

M1A-3 implemented target loopback constraints and Host rewrite toward DSH. M1B
upgraded hello to the v1.1 object target, required capabilities, and
`offeredLimits`/`welcome.limits` negotiation. Legacy string targets are
pre-M1A compatibility history and are not part of the current protocol bar.

### 5.1 hello

```json
{
  "type": "hello",
  "proto": 1,
  "minor": 1,
  "capabilities": [
    "http-chunk-v1",
    "cancel-v1",
    "ws-bidi-chunk-v1",
    "heartbeat-v1",
    "limits-v1",
    "credit-flow-v1"
  ],
  "instanceId": "inst-...",
  "instanceToken": "dht_...",
  "delivery": "plugin",
  "deploymentMode": "hosted",
  "target": {"host":"127.0.0.1","port":3080},
  "clientVersion": "0.1.0",
  "dshVersion": "0.1.0-rc.7",
  "offeredLimits": {
    "maxFrameBytes": 262144,
    "maxDecodedChunkBytes": 196608,
    "maxHttpBodyBytes": 10485760,
    "maxWsMessageBytes": 1048576,
    "maxSessions": 64,
    "maxUncreditedBytesPerSession": 1048576,
    "maxUncreditedBytesPerTunnel": 8388608,
    "highWaterBytes": 2097152,
    "lowWaterBytes": 1048576,
    "backpressureTimeoutMs": 30000,
    "heartbeatIntervalMs": 30000,
    "heartbeatTimeoutMs": 90000,
    "dshRequestTimeoutMs": 120000,
    "wsOpenTimeoutMs": 30000
  }
}
```

Rules:

- `proto` must be 1 and `minor >= 1`.
- `capabilities` must contain every required capability exactly once as strings.
  Unknown entries are ignored and logged.
- `instanceId` and `instanceToken` authenticate the tunnel. Invalid/expired/
  revoked/rotated tokens fail before welcome.
- `delivery` must match the registered instance delivery, currently `agent` or
  `plugin`.
- `deploymentMode` is optional non-secret composition metadata. The service only
  records `remote` or `hosted`; invalid or missing hello values do not clear a
  previously recorded valid mode. Hosted-only capabilities must still verify
  local hosted eligibility and must not rely on this metadata as authorization.
- `target.host` must be loopback: `127.0.0.1`, `::1`, or `localhost`.
  `target.port` is an integer 1..65535.
- `offeredLimits` must include every v1.1 field listed in Section 5.2. Values
  are positive JSON safe integers. Missing, invalid, out-of-range, or
  invariant-violating values return `BAD_LIMITS`.

### 5.2 welcome and negotiated limits

```json
{
  "type": "welcome",
  "proto": 1,
  "minor": 1,
  "serverVersion": "0.1.0",
  "instanceId": "inst-...",
  "limits": {
    "maxFrameBytes": 262144,
    "maxDecodedChunkBytes": 196608,
    "maxHttpBodyBytes": 10485760,
    "maxWsMessageBytes": 1048576,
    "maxSessions": 64,
    "maxUncreditedBytesPerSession": 1048576,
    "maxUncreditedBytesPerTunnel": 8388608,
    "highWaterBytes": 2097152,
    "lowWaterBytes": 1048576,
    "backpressureTimeoutMs": 30000,
    "heartbeatIntervalMs": 30000,
    "heartbeatTimeoutMs": 90000,
    "dshRequestTimeoutMs": 120000,
    "wsOpenTimeoutMs": 30000
  }
}
```

Negotiation uses the lower of the server configured limit and the client offered
limit, then checks invariants:

- `maxDecodedChunkBytes <= maxFrameBytes`.
- `lowWaterBytes < highWaterBytes`.
- `highWaterBytes <= maxUncreditedBytesPerTunnel`.
- `maxUncreditedBytesPerSession <= maxUncreditedBytesPerTunnel`.
- heartbeat and timeout values are positive and within configured caps.

Both sides must enforce the negotiated `limits` from welcome.

## 6. HTTP relay frames

The service creates one relay session per browser HTTP request after center auth
and ACL pass.

### 6.1 req

```json
{
  "type": "req",
  "id": "1",
  "method": "POST",
  "path": "/api/session.list",
  "headers": [["content-type","application/json"]],
  "bodyLength": 123
}
```

- `method` is an HTTP token and is uppercased by the service.
- `path` must be origin-form beginning with `/`. Absolute URLs, scheme-relative
  URLs, CRLF, fragments, and invalid UTF-8 are rejected.
- `headers` is an ordered list of lowercase names and string values after the
  Section 12 scrub rules. Duplicates are normalized by policy.
- `bodyLength` is a non-negative safe integer if known, or `null`/omitted for
  unknown streaming length. It is still subject to `maxHttpBodyBytes`.

### 6.2 reqData and reqEnd

```json
{"type":"reqData","id":"1","seq":0,"data":"<base64>"}
{"type":"reqEnd","id":"1","seq":1}
```

The client reconstructs the request body in order and enforces decoded chunk and
total body limits. If `bodyLength` is known, the received total must match. A
mismatch terminates the session with `BAD_REQUEST` or `PROTOCOL_ERROR`.

### 6.3 resp, respData, respEnd

```json
{"type":"resp","id":"1","status":200,"headers":[["content-type","application/json"]],"bodyLength":null}
{"type":"respData","id":"1","seq":0,"data":"<base64>"}
{"type":"respEnd","id":"1","seq":1}
```

The client sends exactly one final `resp` followed by zero or more `respData`
frames and one `respEnd`. Responses must stream to the browser; the service must
not buffer the whole response before writing.

v1.1 does not encode informational 1xx responses as `resp`. The client ignores
100/102/103 and waits for one final response. 101 is allowed only through the
WebSocket upgrade flow in Section 8. HEAD, 204, and 304 final responses must not
send `respData`; if local DSH violates that no-body semantic, the client
terminates the session and records `PROTOCOL_ERROR`. If an error occurs after
browser response headers have been sent, the service may only destroy the
browser response connection; it cannot rewrite a new HTTP status.

### 6.4 cancel

```json
{"type":"cancel","id":"1","reason":"CLIENT_GONE"}
```

Either side may send `cancel` for a live session. Cancellation closes local
request/response streams and releases credit accounting. Duplicate cancel after
termination is ignored.

## 7. Credit flow and backpressure

Data frames consume credit when sent and return credit when bytes are written or
discarded by the receiver:

```json
{"type":"credit","id":"1","bytes":65536,"stream":"req"}
{"type":"credit","id":"1","bytes":65536,"stream":"resp"}
```

Rules:

- Credit is per session and per stream direction, and tunnel-level accounting
  also limits total uncredited bytes across sessions.
- Control frames such as `cancel`, `credit`, `heartbeat`, `pong`, `health`, and
  `bye` must not be blocked behind data-frame credit gates.
- When the tunnel is above `highWaterBytes`, data senders pause. They resume
  after falling below `lowWaterBytes`.
- If capacity does not return within `backpressureTimeoutMs`, the data frame is
  rejected with `LIMIT_EXCEEDED` and the session is cancelled.
- Capacity-aware scheduling must allow smaller sendable sessions to proceed
  around a large waiting frame, and must reserve bytes during wakeup to avoid
  over-subscribing the tunnel account.

## 8. WebSocket relay

The service upgrades a browser WebSocket request only after center auth, ACL, and
origin/fetch checks pass.

### 8.1 wsReq and wsOpen

```json
{
  "type": "wsReq",
  "id": "2",
  "path": "/api/events.mux",
  "headers": [],
  "protocols": ["chat", "json"]
}
```

```json
{"type":"wsOpen","id":"2","protocol":"json","headers":[]}
```

`protocols` is the browser-requested ordered WebSocket subprotocol token list.
The client may choose at most one and return it in `wsOpen.protocol`. The service
must verify that the chosen protocol was offered. v1.1 does not forward
`Sec-WebSocket-Extensions` across the tunnel; per-message compression is off by
default on both sides.

If the browser closes before upstream open, the service sends `cancel`. If local
DSH fails to open within `wsOpenTimeoutMs`, the client returns a session error.

### 8.2 wsData and wsClose

```json
{"type":"wsData","id":"2","direction":"browserToInstance","seq":0,"data":"<base64>","binary":false}
{"type":"wsData","id":"2","direction":"instanceToBrowser","seq":0,"data":"<base64>","binary":true}
{"type":"wsClose","id":"2","direction":"instanceToBrowser","code":1000,"reason":""}
```

Each logical WebSocket message is one or more `wsData` chunks with strict
ordering within its direction. Message boundaries are preserved by the sender.
Decoded message size is bounded by `maxWsMessageBytes`. Close code and reason
must be valid WebSocket values and must not contain secrets or stack traces.

## 9. Heartbeat, pong, and health

The service sends heartbeat at `heartbeatIntervalMs`:

```json
{"type":"heartbeat","seq":10,"sentAt":"2026-08-21T08:00:00.000Z"}
```

The instance replies:

```json
{"type":"pong","seq":10,"sentAt":"2026-08-21T08:00:00.000Z"}
```

`seq` must match the outstanding heartbeat. Duplicate or stale pongs are ignored
or treated as protocol noise; missing pong past `heartbeatTimeoutMs` closes the
tunnel with `INACTIVE_TIMEOUT`.

Health is independent of pong and describes local DSH reachability:

```json
{
  "type": "health",
  "online": true,
  "target": "127.0.0.1:3080",
  "observedAt": "2026-08-21T08:00:00.000Z"
}
```

Health frames are advisory, bounded, and must not include local workspace paths,
request bodies, credentials, or full errors. The service stores the latest
observation for Portal display and metrics.

## 10. Instance diagnostics

M3A adds an owner-only read API:

```http
GET /api/instances/:id/diagnostics
```

The service uses the existing v1.1 `req`/`wsReq` data plane to run whitelisted
read-only probes against the instance-side DSH loopback service. It does not add
new tunnel frame types and does not change hello, token, credit, cancel, or
heartbeat semantics.

Diagnostics may probe root, `session.list`, `workspace.list`, `events.mux`, and
`events.host`, then return bounded summaries. It must not return workspace local
paths, request bodies, raw DSH errors that contain paths, credentials, or
unbounded session/workspace content.

## 11. Browser entry, origins, and fetch metadata

The reliable v1.1 user entry is a full-page instance subdomain:

```text
https://<instanceId>.instances.<baseDomain>/
```

DSH Web builds API URLs from `location.origin`, so path-prefix mounting is not a
supported design. The service maps the instance host to an authorized active
instance after center authentication and ACL.

Instance requests must pass Origin/Fetch Metadata rules before relay session
creation. Same-origin and user-initiated top-level navigations are allowed by
policy; cross-site unsafe requests are rejected. Responses do not add permissive
CORS.

Browser embedding boundary: these Fetch Metadata rules protect instance entries
from cross-site navigation abuse. Real-browser M1C validation showed that Portal
iframe navigation can be rejected by the service with 403 in the current local
topology. That safe JSON 403 response carries `frame-ancestors 'none'`, so the
browser may display a framing/CSP error. This is not a DSH-origin
X-Frame-Options or CSP setting. v1.1 does not require iframe support. The
reliable opening mode is full-page instance entry. If iframe becomes a default
capability later, this section must redefine allowed portal-to-instance
navigation conditions and add cross-site iframe negative tests.

## 12. Header and credential scrubbing

### 12.1 Requests must remove

- hop-by-hop headers: `connection`, `keep-alive`, `proxy-authenticate`,
  `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, and `upgrade`;
- every field named dynamically by the `Connection` header; parse failure
  rejects the request instead of removing only the standard hop-by-hop names;
- center credentials: `cookie`, `authorization`, `proxy-authorization`,
  `remote-user`, `remote-groups`, `remote-email`, `remote-name`,
  `x-authenticated-user`, and all internal proxy keys;
- proxy/edge identity: `forwarded`, `x-forwarded-*`, `x-real-ip`, `via`,
  `cf-*`, `true-client-ip`, and other configured edge headers;
- browser origin headers: `origin`, `referer`, and `sec-fetch-*`;
- WebSocket negotiation headers: `sec-websocket-key`, `sec-websocket-version`,
  `sec-websocket-extensions`, and `sec-websocket-protocol`; subprotocols travel
  only through the structured field in Section 8;
- original `host` and `content-length`.

Then write authority from the verified hello target: IPv4 uses
`host: 127.0.0.1:<targetPort>`, IPv6 uses `host: [::1]:<targetPort>`. If
`bodyLength` is known, recompute local `content-length`; otherwise let the local
HTTP client use chunked transfer.

### 12.2 Responses must remove

- all hop-by-hop headers;
- dynamically named `Connection` fields and original `content-length`; parse
  failure terminates with `PROTOCOL_ERROR`; normal final responses with known
  `bodyLength` have public `content-length` recomputed by the service, while
  unknown lengths stream; HEAD/204/304 do not derive the header from protocol
  body;
- `set-cookie`;
- private headers exposing internal proxies, file paths, or debug
  implementation details;
- security headers that conflict with public Caddy policy unless a clear
  allow/override rule handles them.

v0.1.0 does not forward DSH Cookies.

## 13. Error codes and tunnel close codes

### 13.1 Connection-level errors

| code | Meaning | Client behavior |
| --- | --- | --- |
| `TOKEN_INVALID` | Token does not exist or does not match | Stop and ask owner; do not auto-register |
| `TOKEN_EXPIRED` | Token expired | Stop and enter explicit recovery |
| `TOKEN_REVOKED` | Admin revoked token | Stop immediately; do not auto-recover |
| `TOKEN_ROTATED` | Old token overlap ended for this tunnel | Read persisted new token and reconnect; stop if missing |
| `BAD_PROTO` | Unsupported major version | Stop and upgrade implementation |
| `BAD_MINOR` | Minor version below minimum | Stop and upgrade implementation |
| `MISSING_CAPABILITY` | Required capability missing | Stop and upgrade implementation |
| `BAD_LIMITS` | Limits missing, invalid, or invariant-breaking | Stop and upgrade/fix config |
| `BAD_FRAME` | Illegal frame shape or state transition | Close connection |
| `INACTIVE_TIMEOUT` | No valid frames for too long | May reconnect with exponential backoff |

### 13.2 Session errors

| code | HTTP mapping | Meaning |
| --- | ---: | --- |
| `UPSTREAM_DOWN` | 502 | Local DSH unreachable |
| `UPSTREAM_TIMEOUT` | 504 | Local request/WS timeout |
| `LIMIT_EXCEEDED` | 413/429/503 | Mapped by body, concurrency, or queue type |
| `BAD_REQUEST` | 400 | Invalid method/path/header |
| `PROTOCOL_ERROR` | 502 | Invalid seq, length, or state machine |
| `CLIENT_GONE` | none | Browser disconnected |
| `TUNNEL_CLOSED` | 502 | Tunnel interrupted |

### 13.3 WebSocket application close codes

| close code | Meaning |
| ---: | --- |
| 4401 | token invalid/expired/revoked |
| 4403 | protocol incompatible |
| 4408 | hello/heartbeat/idle timeout |
| 4409 | tunnel replaced by a new connection for the same instance |
| 4410 | old token overlap ended; reconnect with the new token |
| 4413 | frame/message/body over limit |

Close reasons must not contain tokens, user data, or internal exception stacks.

## 14. Reconnect and duplicate connections

- Network errors use exponential backoff with jitter, for example 1s, 2s, 4s,
  up to 60s.
- Reset backoff only after welcome succeeds.
- `TOKEN_INVALID/EXPIRED/REVOKED` and protocol incompatibility stop automatic
  reconnect. Before local `renewalUntil`, `TOKEN_EXPIRED` may prompt the user to
  explicitly run `rotate-token`.
- After authentication, a new tunnel for the same instance may take over the old
  tunnel. If it uses the same valid token, the service first sends
  `bye {code:"TUNNEL_REPLACED"}` to the old connection, cancels its sessions, and
  then registers the new one.
- After token rotation, a correct client uses the new token within overlap to
  take over. The service must send `bye {code:"TOKEN_ROTATED"}` to old-token
  tunnels and reject attempts by old tokens to replace an already-online
  new-token tunnel. Old-token tunnels still online after overlap close the same
  way.
- Takeover does not issue a new token and does not change instance ID.
- Client process restart reconnects only; it does not re-register.

## 15. Security and logging constraints

- Logs must never output registry keys, replacement grants, instance tokens,
  Cookies, Authorization headers, or data/body payloads.
- Shared service/client log helpers must redact credential-shaped values, Bearer
  Authorization, Cookies, and common sensitive fields before stdout/stderr.
  Container log retention is not a redaction mechanism.
- Logs and audit must not output full `Idempotency-Key` values or encrypted
  responses; record only fixed-length key digest prefixes, operation, and result
  code.
- Error text may show only fixed-length public prefixes for credentials.
- External strings such as hostname, version, reason, and path must be
  structurally encoded and length-limited.
- Protocol error messages are not returned raw in Portal HTML.
- Frame parsers set maximum JSON depth/string length and reject prototype
  pollution keys.
- Audit records request ID, instance, namespace, code, bytes, and duration, not
  bodies.
- Test fixtures use dedicated fake tokens and must not copy real credentials.

## 16. Contract-test requirements

HTTPS management plane, service, and client/plugin implementations must cover at
least:

1. namespace creation atomically issues the first key, assigns the creator as
   `namespace_owner`, and enforces input constraints;
2. the same current registry key registers multiple different installation IDs;
3. old registry keys fail after rotation while already issued instance tokens and
   online tunnels are unaffected;
4. both transaction orders for concurrent registry-key rotation and registration,
   plus same-`expectedVersion` concurrent rotation where only one succeeds;
5. token lifetime, renewal grace, overlap boundaries, one successor per token,
   concurrent rotation, old-token tunnel closure at overlap end, and expired
   token tunnel rejection;
6. owner revoke, lost `leave` response retry, replacement creation without state
   mutation, old grant supersede, concurrent grant consumption, and termination
   of all old tokens/tunnels after consumption;
7. hello/welcome, low/high minor, capabilities, `offeredLimits`, final limit
   intersection, and invariants;
8. invalid, expired, and revoked terminal behavior;
9. no body, small body, multi-chunk body, unknown `bodyLength`, length mismatch,
   HEAD/204/304 no body, informational 1xx ignored, and 101 only through WS;
10. rejection of `Expect: 100-continue` and HTTP trailers;
11. response bytes reaching the browser in real time, proving no full buffering;
12. bidirectional WS messages, chunk reassembly, message boundaries,
    subprotocol, UTF-8, and close;
13. browser cancellation propagating to the local request;
14. heartbeat seq match, duplicate/stale pong, pong timeout, and independent
    health reporting;
15. max frame/body/message/session/queue limits;
16. high/low-water pause and resume;
17. credit exhaustion/replenishment, excessive credit, tunnel-level uncredited
    byte cap, and inter-session fairness;
18. tunnel disconnect and duplicate-connection cleanup;
19. stripping Cookie, Authorization, proxy/identity headers, Origin, WS
    extensions, and `Set-Cookie`;
20. rejection of non-loopback targets, cross-site Fetch Metadata, absolute URLs,
    CRLF, and invalid headers;
21. after service restart, instances default to offline while persisted health
    observations display stale/unknown;
22. owner read-only list ACL, stable pagination, field minimization, no
    observation/expired observation behavior, and secret-field exclusion;
23. response-loss replay for all five secret-issuing APIs, same-key different
    request conflict, authenticated ciphertext failure, response-expired
    tombstone, and no duplicate mutation execution.

Mock end-to-end smoke alone is not protocol acceptance. Frame-level state-machine
tests, limit tests, real DSH tests, and memory/backpressure observation are also
required.

## 17. Explicit v1.1 non-goals

- binary tunnel envelopes;
- protocol-level compression;
- resumable transfer;
- P2P;
- headless agent/session control channel;
- DSH Cookie forwarding;
- multi-center tunnel roaming.

## 18. Changelog

- 2026-09-02: synchronized the v0.1.5 G2 multi-user baseline. LLDAP-backed
  invites, namespace roles, member/invite management, system user status,
  role-aware instance ACL, audit list, and instance recovery are Portal/HTTP
  management-plane additions and do not add or change tunnel wire frames.
- 2026-08-30: synchronized the v0.1.3 G13 hosted model/provider settings
  implementation. `deploymentMode` is optional non-secret registration/hello
  metadata for Portal display and local hosted eligibility checks. The model
  settings endpoints are same-origin DSH plugin endpoints and do not add or
  change tunnel wire frames.
- 2026-08-30: synchronized the v0.1.2 large-session history closeout. Request
  clamping, instance-side response normalization, byte-limit diagnostics, and
  browser autoload gating are HTTP adapter/browser-overlay behavior; they do not
  add or change tunnel wire frames.
- 2026-08-28: synchronized the v0.1.1 hosted DSH closeout. The manual hosted
  container template, `/workspace`-restricted picker overlay, and hosted model
  settings limitation are deployment/composition concerns; they do not add or
  change tunnel wire frames.
- 2026-08-26: synchronized the v0.1.0 MVP closeout boundary; plugin-first
  validation, the M3B operations baseline, and follow-up lazy-loading/
  multi-user/admin-console planning do not change `proto: 1` / `minor: 1`.
- 2026-08-21: clarified the target protocol versus implemented subset boundary;
  M1A-1 covered only control-plane/credential/idempotency/termination semantics
  at that time.
- 2026-08-21: synchronized M1A-2 implementation for token rotation,
  replacement grants, client `leave`, `TOKEN_EXPIRED`/`TOKEN_ROTATED` hello
  semantics, and token-aware tunnel takeover.
- 2026-08-21: synchronized M1A-3 implementation for trusted proxy identity,
  three-host routing, instance Origin/Fetch Metadata, origin-form paths,
  loopback targets, and relay header/Cookie/Set-Cookie scrubbing.
- 2026-08-21: synchronized M1A-4 implementation for Portal CSRF/CSP/security
  headers, owner write schemas/reasons, paginated cursors, field minimization,
  `connectionState`/`dshHealth` stale semantics, rate-limit audit, and owner
  revoke audit transactions.
- 2026-08-21: synchronized M1B implementation for required capability and limit
  validation, chunked HTTP/WS data frames, delayed WS upgrade until `wsOpen`,
  browser-to-instance WS direction, cancel, per-session credit, heartbeat/pong,
  and `maxSessions`.
- 2026-08-21: synchronized M1C read-only validation against local
  `@deepseek-ai/dsh@0.1.0-rc.7` for root page, manifest, `session.list`,
  `events.mux`, `events.host`, and HTTP/WS/full-page relay.
- 2026-08-21: synchronized M2 and existing-Caddy deployment findings; Docker,
  Caddy, Authelia, secret-file implementation, TLS, forwarding, and on-demand
  TLS `ask` are deployment boundaries, not tunnel frames.
- 2026-08-22: synchronized remote DSH diagnostics findings: relayed
  `session.list`/`workspace.list` matched direct access, and native picker was a
  DSH host-capability policy result. M3/M4 address this through diagnostics and
  plugin adapters without wire-protocol changes.
- 2026-08-22 through 2026-08-25: synchronized M3A/M4/M3B slices for diagnostics,
  plugin skeleton, remote capability overlay, browser card, tunnel adapter,
  plugin credentials, status/diagnostics, live status bridge, `canOpenPath`
  gating, metrics, alert rules, recovery rehearsal, logging/redaction, and
  plugin install/join CLI. These slices reuse v1.1 and do not add or change
  hello, token, relay, cancel, credit, heartbeat, or health frame semantics.
