import { log, now } from './util.js';
import { DEFAULT_LIMITS, MSG } from './protocol.js';

export class TunnelBackpressureError extends Error {
  constructor(message = 'tunnel backpressure limit exceeded') {
    super(message);
    this.name = 'TunnelBackpressureError';
    this.code = 'LIMIT_EXCEEDED';
  }
}

/**
 * A live instance tunnel: one outbound wss connection from an instance agent.
 * Relay sessions (one HTTP request or one WS relay) are attached here and
 * multiplexed over the single WebSocket by id.
 */
export class Tunnel {
  constructor({ ws, instanceId, tokenId, target, delivery, hostname, dshVersion, limits }) {
    this.ws = ws;
    this.instanceId = instanceId;
    this.tokenId = tokenId;
    this.target = target; // { host, port } — local DSH web the client forwards
    this.delivery = delivery;
    this.hostname = hostname;
    this.dshVersion = dshVersion;
    this.limits = limits ?? DEFAULT_LIMITS;
    this.dshOnline = true;
    this.dshHealthObserved = false;
    this.lastDshHealthAt = null;
    this.alive = true;
    this.sessions = new Map(); // id -> RelaySession
    this.nextId = 1;
    this.lastSeen = now();
    this.outboundUncreditedBytes = 0;
    this.outboundReservedBytes = 0;
    this.outboundUncreditedBySession = new Map();
    this.backpressureWaiters = [];
    this.transportBackpressured = false;
    this.lastOutboundSessionId = null;
  }

  allocId() {
    return String(this.nextId++);
  }

  send(obj) {
    if (!this.alive) return false;
    return this.#sendFrame(obj);
  }

  async sendData(obj, { decodedBytes, stream }) {
    const bytes = safePositiveBytes(decodedBytes);
    if (bytes <= 0) {
      this.send(obj);
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

  #sendFrame(obj) {
    if (!this.alive || this.ws?.readyState !== 1) {
      log('[tunnel] frame send skipped because tunnel is not open', tunnelFrameSummary(this, obj));
      return false;
    }
    try {
      this.ws.send(JSON.stringify(obj), (err) => {
        if (err) log('[tunnel] frame send failed', { ...tunnelFrameSummary(this, obj), message: err.message });
        this.#resolveBackpressureWaiters();
      });
      return true;
    } catch (err) {
      log('[tunnel] frame send failed', { ...tunnelFrameSummary(this, obj), message: err.message });
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
    const started = now();
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
      const remaining = this.limits.backpressureTimeoutMs - (now() - started);
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

  cancelSession(id, code, message) {
    this.send({ type: MSG.CANCEL, id, code, message });
    this.detachSession(id);
  }

  closeGracefully({ frame = null, closeCode = 1000, closeReason = 'bye' } = {}) {
    if (!this.alive) return;
    this.alive = false;
    this.outboundUncreditedBytes = 0;
    this.outboundReservedBytes = 0;
    this.outboundUncreditedBySession.clear();
    this.#resolveBackpressureWaiters();

    const finalize = () => {
      try {
        if (this.ws.readyState < this.ws.CLOSING) this.ws.close(closeCode, closeReason);
      } catch {
        /* noop */
      }
    };

    if (frame && this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(JSON.stringify(frame), () => finalize());
        return;
      } catch {
        /* noop */
      }
    }
    finalize();
  }

  attachSession(session) {
    this.sessions.set(session.id, session);
  }

  detachSession(id) {
    this.#releaseSessionOutboundData(id);
    this.sessions.delete(id);
  }

  closeSessions(reason) {
    for (const s of [...this.sessions.values()]) s.terminate(reason);
    this.sessions.clear();
  }

  markDead(options = null) {
    if (options) {
      this.closeGracefully(options);
      return;
    }
    this.alive = false;
    this.outboundUncreditedBytes = 0;
    this.outboundReservedBytes = 0;
    this.outboundUncreditedBySession.clear();
    this.#resolveBackpressureWaiters();
    try {
      if (this.ws.readyState < this.ws.CLOSING) this.ws.close(1000, 'tunnel closed');
      else this.ws.terminate();
    } catch {
      /* noop */
    }
  }

  #releaseSessionOutboundData(id) {
    const session = this.outboundUncreditedBySession.get(id);
    if (!session) return;
    let released = 0;
    for (const bytes of session.values()) released += bytes;
    this.outboundUncreditedBySession.delete(id);
    this.outboundUncreditedBytes = Math.max(0, this.outboundUncreditedBytes - released);
    this.#resolveBackpressureWaiters();
  }
}

function tunnelFrameSummary(tunnel, obj) {
  return {
    instanceId: tunnel.instanceId,
    type: obj?.type ?? null,
    id: obj?.id ?? null,
  };
}

function safePositiveBytes(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** Registry of active tunnels, keyed by instance id (v1: one tunnel per instance). */
export class TunnelRegistry {
  constructor() {
    this.tunnels = new Map();
  }

  get(instanceId) {
    return this.tunnels.get(instanceId) ?? null;
  }

  set(tunnel) {
    const prev = this.tunnels.get(tunnel.instanceId);
    if (prev && prev !== tunnel && prev.alive) {
      // Duplicate connection for the same instance: kill the old one.
      prev.markDead();
      prev.closeSessions('duplicate-connection');
    }
    this.tunnels.set(tunnel.instanceId, tunnel);
  }

  delete(instanceId) {
    const t = this.tunnels.get(instanceId);
    if (t) t.closeSessions('tunnel-closed');
    this.tunnels.delete(instanceId);
  }
}
