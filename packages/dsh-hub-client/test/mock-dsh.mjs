#!/usr/bin/env node
// Mock DSH web used by the smoke test: a tiny HTTP + WebSocket server that
// echoes the received Host header (to verify the §5.2 host-rewrite) and streams
// WS ticks on /api/events.mux.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = parseInt(process.argv[2] || '13180', 10);

const server = http.createServer((req, res) => {
  const host = req.headers.host;
  if (req.url === '/api/session.list') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = parseRpc(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'client-response',
        rpcId: rpc.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { id: 'sess-linked-1', workspaceId: 'ws-alpha' },
              { id: 'sess-linked-2', workspaceId: 'ws-alpha' },
              { id: 'sess-orphan-1', workspaceId: null },
            ],
          },
        },
      }));
    });
    return;
  }
  if (req.url === '/api/workspace.list') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = parseRpc(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'client-response',
        rpcId: rpc.rpcId,
        result: {
          ok: true,
          value: {
            items: [
              { id: 'ws-alpha', path: '/tmp/alpha', sessionIds: ['sess-linked-1', 'sess-linked-2', 'sess-stale-1'] },
              { id: 'ws-empty', path: '/tmp/empty', sessionIds: [] },
            ],
          },
        },
      }));
    });
    return;
  }
  if (req.url === '/api/echo') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, method: req.method, host, body, url: req.url }));
    });
    return;
  }
  if (req.url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, host }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><body><h1>mock DSH web</h1><p>received host: ${host}</p></body></html>`);
});

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', from: 'mock-dsh' }));
  const t = setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: 'tick', t: Date.now() }));
    } catch {
      /* noop */
    }
  }, 200);
  ws.on('message', (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
  ws.on('close', () => clearInterval(t));
});

const hostEvents = new WebSocketServer({ noServer: true });
hostEvents.on('connection', () => {
  // Intentionally idle: real DSH host events may open without emitting a frame
  // during a short compatibility probe.
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/events.mux') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    return;
  }
  if (req.url === '/api/events.host') {
    hostEvents.handleUpgrade(req, socket, head, (ws) => hostEvents.emit('connection', ws, req));
    return;
  }
  socket.destroy();
});

function parseRpc(body) {
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-dsh listening on http://127.0.0.1:${port}`);
});
