import http from 'node:http';
import { WebSocket } from 'ws';

import {
  DEFAULT_LIMITS,
  MSG,
  STREAMS,
  chunkBuffer,
  decodeChunk,
  encodeChunk,
} from './protocol.js';
import { log, normalizeHeaders } from './util.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export class ClientRelay {
  constructor({ send, releaseSentCredit = () => {}, releaseSession = () => {} }) {
    this.send = send;
    this.releaseSentCredit = releaseSentCredit;
    this.releaseSession = releaseSession;
    this.target = null;
    this.limits = DEFAULT_LIMITS;
    this.httpSessions = new Map();
    this.wsSessions = new Map();
  }

  setTarget(target) {
    this.target = target;
  }

  setLimits(limits) {
    this.limits = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  }

  handleFrame(msg) {
    switch (msg.type) {
      case MSG.REQ:
        this.#handleReq(msg);
        break;
      case MSG.REQ_DATA:
      case MSG.REQ_END:
      case MSG.CREDIT: {
        const s = this.httpSessions.get(msg.id) ?? this.wsSessions.get(msg.id);
        if (s) s.handleFrame(msg);
        else if (msg.type !== MSG.CREDIT) log('[client-relay] dropped frame for missing session', relayFrameSummary(msg));
        break;
      }
      case MSG.WS_REQ:
        this.#handleWsReq(msg);
        break;
      case MSG.WS_DATA:
      case MSG.WS_END:
      case MSG.CANCEL:
      case MSG.ERROR: {
        const s = this.wsSessions.get(msg.id) ?? this.httpSessions.get(msg.id);
        if (s) s.handleFrame(msg);
        else log('[client-relay] dropped frame for missing session', relayFrameSummary(msg));
        break;
      }
      default:
        break;
    }
  }

  terminateAll() {
    for (const s of [...this.httpSessions.values()]) s.destroy();
    for (const s of [...this.wsSessions.values()]) s.destroy();
    this.httpSessions.clear();
    this.wsSessions.clear();
  }

  #handleReq(msg) {
    const session = new LocalHttpSession({
      msg,
      target: this.target,
      limits: this.limits,
      send: this.send,
      releaseSentCredit: this.releaseSentCredit,
      onDone: () => {
        this.releaseSession(msg.id);
        this.httpSessions.delete(msg.id);
      },
    });
    this.httpSessions.set(msg.id, session);
    session.start();
  }

  #handleWsReq(msg) {
    log('[client-relay] wsReq received', {
      id: msg.id,
      path: wsPathname(msg.path),
    });
    const session = new LocalWsSession({
      msg,
      target: this.target,
      limits: this.limits,
      send: this.send,
      releaseSentCredit: this.releaseSentCredit,
      onDone: () => {
        this.releaseSession(msg.id);
        this.wsSessions.delete(msg.id);
      },
    });
    this.wsSessions.set(msg.id, session);
    session.connect();
  }
}

class LocalHttpSession {
  constructor({ msg, target, limits, send, releaseSentCredit, onDone }) {
    this.id = msg.id;
    this.msg = msg;
    this.target = target;
    this.limits = limits;
    this.send = send;
    this.releaseSentCredit = releaseSentCredit;
    this.onDone = onDone;
    this.req = null;
    this.closed = false;
    this.finished = false;
    this.reqSeq = 0;
    this.reqBytes = 0;
    this.expectedReqBytes = Number.isSafeInteger(msg.bodyLength) ? msg.bodyLength : null;
    this.resSeq = 0;
    this.resBytes = 0;
    this.resCredit = limits.initialStreamCreditBytes;
    this.resCreditWaiters = [];
    this.responsePump = Promise.resolve();
  }

  start() {
    const { host, port } = this.target;
    const headers = normalizeHeaders(this.msg.headers);
    headers.host = `${host}:${port}`;
    for (const key of HOP_BY_HOP) delete headers[key];
    delete headers['content-length'];
    if (this.expectedReqBytes !== null) headers['content-length'] = String(this.expectedReqBytes);

    this.req = http.request({ host, port, method: this.msg.method, path: this.msg.path, headers }, (res) => {
      const respHeaders = normalizeHeaders(res.headers);
      for (const key of HOP_BY_HOP) delete respHeaders[key];
      this.send({
        type: MSG.RESP,
        id: this.id,
        status: res.statusCode ?? 200,
        statusText: res.statusMessage ?? '',
        headers: respHeaders,
      });
      res.on('data', (chunk) => {
        res.pause();
        this.responsePump = this.responsePump
          .then(() => this.#sendResponseChunk(chunk))
          .finally(() => {
            if (!this.closed) res.resume();
          });
      });
      res.on('end', () => {
        this.responsePump
          .then(() => {
            if (!this.closed) this.send({ type: MSG.RESP_END, id: this.id, seq: this.resSeq, bytes: this.resBytes });
          })
          .finally(() => this.#finish());
      });
    });
    this.req.on('error', (err) => {
      if (!this.closed) {
        log('[client-relay-http] local DSH request error', {
          id: this.id,
          method: this.msg.method,
          path: wsPathname(this.msg.path),
          message: err.message,
        });
        this.send({ type: MSG.ERROR, id: this.id, code: 'UPSTREAM_DOWN', message: err.message });
      }
      this.#finish();
    });
  }

  async #sendResponseChunk(rawChunk) {
    for (const chunk of chunkBuffer(rawChunk, this.limits.maxChunkDecodedBytes)) {
      if (this.closed) return;
      this.resBytes += chunk.length;
      if (this.resBytes > this.limits.maxHttpBodyBytes) {
        this.send({ type: MSG.ERROR, id: this.id, code: 'LIMIT_EXCEEDED', message: 'response body too large' });
        this.destroy();
        return;
      }
      await this.#waitRespCredit(chunk.length);
      if (this.closed) return;
      this.resCredit -= chunk.length;
      try {
        await this.send(
          { type: MSG.RESP_DATA, id: this.id, seq: this.resSeq++, data: encodeChunk(chunk) },
          { stream: STREAMS.RESP, decodedBytes: chunk.length },
        );
      } catch (err) {
        this.#fail(relayErrorCode(err), err.message);
        return;
      }
    }
  }

  async #waitRespCredit(bytes) {
    while (!this.closed && this.resCredit < bytes) {
      await new Promise((resolve) => this.resCreditWaiters.push(resolve));
    }
  }

  #addRespCredit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.send({ type: MSG.ERROR, id: this.id, code: 'PROTOCOL_ERROR', message: 'bad credit' });
      this.destroy();
      return;
    }
    this.releaseSentCredit(this.id, STREAMS.RESP, bytes);
    this.resCredit = Math.min(this.resCredit + bytes, this.limits.initialStreamCreditBytes);
    for (const resolve of this.resCreditWaiters.splice(0)) resolve();
  }

  handleFrame(msg) {
    if (this.closed && msg.type !== MSG.CREDIT) return;
    try {
      if (msg.type === MSG.REQ_DATA) {
        if (msg.seq !== this.reqSeq) throw new Error('request seq mismatch');
        const decoded = decodeChunk(msg.data ?? '', this.limits);
        this.reqSeq += 1;
        this.reqBytes += decoded.length;
        if (this.reqBytes > this.limits.maxHttpBodyBytes) throw new Error('request body too large');
        const flushed = this.req.write(decoded);
        const credit = () => this.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.REQ, bytes: decoded.length });
        if (flushed) credit();
        else this.req.once('drain', credit);
      } else if (msg.type === MSG.REQ_END) {
        if (Number.isSafeInteger(msg.bytes) && msg.bytes !== this.reqBytes) throw new Error('request byte count mismatch');
        if (this.expectedReqBytes !== null && this.expectedReqBytes !== this.reqBytes) {
          throw new Error('request length mismatch');
        }
        this.req.end();
      } else if (msg.type === MSG.CREDIT && msg.stream === STREAMS.RESP) {
        this.#addRespCredit(msg.bytes);
      } else if (msg.type === MSG.CANCEL || msg.type === MSG.ERROR) {
        this.destroy();
      }
    } catch (err) {
      this.send({ type: MSG.ERROR, id: this.id, code: 'PROTOCOL_ERROR', message: err.message });
      this.destroy();
    }
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    for (const resolve of this.resCreditWaiters.splice(0)) resolve();
    this.onDone();
  }

  #fail(code, message) {
    if (this.closed) return;
    this.send({ type: MSG.ERROR, id: this.id, code, message });
    this.destroy();
  }

  destroy() {
    if (this.finished) return;
    this.closed = true;
    try { this.req?.destroy(); } catch { /* noop */ }
    this.#finish();
  }
}

class LocalWsSession {
  constructor({ msg, target, limits, send, releaseSentCredit, onDone }) {
    this.id = msg.id;
    this.msg = msg;
    this.target = target;
    this.limits = limits;
    this.send = send;
    this.releaseSentCredit = releaseSentCredit;
    this.onDone = onDone;
    this.ws = null;
    this.open = false;
    this.closed = false;
    this.finished = false;
    this.sendMessageId = 0;
    this.recvMessageId = 0;
    this.recvSeq = 0;
    this.recvParts = [];
    this.recvBytes = 0;
    this.recvBinary = null;
    this.sendCredit = limits.initialStreamCreditBytes;
    this.sendCreditWaiters = [];
    this.sendQueue = Promise.resolve();
    this.openTimer = null;
  }

  connect() {
    const { host, port } = this.target;
    const headers = normalizeHeaders(this.msg.headers);
    headers.host = `${host}:${port}`;
    for (const key of HOP_BY_HOP) delete headers[key];
    const url = `ws://${host}:${port}${this.msg.path}`;
    log('[client-relay-ws] connecting local DSH websocket', {
      id: this.id,
      path: wsPathname(this.msg.path),
    });
    try {
      this.ws = new WebSocket(url, this.msg.protocols ?? [], {
        headers,
        perMessageDeflate: false,
        handshakeTimeout: serviceWsOpenTimeoutMs(this.limits),
      });
    } catch (err) {
      this.send({ type: MSG.ERROR, id: this.id, code: 'UPSTREAM_DOWN', message: err.message });
      this.#finish();
      return;
    }
    this.openTimer = setTimeout(() => {
      if (this.open || this.closed) return;
      log('[client-relay-ws] local DSH websocket open timeout', {
        id: this.id,
        path: wsPathname(this.msg.path),
        timeoutMs: localWsOpenTimeoutMs(this.limits),
      });
      this.send({
        type: MSG.ERROR,
        id: this.id,
        code: 'UPSTREAM_TIMEOUT',
        message: 'local DSH websocket open timeout',
      });
      this.destroy();
    }, localWsOpenTimeoutMs(this.limits));
    this.openTimer.unref?.();
    this.ws.on('open', () => {
      if (this.openTimer) {
        clearTimeout(this.openTimer);
        this.openTimer = null;
      }
      this.open = true;
      log('[client-relay-ws] local DSH websocket open', {
        id: this.id,
        path: wsPathname(this.msg.path),
      });
      this.send({
        type: MSG.WS_OPEN,
        id: this.id,
        status: 101,
        statusText: 'Switching Protocols',
        protocol: this.ws.protocol || null,
        headers: {},
      });
    });
    this.ws.on('message', (data, isBinary) => {
      this.sendQueue = this.sendQueue
        .then(() => this.#sendWsMessage(data, !!isBinary))
        .catch((err) => this.#error(relayErrorCode(err), err.message));
    });
    this.ws.on('close', (code, reason) => {
      const cleanReason = cleanCloseReason(reason?.toString() ?? '');
      if (!this.open && !this.closed) {
        log('[client-relay-ws] local DSH websocket closed before open', {
          id: this.id,
          path: wsPathname(this.msg.path),
          code: code ?? 1000,
          reason: cleanReason,
        });
        this.send({
          type: MSG.ERROR,
          id: this.id,
          code: 'UPSTREAM_DOWN',
          message: cleanReason ? `local DSH websocket closed before open: ${cleanReason}` : 'local DSH websocket closed before open',
        });
        this.#finish();
        return;
      }
      if (!this.closed) this.send({ type: MSG.WS_END, id: this.id, code: code ?? 1000, reason: cleanReason });
      this.#finish();
    });
    this.ws.on('error', (err) => {
      if (!this.open && !this.closed) {
        log('[client-relay-ws] local DSH websocket error before open', {
          id: this.id,
          path: wsPathname(this.msg.path),
          message: err.message,
        });
        this.send({ type: MSG.ERROR, id: this.id, code: 'UPSTREAM_DOWN', message: err.message });
        this.#finish();
      }
    });
  }

  async #sendWsMessage(data, binary) {
    if (this.closed) return;
    const chunks = chunkBuffer(data, this.limits.maxChunkDecodedBytes);
    const messageId = this.sendMessageId++;
    for (let seq = 0; seq < chunks.length; seq += 1) {
      const chunk = chunks[seq];
      await this.#waitSendCredit(chunk.length);
      if (this.closed) return;
      this.sendCredit -= chunk.length;
      await this.send(
        {
          type: MSG.WS_DATA,
          id: this.id,
          messageId,
          seq,
          final: seq === chunks.length - 1,
          binary,
          data: encodeChunk(chunk),
        },
        { stream: STREAMS.WS_I2C, decodedBytes: chunk.length },
      );
    }
  }

  async #waitSendCredit(bytes) {
    while (!this.closed && this.sendCredit < bytes) {
      await new Promise((resolve) => this.sendCreditWaiters.push(resolve));
    }
  }

  #addSendCredit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.#error('PROTOCOL_ERROR', 'bad credit');
      return;
    }
    this.releaseSentCredit(this.id, STREAMS.WS_I2C, bytes);
    this.sendCredit = Math.min(this.sendCredit + bytes, this.limits.initialStreamCreditBytes);
    for (const resolve of this.sendCreditWaiters.splice(0)) resolve();
  }

  handleFrame(msg) {
    if (this.closed && msg.type !== MSG.CREDIT) return;
    try {
      if (msg.type === MSG.CREDIT && msg.stream === STREAMS.WS_I2C) {
        this.#addSendCredit(msg.bytes);
      } else if (msg.type === MSG.WS_DATA) {
        this.#handleWsData(msg);
      } else if (msg.type === MSG.WS_END) {
        this.closed = true;
        try { this.ws?.close(msg.code ?? 1000, msg.reason ?? ''); } catch { /* noop */ }
        this.#finish();
      } else if (msg.type === MSG.CANCEL || msg.type === MSG.ERROR) {
        this.destroy();
      }
    } catch (err) {
      this.send({ type: MSG.ERROR, id: this.id, code: 'PROTOCOL_ERROR', message: err.message });
      this.destroy();
    }
  }

  #handleWsData(msg) {
    if (msg.messageId !== this.recvMessageId || msg.seq !== this.recvSeq) throw new Error('ws seq mismatch');
    const binary = msg.binary === true;
    if (this.recvSeq === 0) this.recvBinary = binary;
    if (binary !== this.recvBinary) throw new Error('ws binary flag changed');
    const decoded = decodeChunk(msg.data ?? '', this.limits);
    this.recvBytes += decoded.length;
    if (this.recvBytes > this.limits.maxWsMessageBytes) throw new Error('ws message too large');
    this.recvParts.push(decoded);
    this.recvSeq += 1;
    if (msg.final === true) {
      const payload = Buffer.concat(this.recvParts);
      this.ws.send(payload, { binary }, (err) => {
        if (!err) this.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.WS_C2I, bytes: payload.length });
      });
      this.recvMessageId += 1;
      this.recvSeq = 0;
      this.recvParts = [];
      this.recvBytes = 0;
      this.recvBinary = null;
    }
  }

  #error(code, message) {
    if (this.closed) return;
    this.send({ type: MSG.ERROR, id: this.id, code, message });
    this.destroy();
  }

  #finish() {
    if (this.finished) return;
    this.finished = true;
    this.closed = true;
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    for (const resolve of this.sendCreditWaiters.splice(0)) resolve();
    this.onDone();
  }

  destroy() {
    if (this.finished) return;
    this.closed = true;
    try { this.ws?.terminate(); } catch { /* noop */ }
    this.#finish();
  }
}

function cleanCloseReason(reason) {
  let out = String(reason ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}

function wsPathname(path) {
  try {
    return new URL(String(path ?? '/'), 'http://local').pathname;
  } catch {
    return '/';
  }
}

function localWsOpenTimeoutMs(limits) {
  const serviceTimeout = serviceWsOpenTimeoutMs(limits);
  const margin = Math.min(1_000, Math.max(1, Math.floor(serviceTimeout / 10)));
  return Math.max(1, serviceTimeout - margin);
}

function serviceWsOpenTimeoutMs(limits) {
  const serviceTimeout = Number.isSafeInteger(limits?.wsOpenTimeoutMs)
    ? limits.wsOpenTimeoutMs
    : DEFAULT_LIMITS.wsOpenTimeoutMs;
  return Math.max(1, serviceTimeout);
}

function relayFrameSummary(msg) {
  return {
    type: msg?.type ?? null,
    id: msg?.id ?? null,
  };
}

function relayErrorCode(err) {
  return err?.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'PROTOCOL_ERROR';
}
