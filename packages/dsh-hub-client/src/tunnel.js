import { WebSocket } from 'ws';
import { DEFAULT_LIMITS, MSG, PROTO_MINOR, PROTO_VERSION, REQUIRED_CAPABILITIES, validateLimits } from './protocol.js';
import { ClientRelay, historyNormalizerOptionsFromEnv } from './relay.js';
import { probeLocalDsh } from './probe.js';
import { parseTarget, wsUrlFor } from './util.js';
import { normalizeDeploymentMode } from './deployment-mode.js';

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve();
    return;
  }
  const timer = setTimeout(done, ms);
  const abort = () => done();
  function done() {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
    resolve();
  }
  signal?.addEventListener?.('abort', abort, { once: true });
});

export class AuthError extends Error {
  constructor(message, code = 'UNAUTHORIZED') {
    super(message);
    this.code = code;
  }
}

export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
    this.code = 'ABORT_ERR';
  }
}

export class TunnelBackpressureError extends Error {
  constructor(message = 'tunnel backpressure limit exceeded') {
    super(message);
    this.name = 'TunnelBackpressureError';
    this.code = 'LIMIT_EXCEEDED';
  }
}

export class OutboundFrameSender {
  constructor({ ws, limits }) {
    this.ws = ws;
    this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
    this.alive = true;
    this.outboundUncreditedBytes = 0;
    this.outboundReservedBytes = 0;
    this.outboundUncreditedBySession = new Map();
    this.backpressureWaiters = [];
    this.transportBackpressured = false;
    this.lastOutboundSessionId = null;
  }

  async send(obj, { decodedBytes, stream } = {}) {
    const bytes = safePositiveBytes(decodedBytes);
    if (bytes <= 0) {
      this.#sendFrame(obj);
      return;
    }
    const reserved = await this.#waitOutboundCapacity(bytes, obj.id);
    if (!this.alive) {
      if (reserved) this.#releaseOutboundReservation(bytes);
      return;
    }
    if (reserved) this.#releaseOutboundReservation(bytes);
    this.#accountOutboundData(obj.id, stream, bytes);
    if (!this.#sendFrame(obj)) {
      this.releaseDataCredit(obj.id, stream, bytes);
      throw new Error('tunnel send failed');
    }
  }

  releaseDataCredit(id, stream, bytes) {
    const n = safePositiveBytes(bytes);
    if (n <= 0) return;
    const session = this.outboundUncreditedBySession.get(id);
    if (!session) {
      this.#resolveBackpressureWaiters();
      return;
    }
    const current = session.get(stream) ?? 0;
    const released = Math.min(current, n);
    if (released > 0) {
      const next = current - released;
      if (next > 0) session.set(stream, next);
      else session.delete(stream);
      if (session.size === 0) this.outboundUncreditedBySession.delete(id);
      this.outboundUncreditedBytes = Math.max(0, this.outboundUncreditedBytes - released);
    }
    this.#resolveBackpressureWaiters();
  }

  releaseSession(id) {
    const session = this.outboundUncreditedBySession.get(id);
    if (!session) return;
    let released = 0;
    for (const bytes of session.values()) released += bytes;
    this.outboundUncreditedBySession.delete(id);
    this.outboundUncreditedBytes = Math.max(0, this.outboundUncreditedBytes - released);
    this.#resolveBackpressureWaiters();
  }

  close() {
    this.alive = false;
    this.outboundUncreditedBytes = 0;
    this.outboundReservedBytes = 0;
    this.outboundUncreditedBySession.clear();
    this.#resolveBackpressureWaiters();
  }

  #sendFrame(obj) {
    if (!this.alive || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj), () => this.#resolveBackpressureWaiters());
      return true;
    } catch {
      this.#resolveBackpressureWaiters();
      return false;
    }
  }

  #accountOutboundData(id, stream, bytes) {
    if (!id || !stream) return;
    let session = this.outboundUncreditedBySession.get(id);
    if (!session) {
      session = new Map();
      this.outboundUncreditedBySession.set(id, session);
    }
    session.set(stream, (session.get(stream) ?? 0) + bytes);
    this.outboundUncreditedBytes += bytes;
  }

  async #waitOutboundCapacity(bytes, sessionId) {
    const started = Date.now();
    if (this.backpressureWaiters.length === 0 && !this.#isOutboundBackpressured(bytes)) {
      return false;
    }
    return this.#waitForBackpressureTurn({ bytes, sessionId, started });
  }

  #isOutboundBackpressured(nextBytes) {
    if (this.outboundUncreditedBytes + this.outboundReservedBytes + nextBytes
      > this.limits.maxUncreditedBytesPerTunnel) return true;
    const buffered = safePositiveBytes(this.ws?.bufferedAmount);
    if (this.transportBackpressured) {
      if (buffered <= this.limits.lowWaterBytes) this.transportBackpressured = false;
    } else if (buffered >= this.limits.highWaterBytes) {
      this.transportBackpressured = true;
    }
    return this.transportBackpressured;
  }

  #waitForBackpressureTurn({ bytes, sessionId, started }) {
    return new Promise((resolve, reject) => {
      let timeoutTimer = null;
      let pollTimer = null;
      const waiter = {
        bytes,
        sessionId,
        resolve: () => {
          clearTimeout(timeoutTimer);
          clearInterval(pollTimer);
          resolve(true);
        },
      };
      const done = () => {
        clearInterval(pollTimer);
        const index = this.backpressureWaiters.indexOf(waiter);
        if (index >= 0) this.backpressureWaiters.splice(index, 1);
        this.#resolveBackpressureWaiters();
        reject(new TunnelBackpressureError('tunnel outbound backpressure timeout'));
      };
      const remaining = this.limits.backpressureTimeoutMs - (Date.now() - started);
      if (remaining <= 0) {
        throw new TunnelBackpressureError('tunnel outbound backpressure timeout');
      }
      timeoutTimer = setTimeout(done, Math.max(1, remaining));
      timeoutTimer.unref?.();
      pollTimer = setInterval(() => this.#resolveBackpressureWaiters(), 25);
      pollTimer.unref?.();
      this.backpressureWaiters.push(waiter);
      this.#resolveBackpressureWaiters();
    });
  }

  #resolveBackpressureWaiters() {
    if (!this.alive) {
      for (const waiter of this.backpressureWaiters.splice(0)) waiter.resolve();
      return;
    }
    const index = this.#nextSendableBackpressureWaiterIndex();
    if (index < 0) return;
    const [waiter] = this.backpressureWaiters.splice(index, 1);
    this.outboundReservedBytes += waiter.bytes;
    this.lastOutboundSessionId = waiter.sessionId ?? null;
    waiter.resolve();
  }

  #nextSendableBackpressureWaiterIndex() {
    let firstFit = -1;
    for (let i = 0; i < this.backpressureWaiters.length; i += 1) {
      const waiter = this.backpressureWaiters[i];
      if (this.#isOutboundBackpressured(waiter.bytes)) continue;
      if (firstFit < 0) firstFit = i;
      if (waiter.sessionId && waiter.sessionId !== this.lastOutboundSessionId) return i;
    }
    return firstFit;
  }

  #releaseOutboundReservation(bytes) {
    this.outboundReservedBytes = Math.max(0, this.outboundReservedBytes - bytes);
  }
}

function classifyAuthCode(rawCode, rawReason = '') {
  const code = String(rawCode ?? '').toUpperCase();
  if (['TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'TOKEN_ROTATED', 'UNAUTHORIZED'].includes(code)) {
    return code;
  }
  const reason = String(rawReason ?? '').toLowerCase();
  if (reason.includes('revoked')) return 'TOKEN_REVOKED';
  if (reason.includes('expired')) return 'TOKEN_EXPIRED';
  if (reason.includes('rotated')) return 'TOKEN_ROTATED';
  if (reason.includes('invalid') || reason.includes('unauthorized')) return 'TOKEN_INVALID';
  return null;
}

export function classifyTerminalClose(code, reason) {
  const normalizedReason = String(reason ?? '');
  const authCode = classifyAuthCode(code === 4401 ? 'UNAUTHORIZED' : null, normalizedReason)
    ?? classifyAuthCode(null, normalizedReason);
  if (authCode) {
    return {
      code: authCode,
      message: normalizedReason || authCode.toLowerCase().replaceAll('_', ' '),
    };
  }
  if (code === 4403) {
    return {
      code: 'BAD_PROTOCOL',
      message: normalizedReason || 'protocol rejected',
    };
  }
  return null;
}

function classifyAuthClosure(msg) {
  const code = classifyAuthCode(msg?.code, msg?.reason);
  return code ? { code, message: String(msg?.reason ?? code) } : null;
}

/**
 * Maintain the outbound tunnel: connect -> hello -> relay. 短暂网络问题自动重连，
 * 但 token 无效/吊销/过期等终止态会停止并要求人工重新 join。
 */
export async function runTunnel(config, creds, hooks = {}) {
  const onStatus = hooks.onStatus ?? (() => {});
  const installSignalHandlers = hooks.installSignalHandlers !== false;
  let stopped = false;
  let ws = null;
  let heartbeatTimer = null;
  let pongTimer = null;
  let healthTimer = null;
  let outboundSender = null;
  let current = { ...creds };

  const sendFrame = (obj, options = {}) => {
    if (outboundSender) return outboundSender.send(obj, options);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    return Promise.resolve();
  };
  const relay = new ClientRelay({
    send: sendFrame,
    releaseSentCredit: (id, stream, bytes) => outboundSender?.releaseDataCredit(id, stream, bytes),
    releaseSession: (id) => outboundSender?.releaseSession(id),
    historyNormalizer: historyNormalizerOptionsFromEnv(),
    onHistoryEvent: hooks.onHistoryEvent,
  });

  const clearTimers = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (pongTimer) clearTimeout(pongTimer);
    if (healthTimer) clearInterval(healthTimer);
    heartbeatTimer = healthTimer = pongTimer = null;
  };

  const stop = () => {
    stopped = true;
    clearTimers();
    outboundSender?.close();
    try { ws?.close(); } catch { /* noop */ }
  };

  const abort = () => stop();
  if (hooks.signal?.aborted) stop();
  else hooks.signal?.addEventListener?.('abort', abort, { once: true });

  if (installSignalHandlers) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }

  try {
    while (!stopped) {
      let conn;
      try {
        conn = await openConnection(config.endpoint, current, {
          delivery: hooks.delivery ?? config.delivery ?? current.delivery ?? 'agent',
          deploymentMode: hooks.deploymentMode ?? config.deploymentMode ?? current.deploymentMode,
          dshVersion: config.dshVersion ?? null,
          signal: hooks.signal,
        });
      } catch (err) {
        if (err instanceof AbortError || err?.name === 'AbortError' || err?.code === 'ABORT_ERR') {
          stopped = true;
          break;
        }
        if (err instanceof AuthError) {
          onStatus('stopped', `${err.message} — run 'dsh-hub-client join' again`);
          stopped = true;
          break;
        }
        onStatus('disconnected', err.message);
        await sleep(2000, hooks.signal);
        continue;
      }
      if (stopped || hooks.signal?.aborted) {
        try { conn.ws?.close(); } catch { /* noop */ }
        break;
      }
      ws = conn.ws;
      outboundSender = new OutboundFrameSender({ ws, limits: conn.welcome.limits });
      relay.setTarget(parseTarget(current.target));
      relay.setLimits(conn.welcome.limits);

      onStatus('connected', `instance ${current.instanceId} — relay ${current.target}`);
      let heartbeatSeq = 0;
      const sendHeartbeat = () => {
        const seq = heartbeatSeq++;
        sendFrame({ type: MSG.HEARTBEAT, seq, sentAt: Date.now() });
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          try { ws?.close(4000, 'pong timeout'); } catch { /* noop */ }
        }, conn.welcome.pongTimeoutMs ?? 45_000);
        pongTimer.unref?.();
      };
      sendHeartbeat();
      heartbeatTimer = setInterval(sendHeartbeat, conn.welcome.heartbeatIntervalMs ?? config.heartbeatMs);
      healthTimer = setInterval(async () => {
        const p = await probeLocalDsh(current.target).catch(() => ({ online: false }));
        sendFrame({ type: MSG.HEALTH, dshOnline: p.online, dshVersion: config.dshVersion ?? null });
      }, config.healthMs);
      heartbeatTimer.unref?.();
      healthTimer.unref?.();

      const closed = new Promise((resolve) => {
        if (ws.__dshHubClosed) {
          const terminal = classifyTerminalClose(ws.__dshHubClosed.code, ws.__dshHubClosed.reason);
          resolve(terminal
            ? { reason: 'auth', code: terminal.code, message: terminal.message }
            : { reason: 'close' });
          return;
        }
        ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data.toString()); } catch { return; }
          if (msg.type === MSG.BYE) {
            const authState = classifyAuthClosure(msg);
            if (authState) {
              onStatus('kicked', `hub closed tunnel: ${msg.reason ?? authState.code}`);
              resolve({ reason: 'auth', code: authState.code, message: authState.message });
              return;
            }
            resolve({ reason: 'bye' });
            return;
          }
          if (msg.type === MSG.PONG) {
            if (Number.isSafeInteger(msg.seq) && msg.seq === heartbeatSeq - 1) {
              if (pongTimer) clearTimeout(pongTimer);
              pongTimer = null;
            }
            return;
          }
          relay.handleFrame(msg);
        });
        ws.on('close', (code, reasonBuffer) => {
          const terminal = classifyTerminalClose(code, reasonBuffer.toString());
          if (terminal) {
            resolve({ reason: 'auth', code: terminal.code, message: terminal.message });
            return;
          }
          resolve({ reason: 'close' });
        });
        ws.on('error', () => resolve({ reason: 'error' }));
      });

      const outcome = await closed;
      clearTimers();
      relay.terminateAll();
      outboundSender?.close();
      outboundSender = null;
      onStatus('disconnected', `tunnel ${outcome.reason}`);

      if (outcome.reason === 'auth') {
        onStatus('stopped', `${outcome.message ?? outcome.code ?? 'token rejected'} — run 'dsh-hub-client join' again`);
        stopped = true;
        break;
      }
      if (!stopped) await sleep(2000, hooks.signal); // reconnect backoff
    }
  } finally {
    clearTimers();
    relay.terminateAll();
    outboundSender?.close();
    outboundSender = null;
    hooks.signal?.removeEventListener?.('abort', abort);
    if (installSignalHandlers) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
  return { ok: true, stopped: true };
}

function safePositiveBytes(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function openConnection(endpoint, creds, options = {}) {
  const url = wsUrlFor(endpoint, '/agent');
  const ws = new WebSocket(url);
  const abort = () => {
    ws.once('error', () => { /* abort may emit a synthetic ws error before close */ });
    try { ws.terminate(); } catch { /* noop */ }
  };
  if (options.signal?.aborted) {
    abort();
    throw new AbortError();
  }
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(t);
      options.signal?.removeEventListener?.('abort', onAbort);
      ws.off('open', onOpen);
      ws.off('error', onError);
    };
    const onAbort = () => {
      cleanup();
      abort();
      reject(new AbortError());
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const t = setTimeout(() => {
      cleanup();
      abort();
      reject(new Error('connect timeout'));
    }, options.connectTimeoutMs ?? 10000);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    ws.once('open', onOpen);
    ws.once('error', onError);
  });

  // Hello handshake
  const welcome = await new Promise((resolve, reject) => {
    let welcomed = false;
    let settled = false;
    const target = parseTarget(creds.target);
    const hello = {
      type: MSG.HELLO,
      proto: PROTO_VERSION,
      minor: PROTO_MINOR,
      capabilities: REQUIRED_CAPABILITIES,
      token: creds.instanceToken,
      instanceId: creds.instanceId,
      installationId: creds.installationId ?? null,
      delivery: options.delivery ?? creds.delivery ?? 'agent',
      ...(normalizeDeploymentMode(options.deploymentMode ?? creds.deploymentMode)
        ? { deploymentMode: normalizeDeploymentMode(options.deploymentMode ?? creds.deploymentMode) }
        : {}),
      hostname: creds.hostname ?? '',
      clientVersion: creds.clientVersion ?? '0.1.3',
      dshVersion: options.dshVersion ?? creds.dshVersion ?? null,
      target: { host: target.host, port: target.port },
      offeredLimits: DEFAULT_LIMITS,
    };
    const cleanup = () => {
      clearTimeout(t);
      options.signal?.removeEventListener?.('abort', onAbort);
      ws.off('message', onMessage);
      ws.off('error', onError);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === MSG.WELCOME) {
        welcomed = true;
        const validLimits = validateLimits(msg.limits ?? {});
        if (!validLimits.ok) {
          settle(reject, new Error(validLimits.message));
          return;
        }
        settle(resolve, msg);
      } else if (msg.type === MSG.UNAUTHORIZED) {
        ws.off('close', onClose);
        settle(reject, new AuthError(msg.message || 'unauthorized', msg.code || 'UNAUTHORIZED'));
      } else if (msg.type === MSG.ERROR) {
        ws.off('close', onClose);
        settle(reject, new Error(msg.message || 'handshake error'));
      }
    };
    const onClose = (code, reasonBuffer) => {
      const reason = reasonBuffer.toString();
      ws.__dshHubClosed = { code, reason };
      if (welcomed) return;
      const terminal = classifyTerminalClose(code, reason);
      if (terminal) {
        settle(reject, new AuthError(terminal.message, terminal.code));
        return;
      }
      const suffix = code || reason.length ? ` (${code}${reason.length ? `: ${reason}` : ''})` : '';
      settle(reject, new Error(`closed during handshake${suffix}`));
    };
    const onError = (err) => {
      settle(reject, err);
    };
    const onAbort = () => {
      abort();
      settle(reject, new AbortError());
    };
    const t = setTimeout(() => {
      abort();
      settle(reject, new Error('welcome timeout'));
    }, options.handshakeTimeoutMs ?? 10000);
    ws.on('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
    ws.send(JSON.stringify(hello));
  });
  return { ws, welcome };
}
