# dsh-hub — 中继协议 v1.1

语言：[English](protocol.md) | 简体中文

- 文档版本：v1.1
- 线协议主版本：`proto: 1`
- 线协议 minor：`minor: 1`
- 日期：2026-08-30
- 状态：v0.1.3 G13 为注册、hello 和 Portal 展示新增可选的非秘密实例组合元数据 `deploymentMode`；不新增 tunnel 帧类型、不改变 relay 语义，service/client/plugin 继续使用 `proto: 1`、`minor: 1`
- 关联：`docs/plans/20260821-v0.1.0-requirements.md`、`docs/plans/20260821-v0.1.0-design.md`

> 本文件是 service、client、plugin 的中继线协议唯一事实来源。协议变更必须同时更新本文件、双端实现、契约测试和实施计划状态。

> 说明：本文档描述 v1.1 的目标协议。v0.1.3 G13 只把 `deploymentMode` 用作区分普通远程 plugin 实例和运维托管 hosted DSH composition 的可选非秘密元数据。M2 部署、M3A 诊断、M4 plugin-first 适配、M3B metrics/背压/告警/恢复/日志基线、hosted DSH composition、history 懒加载和 G13 模型设置门控均复用既有 `req/wsReq`、data、credit、cancel、heartbeat/pong 和 health 语义；除非另行评审并更新本文件、双端实现和契约测试，否则不得新增帧或改变既有帧含义。

## 1. 范围和兼容策略

协议连接实例侧 client/plugin 与中心 service。浏览器仍使用普通 HTTP/WebSocket，service 在完成用户认证和 ACL 后把浏览器流量转换为本协议帧。

v1.1 保留 `proto: 1`，但新增 `minor` 和 capability 协商。M1B 前的 prototype “body 内联、无 capability、伪流式”实现属于 v1.0 prototype，不满足本规范。v1.1 service 必须拒绝缺少必需 capability 的旧 client，避免旧实现静默连接后破坏吊销、流式或资源边界。

### 1.1 必需 capabilities

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

minor 增量只能增加可协商能力；改变既有帧含义或安全语义必须提升 `proto` 主版本。proto 1 的 v1.1 service 要求 `minor >= 1`，较低 minor 返回 `BAD_MINOR`；较高 minor 只要包含 service 的全部 required capabilities 即可连接，未知 capability 忽略并记录，不能仅因 minor 较高而拒绝。

## 2. 入口、传输和基本约束

- 注册：`POST https://control.<baseDomain>/api/register`；
- owner 创建 namespace：`POST https://<baseDomain>/api/namespaces`，使用浏览器认证、Origin 和 CSRF；
- owner 更新 namespace registry key：`POST https://<baseDomain>/api/namespaces/<namespaceId>/rotate`，使用浏览器认证、ACL、Origin 和 CSRF；
- token 轮换：`POST https://control.<baseDomain>/api/instances/<instanceId>/tokens/rotate`；
- client 自助吊销：`POST https://control.<baseDomain>/api/instances/<instanceId>/revoke`，使用当前 instance token；
- owner 吊销实例：`POST https://<baseDomain>/api/instances/<instanceId>/revoke`，使用浏览器认证、ACL、Origin 和 CSRF；
- owner 创建 replacement grant：`POST https://<baseDomain>/api/instances/<instanceId>/replacement-grants`，使用浏览器认证、ACL、Origin 和 CSRF，而非控制面 token；
- owner 读取 namespace：`GET https://<baseDomain>/api/namespaces`；
- owner 读取实例：`GET https://<baseDomain>/api/namespaces/<namespaceId>/instances`；
- 隧道：`wss://control.<baseDomain>/agent`；
- TLS 证书必须由实例侧正常验证，生产模式禁止 `rejectUnauthorized:false`；
- tunnel 使用 WebSocket UTF-8 JSON 文本消息，一个 WebSocket message 对应一个协议 envelope；
- 二进制数据放在 `data` 的 base64 中，decoded bytes 受协商限制；
- WebSocket 本身保证 tunnel 消息顺序；不同 session ID 的帧允许交错；同一 ID 的 `seq` 必须严格递增；
- registry key 明文只出现在 namespace 创建/更新 HTTPS 响应和新实例注册 HTTPS 请求中，绝不进入 URL、tunnel 或日志；
- replacement grant 只出现在 owner 创建响应和一次恢复注册 HTTPS 请求中，绝不进入 URL、tunnel 或日志；
- instance token 只出现在 hello 或 token 轮换/自助吊销 HTTPS Authorization 中，不进入日志和普通 relay 帧。

## 3. 注册与凭据管理 HTTPS 接口

本节所有 Portal host 的“精确 Origin”均指可信部署配置中的 Portal public origin；生产为 `https://<baseDomain>`，开发模式可以使用单独显式配置的 `http://...`，不得从请求 Host 或未经验证的转发头临时推导。示例展示生产值。

namespace 创建、实例注册、registry key 更新、instance token 轮换和 replacement grant 创建都会签发不可再次查询的秘密，因此必须携带 `Idempotency-Key`。该值由调用方用密码学安全随机源生成，至少 128 bit，编码为 22..128 个 URL-safe ASCII 字符；service 只保存摘要。幂等作用域由已验证 actor、endpoint operation 和 key 共同确定，请求指纹覆盖 path 参数及规范化 JSON body：

- mutation、请求指纹和原始 HTTP 响应必须在同一数据库事务中提交；响应使用与 token pepper 分离的外部 keyring 做 AES-256-GCM 认证加密，AAD 绑定 actor scope、operation、key digest、request digest 和 status；
- 默认 24 小时内，同作用域、同 key、同请求返回第一次的完全相同 status/body，不重新执行；同 key 不同请求返回 `409 IDEMPOTENCY_CONFLICT`；
- 加密响应过期后删除密文，但默认继续保留 30 天墓碑；同 key 重试返回 `409 IDEMPOTENCY_RESULT_EXPIRED`，绝不重新执行；
- owner 操作的 actor scope 使用规范用户 ID 与目标资源，控制面操作使用已校验的 registry key/grant/token 记录 ID；已更新、已消费、已轮换或已过期凭据只能读取其先前已提交且完全匹配的幂等结果，绝不能借此创建新 mutation；
- 缺少或格式错误的 key 返回 `400 IDEMPOTENCY_REQUIRED/BAD_IDEMPOTENCY_KEY`；client/Portal 必须在首次请求前持久化非秘密的 pending key 和规范化非秘密请求字段，重试复用原字段，并在确认收到结果后删除；凭据本身不得进入该 journal，也不能每次网络重试都生成新 key；
- client 超过响应保留期不得换新 key 自动重试：namespace 创建先查列表，registry key 丢失由 owner 再次显式更新，实例注册/token 轮换丢失走 owner replacement，grant 丢失由 owner 显式创建新 grant；
- revoke 是终止性幂等操作，不签发秘密，不使用上述响应缓存；其响应丢失收敛语义见 §3.5。

### 3.1 owner 创建 namespace

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

该接口位于 Portal host。service 必须验证 Authelia 用户、精确 Origin 和 CSRF，在同一数据库事务中创建单 owner namespace 与首个 active registry key。`name` 为去除首尾空白后的 1..100 个 Unicode 字符，只作显示文本，不参与 Host 或路径解析。

成功响应只显示一次完整 key：

```json
{"namespaceId":"ns_...","registryKey":"dhk_...","prefix":"dhk_abcd","version":1}
```

### 3.2 新实例注册

请求：

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

已绑定实例经 owner 明确批准恢复时，请求改为携带一次性 replacement grant；`registryKey` 与 `replacementGrant` 必须二选一：

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

成功响应：

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

规则：

- `installationId` 由本地首次 join 生成并稳定保存，固定为 `insl_` 加 128 bit 随机值的 base64url 无填充编码（22 字符，总长 27）；丢失后不能用 replacement grant 恢复原实例；
- `instanceId` 由 service 生成，固定为 `inst-` 加 128 bit 随机值的 RFC 4648 小写无填充 base32（26 字符，总长 31，字母表 `a-z2-7`），并作为实例子域 label；
- instance ID 使用密码学安全随机源并以数据库唯一约束防碰撞；极小概率冲突时重新生成，不得覆盖已有实例；
- `delivery` 只能是 `agent` 或 `plugin`；`deploymentMode` 是可选非秘密组合元数据，可为 `remote` 或 `hosted`，非法或缺失值按未提供处理，不导致注册失败；`hostname` 去除首尾空白后为 1..253 个 UTF-8 bytes，`clientVersion`/`dshVersion` 为 `null` 或 1..64 个可打印 ASCII 字符，均拒绝控制字符；
- `(namespaceId, installationId)` 已绑定时，registry key 不得静默覆盖，返回 `409 INSTANCE_ALREADY_BOUND`；
- 每个 namespace 只有一个当前有效 registry key；同一个当前 key 可注册多个不同 installation ID，成功注册不消费或改变 key；
- owner 更新 registry key 后旧版本立即不能再注册；无效或已更新的 key 统一返回 `401 INVALID_REGISTRY_KEY`，响应不泄露具体原因；
- registry key 更新与注册并发时以数据库事务提交顺序为准：注册先提交则新 instance token 有效，更新先提交则旧 key 注册失败；更新永远不影响已经提交签发的 instance token；
- replacement grant 由 Portal 上已通过 ACL/CSRF 校验的 owner 签发，绑定 namespace、原 instance ID 和 installation ID，短期且只允许原子消费一次；创建 grant 不改变实例或 token；
- replacement grant 消费事务必须保持原 instance ID、把实例恢复为 active、吊销全部旧 token、签发新 token 并标记 grant 已使用；提交后 service 立即关闭旧 tunnel 和全部关联 session；
- 无效、过期、已使用、已 supersede 或绑定不匹配的 grant 统一返回 `401 INVALID_REPLACEMENT_GRANT`；管理员吊销不会自动签发 grant；
- 注册端点必须按来源和 namespace 限流并写审计；成功后 client 默认不保存 registry key 或 replacement grant。

### 3.3 namespace registry key 更新

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

该接口位于 Portal host，必须验证 Authelia 用户、namespace owner ACL、Origin 和 CSRF。`expectedVersion` 必须是调用方最后从创建/列表响应得到的正整数；服务端在单个数据库事务中匹配当前 active 版本，把旧 key 标记为 `rotated` 并创建唯一的 `active` 新 key。不匹配返回 `409 REGISTRY_VERSION_CONFLICT` 且不签发 key。成功响应只显示一次 `registryKey`、`prefix`、`version` 和 `rotatedAt`。

更新只改变后续 `/api/register` 对 registry key 的校验结果；已经签发的 instance token、在线 tunnel 和 instance 状态均不得改变。旧 key 的摘要与版本只为审计保留，不能恢复为 active。

### 3.4 instance token 轮换

```http
POST /api/instances/<instanceId>/tokens/rotate
Authorization: Bearer <current-instance-token>
Idempotency-Key: <random-idempotency-key>
```

成功响应：

```json
{
  "instanceToken":"dht_...",
  "instanceTokenExpiresAt":"2026-09-20T00:00:00.000Z",
  "instanceTokenRenewalUntil":"2026-09-27T00:00:00.000Z",
  "overlapUntil":"2026-08-21T08:05:00.000Z"
}
```

初始默认 token TTL 为 30 天、renewal grace 为 7 天、旧 token overlap 为 5 分钟。所有期限以 service 时钟为权威。当前有效 token 或处于 `expiresAt < now <= renewalUntil` 的过期 token 可以轮换；grace 内过期 token 只能调用本端点，不能连接 tunnel。超过 `renewalUntil` 返回 `401 TOKEN_EXPIRED`，管理员已吊销的 token 永远不能轮换。

若旧 token 轮换时仍有效，`overlapUntil = min(now + configuredOverlap, old.expiresAt)`；若已过期，`overlapUntil = now`。client 必须先原子持久化新 token，再以新 token 建立接管 tunnel。service 跟踪 tunnel 使用的 token ID，并在 `overlapUntil` 到达时向仍使用旧 token 的 tunnel 发送 `bye {code:"TOKEN_ROTATED"}`、取消其 session 并关闭连接；这不改变 instance ID。

轮换事务必须在当前 token 行记录唯一 `rotatedToTokenId` 和固定 `overlapUntil`。同一 token 使用相同幂等键重试按 §3 重放；不同幂等键的并发/后续请求只有第一个可签发后继，其余返回 `409 TOKEN_ALREADY_ROTATED`，不得形成分叉 token 链。

主要错误：

- `401 TOKEN_INVALID`
- `401 TOKEN_EXPIRED`
- `403 TOKEN_REVOKED`
- `404 INSTANCE_NOT_FOUND`

管理员重新启用使用 portal 的 owner 授权流程，不复用本端点。

### 3.5 instance 自助吊销与 owner 吊销

client `leave` 使用 control host：

```http
POST /api/instances/<instanceId>/revoke
Authorization: Bearer <current-instance-token>
```

Portal owner 使用 Portal host 的相同 path，不使用 Bearer token：

```http
POST /api/instances/<instanceId>/revoke
Content-Type: application/json
Origin: https://<baseDomain>
X-CSRF-Token: <portal-csrf-token>
```

```json
{"reason":"operator revoked this installation"}
```

owner 请求必须携带 1..200 字符的审计原因。两种调用都必须在事务中把 instance 标记为 `revoked`、吊销全部 token；owner 调用的成功审计必须与吊销同事务提交，审计失败时不得让吊销静默生效。提交后发送 `bye {code:"TOKEN_REVOKED"}`、关闭 tunnel 并取消全部 session。成功返回 `204 No Content`。

自助吊销要求 Bearer token 当前有效且绑定 path 中的 instance ID。响应成功后 client 才清理本地 instance token；若响应丢失，重试可能得到 `TOKEN_REVOKED`，client 可通过本地 instance ID 将其视为已达到 leave 目标并清理凭据。installation ID 保留用于诊断和 owner 授权恢复。

### 3.6 owner replacement grant

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

该接口位于 Portal host，必须先验证 Authelia 用户、instance owner ACL、精确 Origin 和 CSRF。请求必须包含 1..200 字符的审计原因。成功响应只显示一次 `replacementGrant` 和 `expiresAt`，默认有效期 10 分钟；同一事务必须先把同实例此前 `status='outstanding'` 的记录（包括已到期但尚未清理者）标记为 `superseded`，再创建新的 outstanding grant，并由数据库唯一约束保证每实例最多一个。服务端只保存带类型域分离的摘要、绑定关系、签发人、原因和消费状态。grant 不得出现在 URL、审计 details 或非幂等重放的查询响应中。

### 3.7 owner 只读列表

```http
GET /api/namespaces?limit=50&cursor=<opaque>
GET /api/namespaces/<namespaceId>/instances?limit=50&cursor=<opaque>
```

两个端点都位于 Portal host，使用 Authelia 浏览器身份并执行 owner ACL；GET 不要求 CSRF，允许缺少 Origin，但若携带 Origin 则必须精确匹配 Portal public origin。响应不设置跨 origin CORS。`limit` 默认 50、范围 1..100；`cursor` 是 service 签发的不透明值，按 `(createdAt DESC,id DESC)` 稳定排序，非法 cursor 返回 `400 BAD_CURSOR`。namespace 列表只返回当前用户拥有的 namespace；实例列表在 namespace 不存在或不归当前用户时统一返回 404，避免跨 owner 枚举。

namespace 响应示例：

```json
{
  "items": [
    {
      "namespaceId": "ns_...",
      "name": "My namespace",
      "registryKey": {"prefix":"dhk_abcd","version":2,"issuedAt":"2026-08-21T08:00:00.000Z"},
      "createdAt": "2026-08-21T07:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

实例响应示例：

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

`connectionState` 只根据当前 service 进程的 tunnel registry 计算。`dshHealth.observedAt` 使用 service 接收 health 的时钟；没有观测时整个 `dshHealth` 为 `null`，超过 `healthStaleAfterMs`（默认 90,000ms）后 `freshness="stale"`，否则为 `fresh`。`latestToken*` 只描述最新未吊销 token，可为 `null`，不改变实例管理状态。

任何列表响应都不得包含 registry key 明文或 digest、replacement grant、instance token 明文或 digest、pepper key ID、installation ID、Authelia 身份头、内部数据库 ID 或 `id/status` 兼容别名。

### 3.8 HTTPS 错误格式

本节管理接口的非 2xx 响应统一使用 JSON；自动行为只依据稳定 `code`，不得解析 `message`：

```json
{
  "error": {
    "code": "TOKEN_EXPIRED",
    "message": "instance credential is expired",
    "requestId": "req_..."
  }
}
```

`message` 不得包含凭据、摘要、绑定关系或数据库细节。认证失败按各端点规定使用 401/403，资源不存在或 owner 无权访问统一使用 404，输入错误使用 400，状态/幂等冲突使用 409，限流使用 429 并返回 `Retry-After`，服务故障使用 5xx。Content-Type 非 `application/json` 的写请求返回 415；格式错误或超出配置 body 上限返回 400/413，且不得进入 mutation 事务。

管理请求 JSON body 上限默认为 16 KiB、嵌套深度不超过 8；重复键、危险原型键、非 UTF-8、非有限数字或 schema 外字段一律返回 400。所有显示字符串去除首尾空白后再校验长度并拒绝 C0 控制字符。

网络失败、429 或 5xx 可以按 `Retry-After`/指数退避重试，但秘密签发操作必须复用同一 pending idempotency key 和原请求字段。未知 4xx/code 默认停止并提示人工核对状态；任何错误路径都不得自动换新 key 重做 mutation。

## 4. Envelope 通用格式

```json
{
  "type": "reqData",
  "id": "1",
  "seq": 0,
  "data": "<base64>"
}
```

通用规则：

- `type`：必需、大小写敏感、必须在协商后的帧集合中；
- `id`：relay session 标识，由 service 分配；hello/heartbeat/health 等连接级帧没有 id；
- `id` 最长 64 个 ASCII 字符，单条 tunnel 内唯一，终止后不得复用；
- `seq`：HTTP 请求流和响应流分别从 0 递增，终止帧使用下一个序号；每个 WS 逻辑 message 单独从 0 递增；不得重复、跳号或倒序；
- 所有对象拒绝危险原型键和超出限制的嵌套/字符串；
- 未知 type、字段类型错误、超限 envelope 或无 id 的 session 帧属于 `BAD_FRAME`；
- session 级错误终止该 session；连接级协议错误发送 fatal `error` 后关闭 tunnel。

## 5. 握手

实例连接 `/agent` 后，必须在 `helloTimeoutMs` 内发送且只能发送一个 hello。该超时在 welcome 前由 service 配置并执行，v0.1.0 默认 10,000ms，部署只能调低或经评审后调高。

> 实施边界：M1A-3 已落地 target loopback 安全约束和发往 DSH 的 Host rewrite；M1B 已把 hello 升级为 v1.1 object target、required capabilities 与 `offeredLimits`/`welcome.limits` 协商。旧字符串 target 只属于 M1A 之前的兼容历史，不再作为当前协议完成口径。

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
  "token": "<instance-token>",
  "instanceId": "inst-...",
  "installationId": "insl_<22-char-base64url>",
  "delivery": "agent",
  "deploymentMode": "hosted",
  "hostname": "macbook.example",
  "clientVersion": "0.1.0",
  "dshVersion": "0.1.0-rc.7",
  "target": { "host": "127.0.0.1", "port": 3080 },
  "offeredLimits": {
    "maxTunnelMessageBytes": 524288,
    "maxChunkDecodedBytes": 262144,
    "maxHeaderBytes": 65536,
    "maxPathBytes": 8192,
    "maxHttpBodyBytes": 33554432,
    "maxWsMessageBytes": 8388608,
    "maxSessions": 64,
    "maxPendingSessions": 16,
    "initialStreamCreditBytes": 8388608,
    "maxUncreditedBytesPerTunnel": 16777216,
    "highWaterBytes": 8388608,
    "lowWaterBytes": 2097152,
    "backpressureTimeoutMs": 30000,
    "requestIdleTimeoutMs": 120000,
    "wsOpenTimeoutMs": 10000
  }
}
```

规则：

- service 以 token 的服务端绑定关系确定实例，不能信任 hello 自报 instance ID；二者不一致时拒绝；
- hello 只接受未吊销、`now <= expiresAt` 且尚未轮换或 `now < overlapUntil` 的 token；已过期返回 `TOKEN_EXPIRED`，已越过 overlap 返回 `TOKEN_ROTATED`。renewal grace 只适用于 HTTPS token 轮换，不能扩大 tunnel 有效期；
- `installationId` 必须与实例记录一致；
- `delivery` 只能是 `agent` 或 `plugin`，且应与注册记录一致；
- `deploymentMode` 是可选非秘密组合元数据，service 只记录 `remote` 或 `hosted`；hello 中非法或缺失值不得清除此前已记录的合法模式。hosted-only 能力仍必须验证本机 hosted eligibility，不能把该元数据当作授权依据；
- target host 只允许规范 loopback：`127.0.0.1` 或 `::1`；禁止域名解析、LAN、Unix socket 和任意内网地址；
- port 为 `1..65535`；plugin 从同进程 `ctx.webServer.port` 取得，client 默认 3080；
- `offeredLimits` 必须完整包含 §5.2 `limits` 的全部 v1.1 字段，值均为正的 JSON safe integer；缺项、类型错误、超范围或违反 §5.2 不变量返回 `BAD_LIMITS`；未知字段按 minor/capability 兼容规则忽略并记录；
- token 被吊销时 client 必须停止，不能携 registry key 自动注册。

### 5.2 welcome

```json
{
  "type": "welcome",
  "proto": 1,
  "minor": 1,
  "instanceId": "inst-...",
  "serverVersion": "0.1.0",
  "serverTime": 1787296800000,
  "requiredCapabilities": ["http-chunk-v1", "cancel-v1", "ws-bidi-chunk-v1", "heartbeat-v1", "limits-v1", "credit-flow-v1"],
  "heartbeatIntervalMs": 20000,
  "pongTimeoutMs": 45000,
  "inactiveTimeoutMs": 60000,
  "limits": {
    "maxTunnelMessageBytes": 524288,
    "maxChunkDecodedBytes": 262144,
    "maxHeaderBytes": 65536,
    "maxPathBytes": 8192,
    "maxHttpBodyBytes": 33554432,
    "maxWsMessageBytes": 8388608,
    "maxSessions": 64,
    "maxPendingSessions": 16,
    "initialStreamCreditBytes": 8388608,
    "maxUncreditedBytesPerTunnel": 16777216,
    "highWaterBytes": 8388608,
    "lowWaterBytes": 2097152,
    "backpressureTimeoutMs": 30000,
    "requestIdleTimeoutMs": 120000,
    "wsOpenTimeoutMs": 10000
  }
}
```

示例数字是 v0.1.0 的初始安全上限，不是性能承诺；实现和部署可以降低，任何提高必须经过真实 DSH 压测。service 对每个字段取部署上限与 hello `offeredLimits` 的较小值，校验后把唯一最终结果放入 `welcome.limits`；两端此后只执行该结果，不得各自再缩小而形成不同状态机。所有值必须为正的 JSON safe integer，并满足：`heartbeatIntervalMs < pongTimeoutMs < inactiveTimeoutMs`、`lowWaterBytes < highWaterBytes <= maxUncreditedBytesPerTunnel`、`initialStreamCreditBytes >= maxWsMessageBytes`、`maxUncreditedBytesPerTunnel >= maxWsMessageBytes`，且 `maxTunnelMessageBytes` 足以容纳一个最大 decoded chunk 的 base64 JSON envelope。最终交集不满足任一不变量时以 `BAD_LIMITS` 拒绝握手。

### 5.3 握手失败

```json
{"type":"unauthorized","code":"TOKEN_REVOKED","message":"instance authorization rejected"}
```

或：

```json
{"type":"error","code":"MISSING_CAPABILITY","message":"required protocol capability is missing","fatal":true}
```

发送失败帧后，service 使用 §13 的应用 close code 关闭连接。错误消息不得回显 token 或数据库细节。

## 6. 帧类型总表

| type | 方向 | 级别 | 说明 |
|---|---|---|---|
| `hello` | C→S | connection | 首帧握手 |
| `welcome` | S→C | connection | 握手成功和限制协商 |
| `unauthorized` | S→C | connection | token/instance 拒绝，随后关闭 |
| `error` | 双向 | both | session 或 fatal 错误 |
| `heartbeat` | C→S | connection | 应用层心跳 |
| `pong` | S→C | connection | 心跳应答 |
| `health` | C→S | connection | 本地 DSH 健康状态 |
| `bye` | 双向 | connection | 优雅关闭或管理终止 |
| `req` | S→C | session | HTTP 请求头 |
| `reqData` | S→C | session | HTTP 请求体块 |
| `reqEnd` | S→C | session | HTTP 请求体结束 |
| `resp` | C→S | session | HTTP 响应头 |
| `respData` | C→S | session | HTTP 响应体块 |
| `respEnd` | C→S | session | HTTP 响应结束 |
| `wsReq` | S→C | session | 浏览器 WS upgrade 请求 |
| `wsOpen` | C→S | session | 本地 WS 已建立 |
| `wsData` | 双向 | session | 分块后的一个 WS message |
| `wsEnd` | 双向 | session | WS 正常/异常关闭 |
| `cancel` | 双向 | session | 取消 HTTP 或尚未完成的 WS 建连 |
| `credit` | 双向 | session | 接收端补充指定数据方向的可发送字节额度 |

### 6.1 `error`、`unauthorized` 与 `bye`

- connection fatal error：`{"type":"error","code":"BAD_PROTO","message":"...","fatal":true}`，没有 `id`，发送后关闭 tunnel；
- session error：`{"type":"error","id":"1","code":"UPSTREAM_DOWN","message":"...","retryable":true,"fatal":false}`，对该 session 为 terminal，不关闭健康 tunnel；
- `unauthorized` 只用于 hello 的 token/instance 拒绝，字段为 `type/code/message`，随后以 4401 关闭；
- `bye` 字段为 `type/code/message?`，用于 `TOKEN_REVOKED`、`TOKEN_ROTATED`、`TUNNEL_REPLACED`、`INACTIVE_TIMEOUT` 和 `SERVER_SHUTDOWN`；收到后先终止全部 session，再按 §13/§14 决定停止或重连；
- `message` 只供诊断，自动行为只能依据稳定 `code`；未知 code 默认停止并记录，不得猜测为可重试。

## 7. HTTP 中继

### 7.1 请求

```json
{"type":"req","id":"1","method":"POST","path":"/api/example?x=1",
 "headers":{"content-type":["application/json"],"host":["127.0.0.1:3080"]},
 "bodyLength":1048576}
{"type":"reqData","id":"1","seq":0,"data":"<base64>"}
{"type":"reqData","id":"1","seq":1,"data":"<base64>"}
{"type":"reqEnd","id":"1","seq":2,"bytes":1048576}
```

无 body 时仍发送 `reqEnd {seq:0, bytes:0}`，使终止语义唯一。

规则：

- `path` 必须是 UTF-8 长度不超过 `maxPathBytes` 的 origin-form，以恰好一个 `/` 开头；拒绝 `//` authority、scheme、fragment、反斜杠、无效 percent encoding，以及原文或 percent decode 后的 NUL/CR/LF/其它 C0 控制字符；验证后保留原始 path/query 字节语义，不做会改变路由的二次规范化；
- method 必须是下列精确大写 token：GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS；TRACE/CONNECT 及未列出方法返回 405，不建立 relay session；
- headers 键为小写 ASCII，值为不含 NUL/CR/LF 的字符串数组；请求和响应各自的总 header bytes 不超过 `maxHeaderBytes`；
- relay header 最多 128 个名称、每个名称最多 128 ASCII bytes、每个值最多 8192 UTF-8 bytes、所有数组合计最多 256 个值；`maxHeaderBytes` 按每个值的 `UTF8(name) + UTF8(value) + 4` 求和，避免两端计算口径不同；
- `bodyLength` 可选；若存在，累计 decoded bytes 必须完全一致；`bodyLength` 与 `reqEnd.bytes` 均为非负 JSON safe integer，`reqEnd.bytes` 必须等于实际累计 decoded bytes；请求和响应各自累计 body 不得超过 `maxHttpBodyBytes`；
- client 收到 `req` 后立即创建本地请求，随 `reqData` 到达逐块写入，不得等待 `reqEnd` 后再完整发送；
- v1.1 不转发 HTTP trailers 或 `Expect: 100-continue`；检测到 `Expect` 时返回 417，trailers 被拒绝为 `BAD_REQUEST`；
- 超限、seq 错误或 bodyLength 不匹配发送 terminal `error` 并销毁本地请求。

### 7.2 响应

```json
{"type":"resp","id":"1","status":200,"statusText":"OK",
 "headers":{"content-type":["application/json"]},"bodyLength":2048}
{"type":"respData","id":"1","seq":0,"data":"<base64>"}
{"type":"respEnd","id":"1","seq":1,"bytes":2048}
```

client 在收到本地最终响应头后立即发送 `resp`；每个本地 response chunk 按限制切分并发送 `respData`，不能 `Buffer.concat()` 完整响应。service 收到 `resp` 后立即向浏览器写响应头，随后流式写 body。

`resp.status` 必须是 200..599 的整数，`statusText` 是 UTF-8 不超过 256 bytes 且不含 C0 控制字符的字符串，headers 遵守 §12 的小写数组和总大小限制。可选 `bodyLength` 与最终 decoded bytes、`respEnd.bytes` 必须一致；无 `bodyLength` 时 `respEnd.bytes` 仍必须等于实际累计 decoded bytes。

v1.1 不把 informational 1xx 编码为 `resp`：client 忽略 100/102/103 等临时响应，等待并只转发一个最终响应；101 只允许走 §8 WebSocket upgrade 流程。HEAD、204 和 304 最终响应不得发送 `respData`；若本地 DSH 违反无 body 语义，client 终止该 session 并记录 `PROTOCOL_ERROR`。浏览器响应头已经发送后再发生错误时，service 只能销毁浏览器响应连接，不能改写为新的 HTTP 状态码。

### 7.3 HTTP 终止

- `respEnd`：正常终止；
- `error {id,...}`：异常终止；
- `cancel {id,...}`：对端取消；
- tunnel 关闭：所有 session 异常终止。

四者任一发生后，session ID 进入终止态，后续同 ID 帧视为 `LATE_FRAME` 并忽略/计数；不得重新创建。

## 8. WebSocket 中继

### 8.1 建连

service 收到浏览器 upgrade 后先完成用户身份、ACL、Host 和 Origin 校验，暂不向浏览器返回 101：

```json
{"type":"wsReq","id":"2","path":"/api/events.mux",
 "headers":{"host":["127.0.0.1:3080"]},"protocols":[]}
```

client 成功连接本地 DSH WS 后返回：

```json
{"type":"wsOpen","id":"2","status":101,"statusText":"Switching Protocols","protocol":null,"headers":{}}
```

service 此时才完成浏览器侧 upgrade。失败时 client 返回：

```json
{"type":"error","id":"2","code":"UPSTREAM_DOWN","message":"local websocket unavailable","retryable":true}
```

service 在 upgrade 尚未完成时返回 HTTP 502/504。超过 `wsOpenTimeoutMs` 发送 `cancel` 并返回 504；若浏览器/Caddy 在 `wsOpen` 前已关闭原始 upgrade socket，service 必须立即清理 pending session，并向 client 发送 `cancel(CLIENT_GONE)`，不得继续等到 `wsOpenTimeoutMs` 后误记为上游超时。

若本地 DSH WS 在 `wsOpen` 前关闭，client 必须把它转换为 `error(UPSTREAM_DOWN)`，不得发送正常 `wsEnd`；service 在 pending upgrade 状态收到 `error`、`wsErr` 或兼容旧 client 的 pre-open `wsEnd` 时必须立即拒绝浏览器 upgrade（通常为 502），不得等待 `wsOpenTimeoutMs` 超时。

`wsReq.path` 适用 §7.1 的 `maxPathBytes`、origin-form 和控制字符规则；`headers` 适用相同 header 数量/大小限制以及 §12 清洗规则。upgrade/connection/key/version/extensions/protocol 原始头不得进入 relay headers，subprotocol 只能使用结构化 `protocols` 字段。

### 8.2 双向 WS message

一个逻辑 WS message 可以拆成多个 `wsData`：

```json
{"type":"wsData","id":"2","messageId":7,"seq":0,"final":false,"binary":false,"data":"<base64>"}
{"type":"wsData","id":"2","messageId":7,"seq":1,"final":true,"binary":false,"data":"<base64>"}
```

规则：

- `messageId` 是单方向 session 内从 0 开始、每个逻辑消息加 1 的 JSON safe integer；不得跳号或复用；每个 message 的 `seq` 从 0 开始；
- 同一 message 的 `binary` 必须一致；
- 接收端按 seq 重组，在 `final:true` 时向本地 WS 发送恰好一个逻辑 message；
- 重组累计值不得超过 `maxWsMessageBytes`；
- 同一方向同一时刻只允许组装一个未完成 message，避免无界交错缓冲；
- browser→instance 和 instance→browser 使用完全相同语义；
- DSH 当前两个事件 WS 主要为下行流，但协议实现仍必须正确支持双向。
- `protocols` 是浏览器请求的有序 WebSocket subprotocol token 数组；client 只可从中选择一个并在 `wsOpen.protocol` 返回，service 必须验证选择确实被提供；v1.1 不跨 tunnel 转发 `Sec-WebSocket-Extensions`，两侧 per-message compression 默认关闭；
- `protocols` 最多 16 项，每项是 1..128 ASCII bytes 的合法 WebSocket token，不得重复；非法列表在创建本地 WS 前以 `BAD_REQUEST` 终止；
- `binary:false` 的完整消息必须是合法 UTF-8；非法文本以 `PROTOCOL_ERROR` 终止 session。

### 8.3 关闭

```json
{"type":"wsEnd","id":"2","code":1000,"reason":""}
```

`wsOpen` 完成后，任一方向收到本地 WS close 才发送一次 `wsEnd`。接收 `wsEnd` 后关闭对应本地 WS，不再回发第二个 `wsEnd`。code/reason 必须符合 WebSocket 规范和长度限制。

`reason` 按 UTF-8 编码后最长 123 bytes；非法 close code 或 reason 以 `PROTOCOL_ERROR` 终止 session。

## 9. 取消

```json
{"type":"cancel","id":"1","code":"CLIENT_GONE","message":"browser request closed"}
```

主要 code：

- `CLIENT_GONE`：浏览器 HTTP/WS 已断开；
- `TIMEOUT`：空闲或建连超时；
- `LIMIT_EXCEEDED`：达到 body、message、队列或并发上限；
- `SERVER_SHUTDOWN`：service 优雅停止；
- `TUNNEL_REPLACED`：同实例新连接接管。

接收方必须销毁本地 HTTP request/response stream 或未完成 WS，并释放缓冲和 session 表。cancel 是 terminal，幂等处理；未知或已终止 ID 只记指标。

## 10. 心跳和健康

```json
{"type":"heartbeat","seq":7,"sentAt":1787296800000}
{"type":"pong","seq":7,"sentAt":1787296800000,"serverTime":1787296800005}
{"type":"health","dshOnline":true,"dshVersion":"0.1.0-rc.7","checkedAt":1787296800000}
```

- client 按 welcome 的 `heartbeatIntervalMs` 发送 heartbeat；`seq` 是从 0 单调递增的 JSON safe integer，单连接内不得复用；
- service 收到后立即原样回显 `seq` 和 `sentAt` 并附加 `serverTime`；任意有效帧都以 service 接收时钟更新运行态 `lastSeen`；
- client 只接受与已发送且尚未确认的 `seq` 匹配的 pong；超过 `pongTimeoutMs` 未收到匹配 pong 时主动关闭 tunnel，并按网络错误指数退避重连；未知、重复或旧 pong 不得刷新等待状态；
- 超过 `inactiveTimeoutMs` 未收到有效帧，service 以 `bye {code:"INACTIVE_TIMEOUT"}` 关闭；
- health 默认每 30 秒或状态变化时发送；health 不是 heartbeat 的替代品；
- `dshOnline` 只表示本地 DSH 探测结果，不等同于 tunnel online；
- `checkedAt` 使用 client 时钟，仅作信息展示；service 必须另外以自身接收时钟持久化 `lastDshObservedAt/lastSeenAt`，排序、过期和 stale/unknown 判定不得依赖 client 时钟；
- health 不携带凭据、路径、workspace 或用户数据。

## 11. 流控、资源限制和公平性

### 11.1 分块

- 每个 data frame 解码后不得超过 `maxChunkDecodedBytes`；
- `data` 必须是 RFC 4648 标准 alphabet、带规范 padding、无空白的 canonical base64；接收方先按字符串长度估算上界，超限或解码后重新编码不一致均以 `BAD_FRAME` 拒绝；
- 发送方必须在编码前切块，接收方必须在分配大缓冲前检查 base64 长度上界；
- `maxTunnelMessageBytes` 同时限制序列化 JSON message。

### 11.2 背压

- 每个 `reqData`、`respData` 和每方向 `wsData` 流初始拥有 `initialStreamCreditBytes`；发送 decoded data 前必须扣减相同字节数，额度不足时暂停对应本地 readable，禁止先读入自建数组；
- 接收端只有在 decoded bytes 已写入下游并离开协议拥有的队列/重组缓冲后，才发送 `credit` 补回相同字节数；HTTP 以本地 writable 完成/`drain` 为准，WS 以完整逻辑 message 交付本地 socket 为准；
- 任一发送端在该 tunnel 上所有已发送但尚未获 credit 补回的数据之和不得超过 `maxUncreditedBytesPerTunnel`；接收端按相同上限约束协议缓冲。该总上限优先于单流额度；M1B 已实现 per-session credit，M3B-3B 已实现 sender 侧 tunnel 级总账，M3B-3C 已实现 sender 等待队列公平调度；
- `credit` 示例：`{"type":"credit","id":"1","stream":"req","bytes":262144}`；`stream` 只能是 `req`、`resp`、`ws-c2i`、`ws-i2c`，`bytes` 必须为正整数且不得使额度超过初始值；
- cancel、error、bye、heartbeat 和 pong 不消耗数据 credit，必须能在数据流暂停时继续处理；
- tunnel WebSocket `bufferedAmount >= highWaterBytes` 时提供第二层传输背压；降至 `lowWaterBytes` 后才恢复发送；M3B-3B 已在 service 与 client/plugin 共用发送路径上执行该门控；
- 高水位持续超过 `backpressureTimeoutMs` 则以 `LIMIT_EXCEEDED` 终止当前发送 session；无法归因或释放后仍持续超限时关闭异常 tunnel。M3B-3B 已覆盖当前发送 session 的超时拒绝，异常 tunnel 关闭策略、生产阈值调优和长时压测仍留后续 M3B；
- 暂停期间不得继续把本地流读入自建数组。重复、超额、未知 stream 或已终止 session 的 credit 属于协议错误并计数；M1B 覆盖 canonical frame、正整数 credit 和正常补回路径，异常 credit 账本测试留给 M3。

### 11.3 会话和队列

- 已建立 session 不超过 `maxSessions`；
- 等待分配/建连的不超过 `maxPendingSessions`；
- `requestIdleTimeoutMs` 是 session 无协议帧、下游写入或 drain 等可观测进展的最长时间；纯粹处于 backpressure 状态时优先适用更短的 `backpressureTimeoutMs`；
- 超限的新请求返回 429/503，并使用 `LIMIT_EXCEEDED` 审计；
- 实现应在实例之间公平调度，单个大响应不能饿死其他 session；M3B-3C 的 sender 等待队列已按容量和 session 做调度，队首大 frame 暂时放不下时允许后续可发送的小 session 先通过；
- 不得为每个 session 建立无界 pending frame 数组。

## 12. Header 和路径安全

中心在浏览器请求通过用户认证、ACL、Host/Origin 校验后，才生成 relay headers。

Origin 规则：service 依据可信部署配置计算该实例唯一的 public origin；生产值为 `https://<instanceId>.instances.<baseDomain>`，开发模式只允许显式配置的 `http://...` 值，不能从不可信 Host 或转发头临时推导。请求只能携带一个 Origin；service 解析后按 `(小写 scheme, 小写 DNS host, effective port)` 元组比较，拒绝 `null`、多值、userinfo、path/query/fragment 和解析失败，不能用前缀/后缀字符串匹配。instance WS 及除 GET/HEAD 外的所有 HTTP 方法必须携带且匹配该值；GET/HEAD 可以不带 Origin，但任意非法/不匹配 Origin 或 `Sec-Fetch-Site: cross-site` 一律在创建 session 前返回 403。TRACE/CONNECT 在 Origin 判断前直接返回 405。v0.1.0 不返回允许第三方 origin 的 CORS 响应头。

浏览器嵌入边界：上述 Fetch Metadata 规则优先保护实例入口免受跨站导航滥用。M1C 真实浏览器验证表明，Portal iframe 导航在当前本地拓扑下会被 service 以 403 拒绝；该 403 的 JSON 安全响应携带 `frame-ancestors 'none'`，浏览器会显示 framing/CSP 错误，但这不是 DSH 原站设置的 X-Frame-Options 或 CSP。v1.1 协议不把 iframe 作为必需能力；可靠打开方式是整页实例入口。若未来要把 iframe 提升为默认能力，必须在本节重新定义允许的 portal→instance 导航条件，并补跨站 iframe 负向测试。

### 12.1 请求必须删除

- hop-by-hop：`connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`；
- 删除 `Connection` 头中动态点名的全部字段；解析失败时拒绝请求，不能只删除标准 hop-by-hop 名称；
- 中心认证：`cookie`、`authorization`、`proxy-authorization`、`remote-user`、`remote-groups`、`remote-email`、`remote-name`、`x-authenticated-user`、所有内部代理密钥；
- 代理/边缘身份：`forwarded`、`x-forwarded-*`、`x-real-ip`、`via`、`cf-*`、`true-client-ip` 及部署配置的其它边缘头；
- 浏览器来源：`origin`、`referer`、`sec-fetch-*`；
- WebSocket 协商：`sec-websocket-key`、`sec-websocket-version`、`sec-websocket-extensions`、`sec-websocket-protocol`，subprotocol 只能通过 §8 的结构化字段传递；
- 原始 `host` 和 `content-length`。

随后按 hello 中已验证的 target 写入 authority：IPv4 为 `host: 127.0.0.1:<targetPort>`，IPv6 为 `host: [::1]:<targetPort>`；已知 bodyLength 时重算本地 `content-length`，未知时由本地 HTTP client 使用 chunked transfer。

### 12.2 响应必须删除

- 所有 hop-by-hop 头；
- `Connection` 动态点名的字段以及原始 `content-length`；解析失败时以 `PROTOCOL_ERROR` 终止；正常有已知 `bodyLength` 的最终响应由 service 重算公开 `content-length`，未知长度使用 HTTP 流式传输；HEAD/204/304 不从协议 body 推导该头；
- `set-cookie`；
- 暴露内部代理、文件路径或调试实现的私有头；
- 与公开 Caddy 策略冲突的安全头由中心按明确 allow/override 规则处理，不能简单重复。

v0.1.0 不支持 DSH Cookie 透传。

## 13. 错误码和 tunnel close code

### 13.1 连接级错误

| code | 含义 | client 行为 |
|---|---|---|
| `TOKEN_INVALID` | token 不存在或不匹配 | 停止并提示 owner，不自动注册 |
| `TOKEN_EXPIRED` | token 已过期 | 停止并进入显式恢复流程 |
| `TOKEN_REVOKED` | 管理员吊销 | 立即停止，不自动恢复 |
| `TOKEN_ROTATED` | 当前 tunnel 使用的旧 token overlap 已结束 | 读取已持久化的新 token 并重连；无新 token 则停止 |
| `BAD_PROTO` | 主版本不支持 | 停止并升级实现 |
| `BAD_MINOR` | minor 不满足最低版本 | 停止并升级实现 |
| `MISSING_CAPABILITY` | 缺少必需能力 | 停止并升级实现 |
| `BAD_LIMITS` | client 限额缺失、非法或协商结果违反不变量 | 停止并升级或修复配置 |
| `BAD_FRAME` | 帧结构或状态机非法 | 关闭连接 |
| `INACTIVE_TIMEOUT` | 长时间无有效帧 | 可指数退避重连 |

### 13.2 Session 错误

| code | HTTP 映射 | 说明 |
|---|---:|---|
| `UPSTREAM_DOWN` | 502 | 本地 DSH 不可达 |
| `UPSTREAM_TIMEOUT` | 504 | 本地请求/WS 超时 |
| `LIMIT_EXCEEDED` | 413/429/503 | 根据 body、并发或队列类型映射 |
| `BAD_REQUEST` | 400 | method/path/header 不合法 |
| `PROTOCOL_ERROR` | 502 | seq、长度或状态机错误 |
| `CLIENT_GONE` | 无 | 浏览器已断开 |
| `TUNNEL_CLOSED` | 502 | 隧道中断 |

### 13.3 WebSocket 应用 close code

| close code | 含义 |
|---:|---|
| 4401 | token 无效/过期/吊销 |
| 4403 | 协议不兼容 |
| 4408 | hello/心跳/空闲超时 |
| 4409 | tunnel 被同实例新连接替换 |
| 4410 | 旧 token overlap 结束，tunnel 必须使用新 token 重连 |
| 4413 | frame/message/body 超限 |

close reason 不包含 token、用户数据或内部异常堆栈。

## 14. 重连和重复连接

- 网络错误使用指数退避并加入随机抖动，例如 1s、2s、4s…上限 60s；
- welcome 成功后才能重置退避；
- `TOKEN_INVALID/EXPIRED/REVOKED` 和协议不兼容均停止自动重连；`TOKEN_EXPIRED` 可在本地保存的 `renewalUntil` 之前提示用户显式执行 `rotate-token`；
- 同一实例新 tunnel 通过鉴权后可以接管旧 tunnel；若是同一有效 token 的重复连接，service 先向旧连接发送 `bye {code:"TUNNEL_REPLACED"}`，取消其全部 session，再注册新连接；
- token 轮换后的合法 client 应在 overlap 内使用新 token 触发接管；service 必须向使用旧 token 的旧 tunnel 发送 `bye {code:"TOKEN_ROTATED"}`，并拒绝旧 token 在 overlap 内反向替换已在线的新 token tunnel；到期仍使用旧 token 的 tunnel 同样按 `TOKEN_ROTATED` 关闭；
- 接管不签发新 token、不改变 instance ID；
- client 进程重启只重连，不重新注册。

## 15. 安全和日志约束

- 任意日志不得输出 registry key、replacement grant、instance token、Cookie、Authorization、data/body；
- service/client 通用日志 helper 必须在写 stdout/stderr 前脱敏 credential-shaped 值、Bearer Authorization、Cookie 和常见敏感字段；容器日志保留策略不得被当作脱敏机制；
- 日志和审计不得输出完整 `Idempotency-Key` 或 encrypted response，只能记录固定长度 key digest prefix、operation 和结果码；
- 任一凭据在错误中只允许展示固定长度公开 prefix；
- hostname、version、reason、path 等外部字符串必须结构化编码并限制长度；
- 不把协议 error message 原样返回 portal HTML；
- frame parser 设置最大 JSON 深度/字符串长度，拒绝原型污染键；
- 审计记录 request ID、instance、namespace、code、bytes 和 duration，不记录正文；
- 测试 fixture 使用专用假 token，不能复制真实凭据。

## 16. 契约测试要求

HTTPS 管理面、service 和 client/plugin 实现至少覆盖：

1. namespace 创建原子签发首个 key、单 owner 与输入约束；
2. 同一当前 registry key 注册多个不同 installation ID；
3. registry key 更新后旧 key 失败，更新前已签发的 instance token 和在线 tunnel 不受影响；
4. registry key 更新与注册并发的两种事务提交顺序，以及相同 `expectedVersion` 的并发更新只有一个成功；
5. token 有效期、renewal grace、overlap 边界、单 token 单后继、并发轮换、旧 token tunnel 到期关闭及过期 token 不得连接 tunnel；
6. owner 吊销、`leave` 响应丢失重试、replacement 创建不变更状态、旧 grant supersede、并发消费及消费后旧 token/tunnel 全部终止；
7. hello/welcome、低/高 minor、capability、`offeredLimits` 及最终 limits 交集与不变量；
8. invalid、expired、revoked 三类终止行为；
9. 无 body、小 body、多 chunk、未知 bodyLength、长度不匹配、HEAD/204/304 无 body、informational 1xx 忽略及 101 仅走 WS；
10. `Expect: 100-continue` 和 HTTP trailers 的拒绝；
11. 响应实时到达浏览器，证明未完整缓冲；
12. WS 双向消息、分块重组、message 边界、subprotocol、UTF-8 和关闭；
13. 浏览器取消传播到本地 request；
14. heartbeat seq 匹配、重复/旧 pong、pong timeout 与 health 独立工作；
15. max frame/body/message/session/queue 限制；
16. 高低水位 pause/resume；
17. credit 耗尽/补充、超额 credit、每隧道未确认字节上限和 session 间公平性；
18. tunnel 断开和重复连接清理；
19. Cookie、Authorization、代理/身份头、Origin、WS extension、`Set-Cookie` 剥离；
20. 非 loopback target、跨站 Fetch Metadata、绝对 URL、CRLF 和非法 header 被拒绝；
21. service 重启后实例默认 offline，持久化健康观测只显示 stale/unknown。
22. owner 只读列表的 ACL、稳定分页、字段最小化、无观测/过期观测和秘密字段排除。
23. 五类秘密签发接口的响应丢失重放、同 key 异请求冲突、密文认证失败、响应过期墓碑和 mutation 不重复执行。

仅 mock 端到端冒烟通过不能代表协议验收；还必须有帧级状态机测试、限流测试、真实 DSH 测试和内存/背压观测。

## 17. v1.1 明确不做

- tunnel 二进制 envelope；
- 协议级压缩；
- 断点续传；
- P2P；
- 无头 agent/session 控制通道；
- DSH Cookie 透传；
- 多中心 tunnel 漫游。

## 18. 变更记录

- 2026-08-30：同步 v0.1.3 G13 hosted 模型/provider 设置实现。`deploymentMode` 是用于 Portal 展示和本地 hosted eligibility 检查的可选非秘密注册/hello 元数据。模型设置端点属于同源 DSH plugin endpoint，不新增或修改 tunnel wire frame。
- 2026-08-30：同步 v0.1.2 大会话历史加载收口口径。请求下压、实例侧响应瘦身、byte-limit 诊断和浏览器自动加载 gating 属于 HTTP adapter/browser overlay 行为；不新增或修改 tunnel wire frame。
- 2026-08-28：同步 v0.1.1 hosted DSH 收口口径。手工托管容器模板、`/workspace` 限制 picker overlay 和 hosted 模型设置限制均属于部署/composition 边界；不新增或修改 tunnel wire frame。
- 2026-08-26：同步 v0.1.0 MVP 收口口径；确认 plugin-first 验证、M3B 运维基线和后续懒加载/多用户/管理员界面规划均不改变 `proto: 1` / `minor: 1` 线协议。
- 2026-08-21：补充目标协议与已实现子集的边界说明，明确 M1A-1 仅覆盖控制面/凭据/幂等/终止语义；其余 HTTP/WS 数据面、流控、真实 DSH 兼容性和协议验收仍按后续阶段推进，不因本次文档修订而改变。
- 2026-08-21：同步 M1A-2 已实现子集，明确 token 轮换、replacement grant、client `leave`、`TOKEN_EXPIRED`/`TOKEN_ROTATED` hello 语义和 token-aware tunnel 接管已落地；当时完整 v1.1 数据面仍留给 M1B，现已由 M1B 完成。
- 2026-08-21：同步 M1A-3 已实现子集，明确可信代理/规范身份头、三 Host、instance Origin/Fetch Metadata、origin-form path、loopback target 和 relay header/Cookie/Set-Cookie 清洗已落地；当时只完成 target 安全约束与 Host rewrite，v1.1 hello object target、capabilities/limits 协商和分块/credit/cancel 数据面仍留给 M1B，现已由 M1B 完成；Portal CSRF/CSP/列表审计已由 M1A-4 完成。
- 2026-08-21：同步 M1A-4 已实现子集，明确 Portal CSRF/CSP/安全头、owner 写接口 schema/reason、分页 cursor、字段最小化、`connectionState`/`dshHealth` stale 语义、限流审计和 owner revoke 审计事务性已落地；当时 HTTP/WS 分块、credit、cancel 和完整 limits 仍留给 M1B，现已由 M1B 完成。
- 2026-08-21：同步 M1B 已实现子集，明确 service/client 已拒绝缺少 required capability、非法 limits 或 legacy target 的旧 hello，HTTP/WS 数据面已改为分块帧，WS upgrade 延迟到 `wsOpen` 后，浏览器→实例 WS 方向已修正，cancel、HTTP/WS per-session credit、heartbeat/pong 和 `maxSessions` 上限已有自动化覆盖；真实 DSH 兼容性、tunnel 级总账、持续内存曲线和生产背压调优仍留给 M1C/M3。
- 2026-08-21：同步 M1C 只读验证结果：本机 `@deepseek-ai/dsh@0.1.0-rc.7` 的真实根页面、manifest、`/api/session.list`、`/api/events.mux`、`/api/events.host` 和经 hub 中继的 HTTP/WS/整页入口通过；Portal iframe 受当前 Fetch Metadata/错误响应 CSP 策略限制返回 403；真实 DSH 接受非 loopback Host 头，因此协议继续要求中心先完成 ACL/Host/Origin 校验再改写到 loopback；npm `latest/next=0.1.1-rc.2` 待验证。
- 2026-08-21：同步 M2 本地部署结论：Docker/Caddy/Authelia/secret-file 实现不新增或修改协议帧；公网 VPS 验收只验证 `https/wss` 部署路径和代理边界，不改变 v1.1 tunnel 状态机。
- 2026-08-21：同步 existing-Caddy 部署结论：`GET /api/tls/ask?domain=<sni>` 是 Caddy on-demand TLS 的部署辅助端点，只返回是否允许为域名签证，不参与 client/plugin tunnel 协议，也不改变实例注册、token 或 relay 帧语义；2026-08-22 起该端点必须仅接受 loopback 来源地址 + loopback Host 的内部调用，公网 control/portal/instance Host 访问必须失败。
- 2026-08-22：同步远程 DSH 诊断结论：经 hub 中继可读取与直连一致的 `session.list`/`workspace.list`，目录选择器触发 native picker 是 DSH host capability 自动策略结果；M3/M4 文档已将其纳入诊断与 plugin adapter，不改变 v1.1 wire protocol。
- 2026-08-21：同步 existing-Caddy 公网部署模板结论：正式 TLS、Authelia、system Caddy 转发和未知实例域名拒签属于部署边界验证，不新增协议帧、不改变 registry key、instance token、hello/limits 或 relay/cancel/credit/heartbeat 语义。
- 2026-08-22：同步 M3A 最小诊断基线：中心新增 `GET /api/instances/:id/diagnostics`，通过既有 v1.1 `req`/`wsReq` 数据面帧对实例侧 DSH 做白名单只读探测，不新增 tunnel 帧类型，不改变 hello、token、credit、cancel 或 heartbeat 语义。
- 2026-08-22：同步 M4A 只读可行性基线：本机 `@deepseek-ai/dsh@0.1.0-rc.7` 的 plugin/profile/bundle/client/settings/webserver/directory-picker/API seam 已通过 `npm run test:m4:feasibility` 检查；browse picker 可通过禁用默认 auto row 并插入 browse backend/client row 的 profile overlay 接入；`host.openPath` 暂只确认到 api-proxy injectable defaults。这些均属于实例侧 composition/adapter，不改变 tunnel 帧。
- 2026-08-22：同步 M4B 最小 plugin 骨架通过 review-fix-loop：`packages/dsh-hub-plugin` 当时只声明默认关闭的 host-side DSH bundle、非秘密 settings namespace 和只读状态；`npm run test:m4:skeleton` 通过临时 `DSH_HOME`、`dsh --dump-config` 和短时 `dsh --profile web --port 0` 验证 profile composition 与真实 loader activation，不启动 tunnel、不新增协议帧。
- 2026-08-22：同步 M4C 显式 remote host capability overlay 通过 review-fix-loop：`packages/dsh-hub-plugin/remote-capabilities.patch.yml` 只影响 DSH profile composition，显式应用后禁用默认 auto picker 并挂载 browse picker host/client rows；默认 bundle patch 不引用 overlay，不启动 tunnel、不新增帧、不改变 v1.1 wire protocol。
- 2026-08-22：同步 M4D-1 browser settings card 基线并通过 review-fix-loop：`packages/dsh-hub-plugin` 声明 `dsh.client` 和 `exports["./client"]`，新增 lazy-CJS browser bundle 并注册只读 `settings.plugin.item` 卡片；`npm run test:m4:browser-card` 使用临时 `DSH_HOME` 验证真实 DSH boot graph、`/plugins/dsh-hub-plugin/client.js` serving 和 browser factory slot registration。该切片不启动 tunnel、不注册实例、不保存凭据、不改变 v1.1 wire protocol。
- 2026-08-22：同步 M4D-2 plugin tunnel adapter 实现并通过 review-fix-loop：插件复用现有 v1.1 `runTunnel`、relay 和协议常量，hello 的 `delivery` 可设置为 `plugin`，target 固定为同进程 DSH webServer loopback；该切片不新增协议帧、不保存凭据、不改变 token、relay、cancel、credit 或 heartbeat 语义。
- 2026-08-22：同步 M4D-3 plugin 凭据/入伙 runtime 实现并通过 review-fix-loop：插件复用既有 `/api/register`、token rotate/self revoke 和 M4D-2 adapter；registry key/replacement grant 仅作为一次性内存输入，成功后只保存 instance credentials；已有凭据时拒绝 registry key rejoin，replacement grant 恢复复用 installation ID；该切片不新增 wire protocol 帧，不改变 registry key 更新不影响既有 instance token 的模型。
- 2026-08-22：同步 M4D-4 plugin 状态/诊断摘要实现并通过 review-fix-loop：新增 host 侧 `statusView`、instance URL 推导 hint、本地 DSH `session.list`/`workspace.list`/events/workspace 映射计数摘要和 browser card 展示模型；诊断摘要和公开状态不返回 workspace 本机路径、请求体或任何 secret。该切片不新增 wire protocol 帧，不改变 token、relay、cancel、credit 或 heartbeat 语义。
- 2026-08-23：同步 M4D-5 host-to-browser live status bridge：插件通过 DSH `webServer.register` 注册同源 `/plugins/dsh-hub-plugin/status.json`，普通读取只返回最小脱敏 `statusView` payload，`?refresh=1` 才触发同进程只读 diagnostics 刷新；该 endpoint 属于 DSH Web composition 内部状态面，不是 hub tunnel wire protocol，不新增帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 语义。
- 2026-08-23：同步 M4D-6 canOpenPath gating overlay：本机 rc.7 验证表明 web profile 既有 `api-gateway` row 只能通过 `nativeOpen` 配置影响 `canOpenPath` 能力广告，不能通过普通 profile patch 替换为远程 opener；`remote-capabilities.patch.yml` 已设置 `api-gateway.config.nativeOpen=false`，运行时 `host.describe.canOpenPath=false`，状态模型标记 `can-open-path-overlay-available`。该切片只影响 DSH composition/UI gating，不拦截 direct `host.openPath` RPC，不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 语义。
- 2026-08-23：同步 M3B-1 内部 metrics 基线：service `GET /metrics` 是管理面 Prometheus 文本端点，仅允许 loopback 来源地址 + loopback Host 直连读取；M2 Caddy 公开入口会在代理前拒绝 `/metrics`；它不走 client/plugin tunnel，不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 语义。
- 2026-08-23：同步 M3B-2 运维指标增强：service 在内部 `/metrics` 增加错误/超限/取消、DSH health、heartbeat `sentAt` age 和 SQLite 写 latency 指标；控制面 body 超限稳定返回 `LIMIT_EXCEEDED` 413 并关闭 HTTP 连接；这些指标只读取既有 tunnel 帧和 service 内部事件，不新增帧，不改变 hello、token、relay、cancel、credit、heartbeat 或 health 语义。
- 2026-08-24：同步 M3B-3A 背压/排队字节观测：service 在内部 `/metrics` 增加 relay queued/uncredited/downstream buffered bytes 和 credit waiters/wait bytes 汇总指标；这些指标只读取 service 现有 session/tunnel 状态，不新增 wire protocol 帧，不改变 client、credit 帧、pause/resume、backpressure timeout 或 tunnel 终止语义。
- 2026-08-24：同步 M3B-3B tunnel 级背压执行：service `Tunnel` 与 client/plugin `OutboundFrameSender` 对 data frame 执行 `maxUncreditedBytesPerTunnel` 总账、`highWaterBytes/lowWaterBytes` 门控和 `backpressureTimeoutMs` 超时 `LIMIT_EXCEEDED`；control frames 不受 gate 阻塞。该切片不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
- 2026-08-24：同步 M3B-3C sender 公平调度：service `Tunnel` 与 client/plugin `OutboundFrameSender` 对等待中的 data frame 执行容量感知调度，并用 reservation 防止并发唤醒超订总账。该切片不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
- 2026-08-25：同步 M3B-3D 本地背压容量基线：`test:load` 增加慢 `credit(req)` 并发 HTTP 上传场景，验证内部 metrics 与 RSS/heap guardrail；该切片只新增测试，不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
- 2026-08-25：同步 M3B-4 告警/运行手册基线：新增 Prometheus 告警规则、同机 scrape 建议、运行手册和本地规则检查脚本；该切片不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
- 2026-08-25：同步 M3B-5 本地恢复/回滚演练基线：新增临时 SQLite `VACUUM INTO` 备份/恢复 smoke、恢复/升级/回滚 runbook 和本地检查脚本；该切片不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式，不替代真实部署恢复演练。
- 2026-08-25：同步 M3B-6 日志保留/脱敏基线：新增 compose `json-file` / `10m × 7` 日志轮转、service/client 日志 helper 脱敏、本地日志检查脚本和日志 runbook；该切片不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式，不替代生产日志平台或故障演练。
- 2026-08-25：同步 M4D-7A plugin 启动体验基线：新增 `dsh-hub-web` 一行启动包装和 `dsh-hub-client plugin-install-check` 只读安装检查；该切片只组合 DSH profile patch / overlay 与本地检查，不执行注册、不保存 token、不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
- 2026-08-25：同步 M4D-7B plugin 安装/入伙 CLI：新增 `plugin-install` profile metadata/patch 写入和 `plugin-join` 对 `PluginRuntime.join({ start:false })` 的 CLI 包装；注册仍走既有 `/api/register`，成功后只保存 plugin instance credentials，不新增 wire protocol 帧，不改变 hello、token、relay、cancel、credit 或 heartbeat 帧格式。
