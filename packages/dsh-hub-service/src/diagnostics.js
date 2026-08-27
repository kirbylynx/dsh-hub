import { MSG, STREAMS, chunkBuffer, decodeChunk, encodeChunk } from './protocol.js';

const DIAGNOSTIC_TIMEOUT_MS = 3000;
const DIAGNOSTIC_WS_IDLE_MS = 1200;
const DIAGNOSTIC_MAX_BODY_BYTES = 512 * 1024;

export async function collectInstanceDiagnostics({ tunnel, instance, instanceDto, instanceOrigin }) {
  const base = {
    checkedAt: new Date().toISOString(),
    instance: instanceDto,
    relay: relaySnapshot(tunnel),
    dshApi: {
      sessionList: notProbed('instance offline'),
      workspaceList: notProbed('instance offline'),
    },
    workspaceMapping: {
      sessionCount: null,
      workspaceCount: null,
      linkedSessionCount: null,
      unlinkedSessionCount: null,
      unlinkedSessionIds: [],
      staleWorkspaceSessionCount: null,
      staleWorkspaceSessionIds: [],
      truncated: false,
      staleWorkspaceSessionTruncated: false,
    },
    websocket: {
      eventsMux: wsNotProbed('instance offline'),
      eventsHost: wsNotProbed('instance offline'),
    },
    hostCapabilities: inferHostCapabilities(instance),
    recommendations: [],
    probePlan: {
      readonly: true,
      instanceOrigin,
      httpRpcMethods: ['session.list', 'workspace.list'],
      websocketPaths: ['/api/events.mux', '/api/events.host'],
    },
  };

  if (!tunnel) {
    base.recommendations = recommendationsFor(base);
    return base;
  }

  if (tunnel.sessions.size >= tunnel.limits.maxSessions) {
    const result = {
      ...base,
      dshApi: {
        sessionList: notProbed('diagnostic capacity unavailable'),
        workspaceList: notProbed('diagnostic capacity unavailable'),
      },
      websocket: {
        eventsMux: wsNotProbed('diagnostic capacity unavailable'),
        eventsHost: wsNotProbed('diagnostic capacity unavailable'),
      },
    };
    result.recommendations = recommendationsFor(result);
    return result;
  }

  const sessionList = await probeDshRpc(tunnel, 'session.list');
  const workspaceList = await probeDshRpc(tunnel, 'workspace.list');
  const eventsMux = await probeDshWs(tunnel, '/api/events.mux', { expectMessage: true });
  const eventsHost = await probeDshWs(tunnel, '/api/events.host', { expectMessage: false });
  const workspaceMapping = summarizeWorkspaceMapping(sessionList.items, workspaceList.items);
  const result = {
    ...base,
    dshApi: {
      sessionList: summarizeRpc(sessionList),
      workspaceList: summarizeRpc(workspaceList),
    },
    workspaceMapping,
    websocket: {
      eventsMux,
      eventsHost,
    },
  };
  result.recommendations = recommendationsFor(result);
  return result;
}

async function probeDshRpc(tunnel, method) {
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: `dsh-hub-m3a-${method}`,
    method,
    payload: {},
  });
  const response = await probeHttpViaTunnel(tunnel, {
    method: 'POST',
    path: `/api/${method}`,
    headers: {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  });
  let parsed = null;
  try { parsed = JSON.parse(response.body); } catch { /* noop */ }
  return {
    ...response,
    transportError: response.error ?? null,
    ok: parsed?.result?.ok === true,
    rpcType: parsed?.type ?? null,
    rpcError: parsed?.error ?? null,
    items: Array.isArray(parsed?.result?.value?.items) ? parsed.result.value.items : null,
  };
}

function probeHttpViaTunnel(tunnel, { method, path, headers, body }) {
  return new Promise((resolve) => {
    const id = tunnel.allocId();
    const session = new DiagnosticHttpSession({
      id,
      tunnel,
      method,
      path,
      headers,
      body: Buffer.from(body ?? ''),
      resolve,
    });
    tunnel.attachSession(session);
    session.start();
  });
}

class DiagnosticHttpSession {
  constructor({ id, tunnel, method, path, headers, body, resolve }) {
    this.id = id;
    this.tunnel = tunnel;
    this.method = method;
    this.path = path;
    this.headers = headers;
    this.body = body;
    this.resolve = resolve;
    this.done = false;
    this.resSeq = 0;
    this.resBytes = 0;
    this.chunks = [];
    this.response = null;
    this.timer = setTimeout(() => this.finish({
      status: 0,
      headers: {},
      body: '',
      error: 'diagnostic HTTP probe timeout',
    }, { cancelClient: true }), DIAGNOSTIC_TIMEOUT_MS);
    this.timer.unref?.();
  }

  start() {
    this.#start().catch((err) => this.finish({
      status: 0,
      headers: {},
      body: '',
      error: err.message,
    }, { cancelClient: true }));
  }

  async #start() {
    this.tunnel.send({
      type: MSG.REQ,
      id: this.id,
      method: this.method,
      path: this.path,
      headers: this.headers,
      bodyLength: this.body.length,
    });
    let seq = 0;
    for (const chunk of chunkBuffer(this.body, this.tunnel.limits.maxChunkDecodedBytes)) {
      await this.tunnel.sendData({
        type: MSG.REQ_DATA,
        id: this.id,
        seq: seq++,
        data: encodeChunk(chunk),
      }, { stream: STREAMS.REQ, decodedBytes: chunk.length });
    }
    this.tunnel.send({ type: MSG.REQ_END, id: this.id, seq, bytes: this.body.length });
  }

  handleFrame(type, msg) {
    if (this.done && type !== MSG.CREDIT) return;
    try {
      if (type === MSG.RESP) {
        this.response = {
          status: Number.isSafeInteger(msg.status) ? msg.status : 0,
          headers: msg.headers ?? {},
        };
      } else if (type === MSG.CREDIT && msg.stream === STREAMS.REQ) {
        if (!Number.isSafeInteger(msg.bytes) || msg.bytes <= 0) throw new Error('diagnostic bad request credit');
        this.tunnel.releaseDataCredit(this.id, STREAMS.REQ, msg.bytes);
      } else if (type === MSG.RESP_DATA) {
        if (msg.seq !== this.resSeq) throw new Error('diagnostic response seq mismatch');
        const decoded = decodeChunk(msg.data ?? '', this.tunnel.limits);
        this.resSeq += 1;
        this.resBytes += decoded.length;
        if (this.resBytes > DIAGNOSTIC_MAX_BODY_BYTES) throw new Error('diagnostic response too large');
        this.chunks.push(decoded);
        this.tunnel.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.RESP, bytes: decoded.length });
      } else if (type === MSG.RESP_END) {
        this.finish({
          status: this.response?.status ?? 0,
          headers: this.response?.headers ?? {},
          body: Buffer.concat(this.chunks).toString('utf8'),
          error: null,
        });
      } else if (type === MSG.ERROR || type === MSG.CANCEL) {
        this.finish({
          status: 0,
          headers: {},
          body: '',
          error: msg.message ?? msg.code ?? 'diagnostic HTTP probe failed',
        });
      }
    } catch (err) {
      this.finish({ status: 0, headers: {}, body: '', error: err.message }, { cancelClient: true });
    }
  }

  finish(result, { cancelClient = false } = {}) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    if (cancelClient) {
      this.tunnel.send({
        type: MSG.CANCEL,
        id: this.id,
        code: 'DIAGNOSTIC_CANCELLED',
        message: result.error ?? 'diagnostic HTTP probe stopped',
      });
    }
    this.tunnel.detachSession(this.id);
    this.resolve(result);
  }

  terminate(reason = 'tunnel closed') {
    this.finish({ status: 0, headers: {}, body: '', error: reason });
  }
}

function probeDshWs(tunnel, path, { expectMessage }) {
  return new Promise((resolve) => {
    const id = tunnel.allocId();
    const session = new DiagnosticWsSession({ id, tunnel, path, expectMessage, resolve });
    tunnel.attachSession(session);
    session.start();
  });
}

class DiagnosticWsSession {
  constructor({ id, tunnel, path, expectMessage, resolve }) {
    this.id = id;
    this.tunnel = tunnel;
    this.path = path;
    this.expectMessage = expectMessage;
    this.resolve = resolve;
    this.done = false;
    this.opened = false;
    this.messages = 0;
    this.firstBytes = 0;
    this.recvMessageId = 0;
    this.recvSeq = 0;
    this.recvParts = [];
    this.recvBytes = 0;
    this.recvBinary = null;
    this.timer = setTimeout(() => this.finish({
      opened: this.opened,
      messages: this.messages,
      firstBytes: this.firstBytes,
      idle: this.opened && this.messages === 0,
      error: this.opened ? null : 'diagnostic WebSocket probe timeout',
    }), DIAGNOSTIC_TIMEOUT_MS);
    this.timer.unref?.();
  }

  start() {
    this.tunnel.send({
      type: MSG.WS_REQ,
      id: this.id,
      path: this.path,
      headers: {},
      protocols: [],
    });
  }

  handleFrame(type, msg) {
    if (this.done) return;
    try {
      if (type === MSG.WS_OPEN) {
        this.opened = true;
        if (!this.expectMessage) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.finish({
            opened: true,
            messages: this.messages,
            firstBytes: this.firstBytes,
            idle: this.messages === 0,
            error: null,
          }), DIAGNOSTIC_WS_IDLE_MS);
          this.timer.unref?.();
        }
      } else if (type === MSG.WS_DATA) {
        this.#handleData(msg);
      } else if (type === MSG.WS_END) {
        this.finish({
          opened: this.opened,
          messages: this.messages,
          firstBytes: this.firstBytes,
          idle: this.opened && this.messages === 0,
          error: null,
        });
      } else if (type === MSG.WS_ERR || type === MSG.ERROR || type === MSG.CANCEL) {
        this.finish({
          opened: this.opened,
          messages: this.messages,
          firstBytes: this.firstBytes,
          idle: this.opened && this.messages === 0,
          error: msg.message ?? msg.code ?? 'diagnostic WebSocket probe failed',
        });
      }
    } catch (err) {
      this.finish({
        opened: this.opened,
        messages: this.messages,
        firstBytes: this.firstBytes,
        idle: this.opened && this.messages === 0,
        error: err.message,
      });
    }
  }

  #handleData(msg) {
    if (msg.messageId !== this.recvMessageId || msg.seq !== this.recvSeq) throw new Error('diagnostic ws seq mismatch');
    const binary = msg.binary === true;
    if (this.recvSeq === 0) this.recvBinary = binary;
    if (binary !== this.recvBinary) throw new Error('diagnostic ws binary flag changed');
    const decoded = decodeChunk(msg.data ?? '', this.tunnel.limits);
    this.recvBytes += decoded.length;
    if (this.recvBytes > this.tunnel.limits.maxWsMessageBytes) throw new Error('diagnostic ws message too large');
    this.recvParts.push(decoded);
    this.recvSeq += 1;
    if (msg.final === true) {
      const payload = Buffer.concat(this.recvParts);
      this.messages += 1;
      if (!this.firstBytes) this.firstBytes = payload.length;
      this.tunnel.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.WS_I2C, bytes: payload.length });
      this.recvMessageId += 1;
      this.recvSeq = 0;
      this.recvParts = [];
      this.recvBytes = 0;
      this.recvBinary = null;
      if (this.expectMessage) {
        this.finish({
          opened: this.opened,
          messages: this.messages,
          firstBytes: this.firstBytes,
          idle: false,
          error: null,
        });
      }
    }
  }

  finish(result) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timer);
    this.tunnel.send({ type: MSG.WS_END, id: this.id, code: 1000, reason: 'diagnostic complete' });
    this.tunnel.detachSession(this.id);
    this.resolve(result);
  }

  terminate(reason = 'tunnel closed') {
    this.finish({
      opened: this.opened,
      messages: this.messages,
      firstBytes: this.firstBytes,
      idle: this.opened && this.messages === 0,
      error: reason,
    });
  }
}

function relaySnapshot(tunnel) {
  if (!tunnel) {
    return {
      connectionState: 'offline',
      activeRelaySessions: 0,
      dshOnline: null,
      targetAuthority: null,
      delivery: null,
      limits: null,
    };
  }
  return {
    connectionState: 'online',
    activeRelaySessions: tunnel.sessions.size,
    dshOnline: tunnel.dshOnline,
    targetAuthority: tunnel.target?.authority ?? `${tunnel.target?.host}:${tunnel.target?.port}`,
    delivery: tunnel.delivery,
    limits: {
      maxSessions: tunnel.limits.maxSessions,
      maxHttpBodyBytes: tunnel.limits.maxHttpBodyBytes,
      maxWsMessageBytes: tunnel.limits.maxWsMessageBytes,
    },
  };
}

function summarizeRpc(result) {
  return {
    status: result.status,
    contentType: headerValue(result.headers, 'content-type'),
    ok: result.ok === true,
    rpcType: result.rpcType,
    itemCount: Array.isArray(result.items) ? result.items.length : null,
    error: sanitizeRpcError(result.rpcError),
    transportError: result.transportError ?? null,
  };
}

function notProbed(reason) {
  return {
    status: null,
    contentType: null,
    ok: false,
    rpcType: null,
    itemCount: null,
    error: null,
    transportError: reason,
  };
}

function wsNotProbed(reason) {
  return { opened: false, messages: 0, firstBytes: 0, idle: false, error: reason };
}

function headerValue(headers, name) {
  const key = Object.keys(headers ?? {}).find((candidate) => candidate.toLowerCase() === name);
  const value = key ? headers[key] : null;
  return Array.isArray(value) ? value.join(', ') : value;
}

function sanitizeRpcError(error) {
  if (error === null || error === undefined) return null;
  if (typeof error !== 'object' || Array.isArray(error)) {
    return { code: null, type: null, message: 'DSH RPC returned an error' };
  }
  return {
    code: stableErrorScalar(error.code),
    type: stableErrorScalar(error.type ?? error.name),
    message: 'DSH RPC returned an error',
  };
}

function stableErrorScalar(value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return null;
  const text = String(value).slice(0, 80);
  return /^[A-Za-z0-9_.:-]+$/.test(text) ? text : 'redacted';
}

function summarizeWorkspaceMapping(sessionItems, workspaceItems) {
  const workspaceSessionIds = collectWorkspaceSessionIds(workspaceItems);
  const allSessionIds = collectSessionIds(sessionItems);
  const allSessionIdSet = new Set(allSessionIds);
  const linkedSessionIds = [...workspaceSessionIds].filter((id) => allSessionIdSet.has(id));
  const unlinkedSessionIds = allSessionIds.filter((id) => !workspaceSessionIds.has(id));
  const staleWorkspaceSessionIds = [...workspaceSessionIds].filter((id) => !allSessionIdSet.has(id));
  return {
    sessionCount: Array.isArray(sessionItems) ? allSessionIds.length : null,
    workspaceCount: Array.isArray(workspaceItems) ? workspaceItems.length : null,
    linkedSessionCount: Array.isArray(sessionItems) && Array.isArray(workspaceItems) ? linkedSessionIds.length : null,
    unlinkedSessionCount: Array.isArray(sessionItems) && Array.isArray(workspaceItems) ? unlinkedSessionIds.length : null,
    unlinkedSessionIds: unlinkedSessionIds.slice(0, 50),
    staleWorkspaceSessionCount: Array.isArray(sessionItems) && Array.isArray(workspaceItems) ? staleWorkspaceSessionIds.length : null,
    staleWorkspaceSessionIds: staleWorkspaceSessionIds.slice(0, 50),
    truncated: unlinkedSessionIds.length > 50,
    staleWorkspaceSessionTruncated: staleWorkspaceSessionIds.length > 50,
  };
}

function collectSessionIds(items) {
  if (!Array.isArray(items)) return [];
  return [...new Set(items
    .map((item) => item?.sessionId ?? item?.id ?? item?.session_id)
    .filter((id) => typeof id === 'string' && id.length > 0))];
}

function collectWorkspaceSessionIds(items) {
  const ids = new Set();
  if (!Array.isArray(items)) return ids;
  for (const workspace of items) {
    const candidates = [
      workspace?.sessionIds,
      workspace?.session_ids,
      workspace?.sessions,
    ];
    for (const value of candidates) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        const id = typeof entry === 'string' ? entry : entry?.sessionId ?? entry?.id ?? entry?.session_id;
        if (typeof id === 'string' && id.length > 0) ids.add(id);
      }
    }
  }
  return ids;
}

function inferHostCapabilities(instance) {
  const delivery = instance.delivery;
  if (delivery === 'plugin') {
    return {
      delivery,
      inferredDirectoryPicker: 'plugin-adapter',
      remoteLimited: false,
      note: 'plugin delivery is expected to provide an in-process remote host capability adapter',
    };
  }
  return {
    delivery,
    inferredDirectoryPicker: 'agent-loopback-native-likely',
    remoteLimited: true,
    note: 'independent agent tunnels to loopback DSH; native directory picker and host.openPath may execute on the instance machine',
  };
}

function recommendationsFor(result) {
  const out = [];
  if (result.relay.connectionState !== 'online') {
    out.push({
      code: 'INSTANCE_OFFLINE',
      severity: 'error',
      message: '实例 tunnel 不在线；先在实例机器运行 dsh-hub-client run 或 plugin。',
    });
    return out;
  }
  if (result.dshApi.sessionList.ok !== true || result.dshApi.workspaceList.ok !== true) {
    if (result.dshApi.sessionList.transportError === 'diagnostic capacity unavailable'
      || result.dshApi.workspaceList.transportError === 'diagnostic capacity unavailable') {
      out.push({
        code: 'DIAGNOSTIC_CAPACITY_UNAVAILABLE',
        severity: 'warning',
        message: '实例 tunnel 当前已达到 session 上限；诊断未抢占容量，请稍后重试。',
      });
      return out;
    }
    out.push({
      code: 'DSH_API_PROBE_FAILED',
      severity: 'error',
      message: '中心可连接实例 tunnel，但只读 DSH API 探测失败；优先检查本机 DSH Web 是否仍监听 loopback。',
    });
  }
  if ((result.workspaceMapping.unlinkedSessionCount ?? 0) > 0) {
    out.push({
      code: 'UNLINKED_SESSIONS',
      severity: 'warning',
      message: `发现 ${result.workspaceMapping.unlinkedSessionCount} 个 session 未挂接到任何 workspace；旧会话不可见更可能是 workspace/session 投影问题，不是 relay 丢失 session.list。`,
    });
  }
  if ((result.workspaceMapping.staleWorkspaceSessionCount ?? 0) > 0) {
    out.push({
      code: 'STALE_WORKSPACE_SESSION_IDS',
      severity: 'warning',
      message: `发现 ${result.workspaceMapping.staleWorkspaceSessionCount} 个 workspace 引用的 session 在 session.list 中不存在；需要后续只读解释或显式修复工具。`,
    });
  }
  if (result.hostCapabilities.remoteLimited) {
    out.push({
      code: 'AGENT_REMOTE_LIMITED',
      severity: 'info',
      message: 'agent 模式无法原生接管 DSH host capability；目录选择器和 host.openPath 体验应转入 M4 plugin adapter。',
    });
  }
  if (result.websocket.eventsMux.opened !== true) {
    out.push({
      code: 'EVENTS_MUX_UNAVAILABLE',
      severity: 'warning',
      message: 'events.mux 未能打开；实时 UI 状态可能不完整。',
    });
  }
  return out;
}
