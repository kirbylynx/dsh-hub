import { once } from 'node:events';

import {
  MSG,
  STREAMS,
  chunkBuffer,
  decodeChunk,
  encodeChunk,
} from './protocol.js';
import { forwardHeaders, forwardRespHeaders, log, normalizeHeaders } from './util.js';

const WS_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** HTTP request relay session: browser request -> tunnel -> local DSH web. */
export class HttpSession {
  constructor({ id, tunnel, req, res }) {
    this.id = id;
    this.tunnel = tunnel;
    this.req = req;
    this.res = res;
    this.done = false;
    this.reqSeq = 0;
    this.resSeq = 0;
    this.reqBytes = 0;
    this.resBytes = 0;
    this.reqCredit = tunnel.limits.initialStreamCreditBytes;
    this.reqCreditWaiters = [];
    this.reqCreditWaitBytes = 0;
    this.resPendingCreditBytes = 0;
    this.resDrainCreditBytes = 0;
    this.resDrainCreditHandler = null;

    req.on('aborted', () => this.cancel('CLIENT_GONE', 'browser request closed'));
    res.on('close', () => {
      if (!this.done) this.cancel('CLIENT_GONE', 'browser response closed');
    });
  }

  start(headers) {
    const bodyLength = parseKnownLength(this.req.headers['content-length']);
    const hasBody = requestMayHaveBody(this.req, bodyLength);
    if (hasBody) this.req.pause();
    this.tunnel.send({
      type: MSG.REQ,
      id: this.id,
      method: this.req.method,
      path: this.req.url,
      headers,
      bodyLength,
    });
    if (!hasBody || this.req.readableEnded || this.req.complete) {
      this.tunnel.send({ type: MSG.REQ_END, id: this.id, seq: this.reqSeq, bytes: this.reqBytes });
      return;
    }
    this.#pumpRequestBody().catch((err) => this.fail(relayErrorCode(err), err.message));
    this.req.resume();
  }

  async #pumpRequestBody() {
    for await (const rawChunk of this.req) {
      if (this.done) return;
      for (const chunk of chunkBuffer(rawChunk, this.tunnel.limits.maxChunkDecodedBytes)) {
        if (this.done) return;
        this.reqBytes += chunk.length;
        if (this.reqBytes > this.tunnel.limits.maxHttpBodyBytes) {
          this.cancel('LIMIT_EXCEEDED', 'request body too large');
          return;
        }
        await this.#waitReqCredit(chunk.length);
        if (this.done) return;
        this.reqCredit -= chunk.length;
        await this.tunnel.sendData({
          type: MSG.REQ_DATA,
          id: this.id,
          seq: this.reqSeq++,
          data: encodeChunk(chunk),
        }, { stream: STREAMS.REQ, decodedBytes: chunk.length });
      }
    }
    if (!this.done) this.tunnel.send({ type: MSG.REQ_END, id: this.id, seq: this.reqSeq, bytes: this.reqBytes });
  }

  async #waitReqCredit(bytes) {
    let tracked = false;
    try {
      while (!this.done && this.reqCredit < bytes) {
        if (!tracked) {
          this.reqCreditWaitBytes += bytes;
          tracked = true;
        }
        await new Promise((resolve) => this.reqCreditWaiters.push(resolve));
      }
    } finally {
      if (tracked) this.reqCreditWaitBytes = Math.max(0, this.reqCreditWaitBytes - bytes);
    }
  }

  #addReqCredit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.fail('PROTOCOL_ERROR', 'bad credit');
      return;
    }
    this.tunnel.releaseDataCredit(this.id, STREAMS.REQ, bytes);
    this.reqCredit = Math.min(this.reqCredit + bytes, this.tunnel.limits.initialStreamCreditBytes);
    for (const resolve of this.reqCreditWaiters.splice(0)) resolve();
  }

  handleFrame(type, msg) {
    if (this.done && type !== MSG.CREDIT) return;
    const { res } = this;
    try {
      if (type === MSG.CREDIT && msg.stream === STREAMS.REQ) {
        this.#addReqCredit(msg.bytes);
      } else if (type === MSG.RESP) {
        res.writeHead(validStatus(msg.status), cleanStatusText(msg.statusText), forwardRespHeaders(msg.headers));
      } else if (type === MSG.RESP_DATA) {
        if (msg.seq !== this.resSeq) throw new Error('response seq mismatch');
        const decoded = decodeChunk(msg.data ?? '', this.tunnel.limits);
        this.resSeq += 1;
        this.resBytes += decoded.length;
        if (this.resBytes > this.tunnel.limits.maxHttpBodyBytes) throw new Error('response body too large');
        const flushed = res.write(decoded);
        if (flushed) this.#sendResCredit(decoded.length);
        else this.#deferResCredit(decoded.length);
      } else if (type === MSG.RESP_END) {
        if (Number.isSafeInteger(msg.bytes) && msg.bytes !== this.resBytes) throw new Error('response byte count mismatch');
        this.done = true;
        res.end();
        // RESP_END 表示实例侧完整发送了响应；释放已交给 Node response
        // 队列的 pending credit，避免 client/plugin tunnel 总账残留。
        this.#clearResCreditState({ sendPendingCredit: true });
        this.#resolveReqCreditWaiters();
        this.tunnel.detachSession(this.id);
      } else if (type === MSG.ERROR) {
        this.#writeError(msg);
      } else if (type === MSG.CANCEL) {
        this.terminate(msg.message ?? 'cancelled');
      }
    } catch (err) {
      this.fail('PROTOCOL_ERROR', err.message);
    }
  }

  #writeError(msg) {
    log('[relay-http] upstream error', {
      ...httpSessionSummary(this.req, this.id),
      code: msg.code ?? null,
      message: msg.message ?? null,
    });
    this.done = true;
    if (!this.res.headersSent) {
      this.res.writeHead(httpStatusForRelayError(msg.code), { 'content-type': 'application/json' });
      this.res.end(JSON.stringify({ error: msg.message ?? 'relay error', code: msg.code ?? 'RELAY_ERROR' }));
    } else if (!this.res.writableEnded) {
      this.res.destroy();
    }
    this.#clearResCreditState({ sendPendingCredit: false });
    this.#resolveReqCreditWaiters();
    this.tunnel.detachSession(this.id);
  }

  fail(code, message) {
    if (this.done) return;
    this.tunnel.send({ type: MSG.ERROR, id: this.id, code, message, fatal: false });
    this.#writeError({ code, message });
  }

  cancel(code, message) {
    if (this.done) return;
    log('[relay-http] browser request cancelled', {
      ...httpSessionSummary(this.req, this.id),
      code,
      message,
    });
    this.done = true;
    this.#clearResCreditState({ sendPendingCredit: false });
    this.#resolveReqCreditWaiters();
    this.tunnel.send({ type: MSG.CANCEL, id: this.id, code, message });
    this.tunnel.detachSession(this.id);
    if (!this.res.writableEnded) this.res.destroy();
  }

  terminate(reason = 'instance tunnel closed') {
    if (this.done) return;
    log('[relay-http] relay session terminated', {
      ...httpSessionSummary(this.req, this.id),
      reason,
    });
    this.done = true;
    this.#clearResCreditState({ sendPendingCredit: false });
    this.#resolveReqCreditWaiters();
    this.tunnel.detachSession(this.id);
    try {
      if (!this.res.headersSent) this.res.writeHead(502, { 'content-type': 'application/json' });
      if (!this.res.writableEnded) this.res.end(JSON.stringify({ error: reason }));
    } catch {
      /* noop */
    }
  }

  #resolveReqCreditWaiters() {
    for (const resolve of this.reqCreditWaiters.splice(0)) resolve();
  }

  #sendResCredit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
    this.tunnel.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.RESP, bytes });
  }

  #deferResCredit(bytes) {
    this.resPendingCreditBytes += bytes;
    this.resDrainCreditBytes += bytes;
    if (this.resDrainCreditHandler) return;
    this.resDrainCreditHandler = () => {
      const creditBytes = this.resDrainCreditBytes;
      this.resDrainCreditBytes = 0;
      this.resPendingCreditBytes = Math.max(0, this.resPendingCreditBytes - creditBytes);
      this.resDrainCreditHandler = null;
      this.#sendResCredit(creditBytes);
    };
    this.res.once('drain', this.resDrainCreditHandler);
  }

  #clearResCreditState({ sendPendingCredit }) {
    if (this.resDrainCreditHandler) {
      this.res.off?.('drain', this.resDrainCreditHandler);
      this.resDrainCreditHandler = null;
    }
    const creditBytes = this.resDrainCreditBytes;
    this.resDrainCreditBytes = 0;
    this.resPendingCreditBytes = 0;
    if (sendPendingCredit) this.#sendResCredit(creditBytes);
  }

  metricsSnapshot() {
    const httpResponseBufferedBytes = safeBufferedLength(this.res?.writableLength);
    return {
      type: 'http',
      browserToInstanceQueuedBytes: safeBufferedLength(this.req?.readableLength) + this.reqCreditWaitBytes,
      instanceToBrowserQueuedBytes: httpResponseBufferedBytes + this.resPendingCreditBytes,
      browserToInstanceUncreditedBytes: Math.max(0, this.tunnel.limits.initialStreamCreditBytes - this.reqCredit),
      instanceToBrowserUncreditedBytes: this.resPendingCreditBytes,
      httpResponseBufferedBytes,
      browserWebSocketBufferedBytes: 0,
      reqCreditWaiters: this.reqCreditWaiters.length,
      reqCreditWaitBytes: this.reqCreditWaitBytes,
      wsCreditWaiters: 0,
      wsCreditWaitBytes: 0,
    };
  }
}

/** Pending browser WS session; the browser 101 is delayed until client sends wsOpen. */
export class PendingWSSession {
  constructor({ id, tunnel, req, socket, head, wss, rejectUpgrade, openTimeoutMs }) {
    this.id = id;
    this.tunnel = tunnel;
    this.req = req;
    this.socket = socket;
    this.head = head;
    this.wss = wss;
    this.rejectUpgrade = rejectUpgrade;
    this.done = false;
    this.openTimer = setTimeout(() => {
      log('[relay-ws] upstream open timeout', wsPendingSummary(this.req, this.id));
      this.tunnel.send({ type: MSG.CANCEL, id: this.id, code: 'TIMEOUT', message: 'websocket open timeout' });
      this.#reject(504);
    }, openTimeoutMs);
    this.openTimer.unref?.();
    this.browserCloseHandler = () => {
      if (this.done) return;
      log('[relay-ws] browser closed before upstream open', wsPendingSummary(this.req, this.id));
      this.tunnel.send({ type: MSG.CANCEL, id: this.id, code: 'CLIENT_GONE', message: 'browser websocket closed before upstream open' });
      this.#finishWithoutResponse();
    };
    socket.once('close', this.browserCloseHandler);
    socket.once('end', this.browserCloseHandler);
    socket.once('error', this.browserCloseHandler);
  }

  start(headers, protocols) {
    const url = new URL(this.req.url, 'http://relay');
    const sent = this.tunnel.send({ type: MSG.WS_REQ, id: this.id, path: url.pathname + url.search, headers, protocols });
    if (!sent) {
      log('[relay-ws] upstream request send failed', wsPendingSummary(this.req, this.id));
      this.#reject(502);
    }
  }

  handleFrame(type, msg) {
    if (this.done) return;
    if (type === MSG.WS_OPEN) {
      if (this.socket.destroyed || !this.socket.writable) {
        log('[relay-ws] browser socket already closed before upstream open', wsPendingSummary(this.req, this.id));
        this.tunnel.send({ type: MSG.CANCEL, id: this.id, code: 'CLIENT_GONE', message: 'browser websocket closed before upstream open' });
        this.#finishWithoutResponse();
        return;
      }
      if (msg.protocol !== null && msg.protocol !== undefined && !requestedProtocols(this.req).includes(msg.protocol)) {
        this.tunnel.send({ type: MSG.CANCEL, id: this.id, code: 'PROTOCOL_ERROR', message: 'bad websocket protocol selection' });
        this.#reject(502);
        return;
      }
      clearTimeout(this.openTimer);
      try {
        this.wss.handleUpgrade(this.req, this.socket, this.head, (browserWs) => {
          const session = new WSSession({ id: this.id, tunnel: this.tunnel, browserWs });
          this.tunnel.attachSession(session);
        });
      } catch (err) {
        log('[relay-ws] browser upgrade failed after upstream open', {
          ...wsPendingSummary(this.req, this.id),
          message: err.message,
        });
        this.#reject(502);
        return;
      }
      this.done = true;
      this.#removeBrowserCloseHandlers();
    } else if (type === MSG.WS_ERR || type === MSG.ERROR) {
      log('[relay-ws] upstream error before open', {
        ...wsPendingSummary(this.req, this.id),
        code: msg.code ?? null,
        message: msg.message ?? null,
      });
      clearTimeout(this.openTimer);
      this.#reject(httpStatusForRelayError(msg.code));
    } else if (type === MSG.WS_END) {
      log('[relay-ws] upstream closed before open', {
        ...wsPendingSummary(this.req, this.id),
        code: msg.code ?? null,
        reason: msg.reason ?? null,
      });
      clearTimeout(this.openTimer);
      this.#reject(502);
    } else if (type === MSG.CANCEL) {
      clearTimeout(this.openTimer);
      this.#reject(499);
    }
  }

  #reject(status) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.openTimer);
    this.#removeBrowserCloseHandlers();
    this.tunnel.detachSession(this.id);
    this.rejectUpgrade(this.socket, status);
  }

  #finishWithoutResponse() {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.openTimer);
    this.#removeBrowserCloseHandlers();
    this.tunnel.detachSession(this.id);
    try { this.socket.destroy?.(); } catch { /* noop */ }
  }

  #removeBrowserCloseHandlers() {
    if (!this.browserCloseHandler) return;
    this.socket.off?.('close', this.browserCloseHandler);
    this.socket.off?.('end', this.browserCloseHandler);
    this.socket.off?.('error', this.browserCloseHandler);
    this.browserCloseHandler = null;
  }

  terminate() {
    this.#reject(502);
  }

  metricsSnapshot() {
    return {
      type: 'websocket_pending',
      browserToInstanceQueuedBytes: 0,
      instanceToBrowserQueuedBytes: 0,
      browserToInstanceUncreditedBytes: 0,
      instanceToBrowserUncreditedBytes: 0,
      httpResponseBufferedBytes: 0,
      browserWebSocketBufferedBytes: 0,
      reqCreditWaiters: 0,
      reqCreditWaitBytes: 0,
      wsCreditWaiters: 0,
      wsCreditWaitBytes: 0,
    };
  }
}

function wsPendingSummary(req, id) {
  const url = new URL(req.url, 'http://relay');
  return {
    id,
    host: req.headers.host ?? null,
    path: url.pathname,
  };
}

function httpSessionSummary(req, id) {
  const url = new URL(req?.url ?? '/', 'http://relay');
  return {
    id,
    method: req?.method ?? null,
    host: req?.headers?.host ?? null,
    path: url.pathname,
  };
}

/** WebSocket relay session: browser WS <-> tunnel <-> local DSH WS. */
export class WSSession {
  constructor({ id, tunnel, browserWs }) {
    this.id = id;
    this.tunnel = tunnel;
    this.browserWs = browserWs;
    this.done = false;
    this.sendMessageId = 0;
    this.recvMessageId = 0;
    this.recvSeq = 0;
    this.recvParts = [];
    this.recvBytes = 0;
    this.recvBinary = null;
    this.sendCredit = tunnel.limits.initialStreamCreditBytes;
    this.sendCreditWaiters = [];
    this.sendCreditWaitBytes = 0;
    this.sendQueuedBytes = 0;
    this.browserPendingCreditBytes = 0;
    this.sendQueue = Promise.resolve();

    browserWs.on('message', (data, isBinary) => {
      const queuedBytes = safeBufferedLength(data?.length);
      this.sendQueuedBytes += queuedBytes;
      this.sendQueue = this.sendQueue
        .then(() => this.#sendMessage(data, !!isBinary, queuedBytes))
        .catch((err) => this.#fail(relayErrorCode(err), err.message));
    });
    browserWs.on('close', (code, reason) => {
      if (this.done) return;
      this.done = true;
      this.tunnel.send({ type: MSG.WS_END, id: this.id, code: validCloseCode(code || 1000), reason: cleanCloseReason(reason?.toString() ?? '') });
      this.tunnel.detachSession(this.id);
    });
    browserWs.on('error', () => {});
  }

  async #sendMessage(data, binary, queuedBytes = 0) {
    try {
      if (this.done) return;
      const chunks = chunkBuffer(data, this.tunnel.limits.maxChunkDecodedBytes);
      const messageId = this.sendMessageId++;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        await this.#waitSendCredit(chunk.length);
        if (this.done) return;
        this.sendCredit -= chunk.length;
        await this.tunnel.sendData({
          type: MSG.WS_DATA,
          id: this.id,
          messageId,
          seq: index,
          final: index === chunks.length - 1,
          binary,
          data: encodeChunk(chunk),
        }, { stream: STREAMS.WS_C2I, decodedBytes: chunk.length });
      }
    } finally {
      this.sendQueuedBytes = Math.max(0, this.sendQueuedBytes - queuedBytes);
    }
  }

  async #waitSendCredit(bytes) {
    let tracked = false;
    try {
      while (!this.done && this.sendCredit < bytes) {
        if (!tracked) {
          this.sendCreditWaitBytes += bytes;
          tracked = true;
        }
        await new Promise((resolve) => this.sendCreditWaiters.push(resolve));
      }
    } finally {
      if (tracked) this.sendCreditWaitBytes = Math.max(0, this.sendCreditWaitBytes - bytes);
    }
  }

  #addSendCredit(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      this.#fail('PROTOCOL_ERROR', 'bad credit');
      return;
    }
    this.tunnel.releaseDataCredit(this.id, STREAMS.WS_C2I, bytes);
    this.sendCredit = Math.min(this.sendCredit + bytes, this.tunnel.limits.initialStreamCreditBytes);
    for (const resolve of this.sendCreditWaiters.splice(0)) resolve();
  }

  handleFrame(type, msg) {
    if (this.done && type !== MSG.CREDIT) return;
    if (type === MSG.CREDIT && msg.stream === STREAMS.WS_C2I) {
      this.#addSendCredit(msg.bytes);
    } else if (type === MSG.WS_DATA) {
      this.#handleWsData(msg);
    } else if (type === MSG.WS_END) {
      this.done = true;
      this.browserPendingCreditBytes = 0;
      this.tunnel.detachSession(this.id);
      try {
        this.browserWs.close(validCloseCode(msg.code ?? 1000), cleanCloseReason(msg.reason ?? ''));
      } catch {
        /* noop */
      }
    } else if (type === MSG.WS_ERR || type === MSG.ERROR || type === MSG.CANCEL) {
      this.done = true;
      this.browserPendingCreditBytes = 0;
      this.tunnel.detachSession(this.id);
      try {
        this.browserWs.close(1011, cleanCloseReason(msg.message ?? 'relay error'));
      } catch {
        /* noop */
      }
    }
  }

  #handleWsData(msg) {
    try {
      if (msg.messageId !== this.recvMessageId || msg.seq !== this.recvSeq) throw new Error('ws seq mismatch');
      const binary = msg.binary === true;
      if (this.recvSeq === 0) this.recvBinary = binary;
      if (binary !== this.recvBinary) throw new Error('ws binary flag changed');
      const decoded = decodeChunk(msg.data ?? '', this.tunnel.limits);
      this.recvBytes += decoded.length;
      if (this.recvBytes > this.tunnel.limits.maxWsMessageBytes) throw new Error('ws message too large');
      this.recvParts.push(decoded);
      this.recvSeq += 1;
      if (msg.final === true) {
        const payload = Buffer.concat(this.recvParts);
        this.browserPendingCreditBytes += payload.length;
        this.browserWs.send(payload, { binary }, (err) => {
          this.browserPendingCreditBytes = Math.max(0, this.browserPendingCreditBytes - payload.length);
          if (!err) this.tunnel.send({ type: MSG.CREDIT, id: this.id, stream: STREAMS.WS_I2C, bytes: payload.length });
        });
        this.recvMessageId += 1;
        this.recvSeq = 0;
        this.recvParts = [];
        this.recvBytes = 0;
        this.recvBinary = null;
      }
    } catch (err) {
      this.#fail('PROTOCOL_ERROR', err.message);
    }
  }

  #fail(code, message) {
    if (this.done) return;
    this.tunnel.send({ type: MSG.ERROR, id: this.id, code, message });
    this.terminate(message);
  }

  terminate(reason = 'instance tunnel closed') {
    if (this.done) return;
    this.done = true;
    this.browserPendingCreditBytes = 0;
    for (const resolve of this.sendCreditWaiters.splice(0)) resolve();
    this.tunnel.detachSession(this.id);
    try {
      this.browserWs.close(1011, cleanCloseReason(reason));
    } catch {
      /* noop */
    }
  }

  metricsSnapshot() {
    const browserWebSocketBufferedBytes = safeBufferedLength(this.browserWs?.bufferedAmount);
    return {
      type: 'websocket',
      browserToInstanceQueuedBytes: this.sendQueuedBytes,
      instanceToBrowserQueuedBytes: this.recvBytes + this.browserPendingCreditBytes + browserWebSocketBufferedBytes,
      browserToInstanceUncreditedBytes: Math.max(0, this.tunnel.limits.initialStreamCreditBytes - this.sendCredit),
      instanceToBrowserUncreditedBytes: this.recvBytes + this.browserPendingCreditBytes,
      httpResponseBufferedBytes: 0,
      browserWebSocketBufferedBytes,
      reqCreditWaiters: 0,
      reqCreditWaitBytes: 0,
      wsCreditWaiters: this.sendCreditWaiters.length,
      wsCreditWaitBytes: this.sendCreditWaitBytes,
    };
  }
}

export function forwardHttpRequest({ tunnel, req, res }) {
  if (tunnel.sessions.size >= tunnel.limits.maxSessions) return false;
  const hostHeader = tunnel.target.authority;
  const headers = forwardHeaders(normalizeHeaders(req.headers), { hostHeader });
  const id = tunnel.allocId();
  const session = new HttpSession({ id, tunnel, req, res });
  tunnel.attachSession(session);
  session.start(headers);
  return true;
}

export function forwardWsUpgrade({ tunnel, req, socket, head, wss, rejectUpgrade }) {
  if (tunnel.sessions.size >= tunnel.limits.maxSessions) return false;
  const hostHeader = tunnel.target.authority;
  const headers = forwardHeaders(normalizeHeaders(req.headers), { hostHeader });
  const protocols = requestedProtocols(req);
  const id = tunnel.allocId();
  const session = new PendingWSSession({
    id,
    tunnel,
    req,
    socket,
    head,
    wss,
    rejectUpgrade,
    openTimeoutMs: tunnel.limits.wsOpenTimeoutMs,
  });
  tunnel.attachSession(session);
  session.start(headers, protocols);
  return true;
}

export function requestedProtocols(req) {
  const raw = req.headers['sec-websocket-protocol'];
  if (!raw) return [];
  const out = [];
  for (const token of String(raw).split(',').map((item) => item.trim()).filter(Boolean)) {
    if (!WS_TOKEN.test(token) || Buffer.byteLength(token) > 128 || out.includes(token)) {
      const err = new Error('bad websocket protocol list');
      err.status = 400;
      throw err;
    }
    out.push(token);
  }
  if (out.length > 16) {
    const err = new Error('too many websocket protocols');
    err.status = 400;
    throw err;
  }
  return out;
}

function parseKnownLength(raw) {
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function requestMayHaveBody(req, bodyLength) {
  const method = String(req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return false;
  if (bodyLength !== null) return bodyLength > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

function safeBufferedLength(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function relayErrorCode(err) {
  return err?.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'PROTOCOL_ERROR';
}

function validStatus(status) {
  return Number.isSafeInteger(status) && status >= 200 && status <= 599 ? status : 502;
}

function cleanStatusText(value) {
  const text = String(value ?? '');
  return /^[^\u0000-\u001f\u007f]{0,256}$/.test(text) ? text : '';
}

function httpStatusForRelayError(code) {
  if (code === 'UPSTREAM_TIMEOUT') return 504;
  if (code === 'LIMIT_EXCEEDED') return 413;
  if (code === 'BAD_REQUEST') return 400;
  return 502;
}

function validCloseCode(code) {
  return Number.isInteger(code) && (code === 1000 || (code >= 3000 && code <= 4999)) ? code : 1000;
}

function cleanCloseReason(reason) {
  let out = String(reason ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100);
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
}
