import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';

import { DbError, openDb, getMigrationInfo, getInstance, listInstances, listNamespaces, getNamespace,
         getNamespaceDetail, createNamespace, updateNamespace, rotateRegistryKey, revealRegistryKey,
         findRegistryKey, registerInstance,
         issueInstanceToken, findInstanceToken, diagnoseInstanceToken, getInstanceToken,
         rotateInstanceToken, revokeInstanceToken, revokeInstanceTokenWithAudit,
         issueReplacementGrant, findReplacementGrant, consumeReplacementGrant,
         runIdempotent, setInstanceConnection, recordAudit,
         getUser, getUserSummary, getUserByUsername, getActiveUserByUsername, isSystemAdmin, getNamespaceRole,
         listUsers, listNamespaceMembers, addNamespaceMembership, updateNamespaceMembershipRole,
         removeNamespaceMembership, setUserStatus, createInvite, listInvites, revokeInvite,
         findInviteByToken, createInvitePowChallenge, getInvitePowChallenge, consumeInvitePowChallenge,
         beginInviteConsumption, completeInviteConsumption, markInviteFailed, normalizeUsername,
         validatePassword, pruneInvitePowChallenges,
         listAuditEvents, recoverInstance, normalizeDeploymentMode, publicDeploymentMode,
         countActiveSystemAdmins } from './db.js';
import { authorize, memberActionForRole } from './authz.js';
import { GraphqlLldapClient, NoopLldapClient } from './lldap-client.js';
import { verifyPow } from './pow.js';
import { Tunnel, TunnelRegistry } from './tunnel.js';
import { forwardHttpRequest, forwardWsUpgrade } from './relay.js';
import { collectInstanceDiagnostics } from './diagnostics.js';
import { portalHtml } from './portal.js';
import { DEFAULT_LIMITS, MSG, PROTO_MINOR, PROTO_VERSION, REQUIRED_CAPABILITIES, negotiateLimits } from './protocol.js';
import { forwardHeaders, log, normalizeHeaders, now, rid } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function packageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

export class HubServer {
  constructor(config) {
    this.config = normalizeRuntimeConfig(config);
    this.serverVersion = packageVersion();
    // ensure db dir
    const dbPath = config.dbPath;
    const dir = path.dirname(path.resolve(dbPath));
    fs.mkdirSync(dir, { recursive: true });
    this.db = openDb(dbPath, this.config);
    this.migrationInfo = getMigrationInfo(this.db);
    this.tunnels = new TunnelRegistry();
    this.diagnosticCache = new Map();
    this.csrfSecret = crypto.randomBytes(32);
    this.cursorSecret = crypto.randomBytes(32);
    this.rateLimits = new Map();
    this.lldap = config.lldapClient ?? createLldapClient(this.config);
    this.metrics = createOperationalMetrics();
    this.dbWriteDepth = 0;
    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    this.http = http.createServer((req, res) => this.#handleRequest(req, res).catch((err) => {
      if (!res.headersSent) this.#error(res, err);
      else res.destroy();
    }));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => this.#handleUpgrade(req, socket, head));
    this.http.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
  }

  listen() {
    const { host, port } = this.config;
    this.http.listen(port, host, () => {
      log(`dsh-hub-service v${this.serverVersion} listening on http://${host}:${port}`);
      log(`base domain: ${this.config.baseDomain}  db: ${this.config.dbPath}`);
      if (this.config.devAuthUser) log(`DEV_AUTH_USER=${this.config.devAuthUser} (dev only — do not use in production)`);
      else log('auth: expecting Authelia forward-auth headers (X-Authenticated-User / Remote-User)');
      if (this.migrationInfo.kind === 'legacy') {
        log(`prototype database migrated; 0600 backup with legacy secrets: ${this.migrationInfo.backupPath}`);
        log('backup is not encrypted; keep it protected and delete it after validation if no longer needed');
        log(`legacy instances archived: ${this.migrationInfo.archivedInstances}; explicit re-enrollment required`);
      }
    });
    this._sweeper = setInterval(() => this.#sweepInactive(), Math.max(15000, this.config.inactiveMs / 2));
    this._sweeper.unref?.();
    this.#scheduleLldapBootstrapSync();
    return this;
  }

  close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = (async () => {
      if (this._sweeper) clearInterval(this._sweeper);
      if (this._lldapBootstrapTimer) clearTimeout(this._lldapBootstrapTimer);

      const httpClosed = new Promise((resolve) => {
        if (!this.http.listening) return resolve();
        this.http.close(() => resolve());
      });

      const sockets = [...this.wss.clients];
      const socketClosed = sockets.map((ws) => new Promise((resolve) => {
        if (ws.readyState === ws.CLOSED) return resolve();
        ws.once('close', resolve);
        try { ws.close(1001, 'service shutting down'); } catch { resolve(); }
      }));
      for (const tunnel of [...this.tunnels.tunnels.values()]) tunnel.markDead();

      let forceTimer;
      if (sockets.length) {
        forceTimer = setTimeout(() => {
          for (const ws of sockets) {
            try { if (ws.readyState !== ws.CLOSED) ws.terminate(); } catch { /* noop */ }
          }
        }, 1000);
        forceTimer.unref?.();
      }

      await Promise.all([httpClosed, ...socketClosed]);
      if (forceTimer) clearTimeout(forceTimer);
      this.eventLoopDelay.disable();
      try { this.db.close(); } catch { /* noop */ }
    })();
    return this._closePromise;
  }

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------
  #routeByHost(hostHeader) {
    const host = normalizeHostHeader(hostHeader);
    if (this.#hostMatches(host, this.config.portalHost)) {
      return { kind: 'portal', instanceId: null };
    }
    if (this.#hostMatches(host, this.config.controlHost)) {
      return { kind: 'control', instanceId: null };
    }
    const base = this.config.instanceBaseDomain;
    if (host.endsWith('.' + base) && host.length > base.length + 1) {
      const instanceId = host.slice(0, -(base.length + 1));
      if (/^inst-[a-z2-7]{26}$/.test(instanceId)) return { kind: 'instance', instanceId };
    }
    return { kind: 'unknown', instanceId: null };
  }

  #hostMatches(host, configured) {
    if (host === configured) return true;
    if (configured === 'localhost') return host === '127.0.0.1' || host === '::1';
    return false;
  }

  #allowsControl(kind) {
    return kind === 'control' || (kind === 'portal' && this.config.portalHost === this.config.controlHost);
  }

  #currentUser(req) {
    if (this.config.devAuthUser) return this.config.devAuthUser;
    const candidateHeaders = ['remote-user', 'x-authenticated-user', 'x-remote-user'];
    const present = candidateHeaders.filter((name) => typeof req.headers[name] === 'string' && req.headers[name]);
    if (!this.#trustedProxy(req)) {
      if (present.length) throw new DbError('UNTRUSTED_PROXY', 'identity header from untrusted source', 403);
      return null;
    }
    if (this.config.proxyKey && req.headers['x-dsh-hub-proxy-key'] !== this.config.proxyKey) {
      throw new DbError('UNTRUSTED_PROXY', 'invalid proxy key', 403);
    }
    if (present.some((name) => name !== this.config.trustedUserHeader)) {
      throw new DbError('BAD_IDENTITY_HEADER', 'unexpected identity header', 400);
    }
    const h = req.headers[this.config.trustedUserHeader];
    if (h && (String(h).includes(',') || rawHeaderCount(req, this.config.trustedUserHeader) > 1)) {
      throw new DbError('BAD_IDENTITY_HEADER', 'ambiguous identity header', 400);
    }
    return (typeof h === 'string' && h) ? h : null;
  }

  #activeUser(req) {
    const username = this.#currentUser(req);
    if (!username) return null;
    const user = getUserByUsername(this.db, username);
    if (!user || user.status !== 'active') return null;
    return user;
  }

  #can(user, action, namespaceId = null) {
    const namespaceRole = namespaceId ? getNamespaceRole(this.db, user.id, namespaceId) : null;
    return authorize({
      user,
      isSystemAdmin: isSystemAdmin(this.db, user.id),
      namespaceRole,
      action,
    });
  }

  #requireAllowed(user, action, namespaceId = null) {
    const decision = this.#can(user, action, namespaceId);
    if (!decision.allow) {
      this.#audit({
        actorType: user ? 'user' : 'anonymous',
        actorId: user?.id ?? null,
        namespaceId,
        action,
        result: 'denied',
        details: { reason: decision.reason },
      });
      throw new DbError('FORBIDDEN', 'forbidden', 403);
    }
    return decision;
  }

  #trustedProxy(req) {
    const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress ?? '');
    const remoteBytes = parseIpBytes(remoteAddress);
    if (!remoteBytes) return false;
    const family = remoteBytes.length === 4 ? 4 : 6;
    return this.config.trustedProxyRanges.some((range) => {
      if (range.family !== family) return false;
      return cidrContains(remoteBytes, range.bytes, range.bits);
    });
  }

  #json(res, status, obj, headers = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      ...this.#securityHeaders({ json: true }),
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  #error(res, error) {
    const known = error instanceof DbError || (error?.status && error?.code);
    const status = known ? error.status : 500;
    const code = known ? error.code : 'INTERNAL_ERROR';
    const message = known ? error.message : 'internal error';
    const headers = error?.retryAfter ? { 'retry-after': String(error.retryAfter) } : {};
    const closeConnection = error?.closeConnection === true;
    if (closeConnection) headers.connection = 'close';
    const metricCode = stableMetricCode(code);
    this.#inc(this.metrics.httpErrors, `${metricCode}:${status}`);
    if (metricCode === 'LIMIT_EXCEEDED') this.#inc(this.metrics.limitRejections, 'http');
    if (closeConnection) {
      const socket = res.socket;
      res.once('finish', () => {
        try { socket?.destroy(); } catch { /* noop */ }
      });
    }
    this.#json(res, status, { error: { code, message } }, headers);
  }

  #securityHeaders({ json = false, nonce = null } = {}) {
    const headers = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    };
    if (nonce) {
      const frameSrc = this.#instanceFrameSrc();
      headers['content-security-policy'] = [
        "default-src 'self'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "img-src 'self' data:",
        "connect-src 'self'",
        `frame-src ${frameSrc}`,
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ].join('; ');
    } else if (json) {
      headers['content-security-policy'] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
    }
    return headers;
  }

  // -------------------------------------------------------------------------
  // HTTP request handling
  // -------------------------------------------------------------------------
  async #handleRequest(req, res) {
    const url = new URL(req.url, 'http://relay');
    if (url.pathname === '/metrics' && req.method === 'GET') {
      if (!this.#internalLoopbackRequest(req)) {
        return this.#error(res, new DbError('FORBIDDEN_HOST', 'metrics is internal only', 403));
      }
      return this.#handleMetrics(res);
    }
    if (url.pathname === '/api/tls/ask' && req.method === 'GET') {
      if (!this.#internalLoopbackRequest(req)) {
        return this.#error(res, new DbError('FORBIDDEN_HOST', 'tls ask is internal only', 403));
      }
      return this.#handleTlsAsk(res, url);
    }

    const { kind, instanceId } = this.#routeByHost(req.headers.host);

    if (kind === 'unknown') return this.#error(res, new DbError('BAD_HOST', 'unknown host', 400));

    if (kind === 'instance') {
      const originProblem = this.#validateInstanceBrowserRequest(req, instanceId, { webSocket: false });
      if (originProblem) return this.#error(res, originProblem);
      const user = this.#activeUser(req);
      if (!user) return this.#error(res, new DbError('UNAUTHORIZED', 'unauthorized', 401));
      const inst = getInstance(this.db, instanceId);
      if (!inst || inst.state !== 'active') {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.open', ns.id).allow) {
        return this.#error(res, new DbError('FORBIDDEN', 'forbidden', 403));
      }
      const tunnel = this.tunnels.get(instanceId);
      if (!tunnel) return this.#error(res, new DbError('INSTANCE_OFFLINE', 'instance offline', 503));
      if (!forwardHttpRequest({ tunnel, req, res })) {
        return this.#error(res, new DbError('LIMIT_EXCEEDED', 'too many relay sessions', 503));
      }
      return;
    }

    // Instance registration: authenticated by registry key, not by user auth.
    if (url.pathname === '/api/register' && req.method === 'POST' && this.#allowsControl(kind)) {
      return this.#handleRegister(req, res);
    }
    const tokenRotate = url.pathname.match(/^\/api\/instances\/([^/]+)\/tokens\/rotate$/);
    if (tokenRotate && req.method === 'POST' && this.#allowsControl(kind)) {
      return this.#handleTokenRotate(req, res, tokenRotate[1]);
    }
    const selfRevoke = url.pathname.match(/^\/api\/instances\/([^/]+)\/revoke$/);
    if (selfRevoke && req.method === 'POST' && this.#allowsControl(kind) && this.#bearerToken(req)) {
      return this.#handleSelfRevoke(req, res, selfRevoke[1]);
    }
    if (kind === 'control') {
      if (url.pathname === '/healthz' && req.method === 'GET') return this.#json(res, 200, { ok: true });
      return this.#error(res, new DbError('NOT_FOUND', 'not found', 404));
    }

    const publicInvite = url.pathname.match(/^\/invite\/([^/]+)$/);
    if (publicInvite && req.method === 'GET') return this.#handleInvitePage(req, res, publicInvite[1]);
    const inviteSummary = url.pathname.match(/^\/api\/invites\/([^/]+)\/summary$/);
    if (inviteSummary && req.method === 'GET') return this.#handleInviteSummary(req, res, inviteSummary[1]);
    const invitePow = url.pathname.match(/^\/api\/invites\/([^/]+)\/pow$/);
    if (invitePow && req.method === 'POST') return this.#handleInvitePow(req, res, invitePow[1]);
    const inviteConsume = url.pathname.match(/^\/api\/invites\/([^/]+)\/consume$/);
    if (inviteConsume && req.method === 'POST') return this.#handleInviteConsume(req, res, inviteConsume[1]);

    const user = this.#activeUser(req);
    if (!user) return this.#error(res, new DbError('UNAUTHORIZED', 'unauthorized', 401));

    if (url.pathname === '/') {
      const nonce = crypto.randomBytes(16).toString('base64url');
      const body = portalHtml({ nonce });
      res.writeHead(200, {
        ...this.#securityHeaders({ nonce }),
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/healthz') return this.#json(res, 200, { ok: true });
    if (url.pathname === '/api/portal') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const onlineInstanceCounts = this.#onlineInstanceCounts();
      const namespacePage = this.#page(
        listNamespaces(this.db, user.id, { limit: 51 }),
        50,
        (row) => this.#namespaceDto(row, onlineInstanceCounts),
      );
      const instancePage = this.#page(listInstances(this.db, user.id, { limit: 51 }), 50, (row) => this.#instanceDto(row));
      return this.#json(res, 200, {
        user: user.username,
        me: this.#meDto(user),
        csrfToken: this.#csrfToken(user.id),
        instanceUrl: {
          scheme: this.config.publicScheme,
          baseDomain: this.config.instanceBaseDomain,
          port: this.config.publicPort,
        },
        authLogoutUrl: this.config.authLogoutUrl,
        namespaces: namespacePage.items,
        namespaceNextCursor: namespacePage.nextCursor,
        instances: instancePage.items,
        instanceNextCursor: instancePage.nextCursor,
      });
    }
    if (url.pathname === '/api/me' && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      return this.#json(res, 200, this.#meDto(user));
    }
    if ((url.pathname === '/api/system/users' || url.pathname === '/api/users') && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      this.#requireAllowed(user, 'user.list', null);
      const pageArgs = this.#pageArgs(url);
      const rows = listUsers(this.db, {
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        q: url.searchParams.get('q'),
        status: url.searchParams.get('status'),
        systemAdmin: parseBooleanFilter(url.searchParams.get('systemAdmin')),
      });
      const page = this.#page(rows, pageArgs.limit, (row) => this.#userDto(row));
      return this.#json(res, 200, { ...page, users: page.items });
    }
    if ((url.pathname === '/api/system/audit' || url.pathname === '/api/audit') && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      this.#requireAllowed(user, 'audit.view_global', null);
      const pageArgs = this.#pageArgs(url);
      const rows = listAuditEvents(this.db, url.searchParams.get('namespace'), {
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        actor: url.searchParams.get('actor'),
        action: url.searchParams.get('action'),
        result: url.searchParams.get('result'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        q: url.searchParams.get('q'),
      });
      return this.#json(res, 200, this.#page(rows, pageArgs.limit, (row) => this.#auditDto(row)));
    }
    const userDetail = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userDetail && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      this.#requireAllowed(user, 'user.list', null);
      const target = getUserSummary(this.db, userDetail[1]);
      if (!target) return this.#error(res, new DbError('USER_NOT_FOUND', 'user not found', 404));
      return this.#json(res, 200, { user: this.#userDto(target) });
    }
    const systemUserDisable = url.pathname.match(/^\/api\/(?:system\/)?users\/([^/]+)\/disable$/);
    if (systemUserDisable && req.method === 'POST') {
      return this.#handleSystemUserStatus(req, res, user, systemUserDisable[1], 'disabled');
    }
    const systemUserRestore = url.pathname.match(/^\/api\/(?:system\/)?users\/([^/]+)\/restore$/);
    if (systemUserRestore && req.method === 'POST') {
      return this.#handleSystemUserStatus(req, res, user, systemUserRestore[1], 'active');
    }
    if (url.pathname === '/api/namespaces' && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const pageArgs = this.#pageArgs(url);
      const rows = listNamespaces(this.db, user.id, {
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        scope: url.searchParams.get('scope'),
        q: url.searchParams.get('q'),
        ownerUsername: url.searchParams.get('owner'),
      });
      const onlineInstanceCounts = this.#onlineInstanceCounts();
      const page = this.#page(rows, pageArgs.limit, (row) => this.#namespaceDto(row, onlineInstanceCounts));
      return this.#json(res, 200, { ...page, namespaces: page.items });
    }
    if (url.pathname === '/api/instances' && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const pageArgs = this.#pageArgs(url);
      const filters = parseInstanceListFilters(url);
      const connectedInstanceIds = [...this.tunnels.tunnels.keys()];
      const rows = listInstances(this.db, user.id, {
        namespaceId: url.searchParams.get('namespace'),
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        q: url.searchParams.get('q'),
        deploymentMode: filters.mode,
        state: filters.state,
        delivery: filters.delivery,
        connection: filters.connection,
        connectedInstanceIds,
      });
      const page = this.#page(rows, pageArgs.limit, (row) => this.#instanceDto(row));
      return this.#json(res, 200, { ...page, instances: page.items });
    }
    if (url.pathname === '/api/namespaces' && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.create', requestId });
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['name', 'description', 'ownerUsername']);
      const name = cleanBoundedString(body.name, 'name', 100);
      const description = cleanOptionalBoundedString(body.description, 'description', 1000);
      const ownerUser = body.ownerUsername
        ? getActiveUserByUsername(this.db, cleanBoundedString(body.ownerUsername, 'ownerUsername', 64))
        : user;
      if (!ownerUser) return this.#error(res, new DbError('USER_NOT_FOUND', 'user not found', 404));
      const createMode = ownerUser.id === user.id ? 'self' : 'for_user';
      this.#requireAllowed(user, createMode === 'self' ? 'namespace.create_self' : 'namespace.create_for_user', null);
      const result = this.#observeSqliteWrite('namespace_create', () => runIdempotent(this.db, {
        actorScope: `user:${user.id}`,
        operation: 'namespace.create',
        idempotencyKey: req.headers['idempotency-key'],
        request: { name, description, ownerUserId: ownerUser.id },
        mutate: () => {
          const created = createNamespace(this.db, {
            name,
            description,
            ownerUserId: ownerUser.id,
            createdBy: user.id,
          });
          this.#mustAudit({
            actorType: 'user',
            actorId: user.id,
            namespaceId: created.namespaceId,
            action: 'namespace.create',
            result: 'success',
            requestId,
            details: {
              createMode,
              ownerUserId: ownerUser.id,
              nameLength: Array.from(name).length,
              descriptionLength: Array.from(description ?? '').length,
            },
          });
          return { statusCode: 201, body: created };
        },
      }));
      return this.#json(res, result.statusCode, result.body);
    }
    const nsDetail = url.pathname.match(/^\/api\/namespaces\/([^/]+)$/);
    if (nsDetail && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const ns = getNamespace(this.db, nsDetail[1]);
      if (!ns || !this.#can(user, 'namespace.view', ns.id).allow) {
        return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      }
      const row = getNamespaceDetail(this.db, user.id, ns.id);
      return this.#json(res, 200, {
        namespace: this.#namespaceDto(row ?? ns, this.#onlineInstanceCounts()),
      });
    }
    if (nsDetail && req.method === 'PATCH') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.update', requestId });
      const ns = getNamespace(this.db, nsDetail[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      this.#requireAllowed(user, 'namespace.update', ns.id);
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['name', 'description']);
      if (body.name === undefined && body.description === undefined) {
        return this.#error(res, new DbError('BAD_REQUEST', 'name or description required', 400));
      }
      const name = body.name === undefined ? undefined : cleanBoundedString(body.name, 'name', 100);
      const description = body.description === undefined
        ? undefined
        : cleanOptionalBoundedString(body.description, 'description', 1000);
      const result = this.#observeSqliteWrite('namespace_update', () => runIdempotent(this.db, {
        actorScope: `user:${user.id}:namespace:${ns.id}`,
        operation: 'namespace.update',
        idempotencyKey: req.headers['idempotency-key'],
        request: {
          namespaceId: ns.id,
          ...(name === undefined ? {} : { name }),
          ...(description === undefined ? {} : { description }),
        },
        mutate: () => {
          const updated = updateNamespace(this.db, {
            namespaceId: ns.id,
            name,
            description,
            updatedBy: user.id,
          });
          this.#mustAudit({
            actorType: 'user',
            actorId: user.id,
            namespaceId: ns.id,
            action: 'namespace.update',
            result: 'success',
            requestId,
            details: {
              old: {
                nameLength: Array.from(ns.name ?? '').length,
                descriptionLength: Array.from(ns.description ?? '').length,
              },
              new: {
                nameLength: Array.from(updated.name ?? '').length,
                descriptionLength: Array.from(updated.description ?? '').length,
              },
            },
          });
          const row = getNamespaceDetail(this.db, user.id, ns.id);
          return {
            statusCode: 200,
            body: { namespace: this.#namespaceDto(row ?? updated, this.#onlineInstanceCounts()) },
          };
        },
      }));
      return this.#json(res, result.statusCode, result.body);
    }
    const nsMembers = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/members$/);
    if (nsMembers && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const ns = getNamespace(this.db, nsMembers[1]);
      if (!ns || !this.#can(user, 'namespace.member.view', ns.id).allow) {
        return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      }
      return this.#json(res, 200, { members: listNamespaceMembers(this.db, ns.id).map((row) => this.#memberDto(row)) });
    }
    if (nsMembers && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.member.add', requestId });
      const ns = getNamespace(this.db, nsMembers[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['username', 'role']);
      const role = cleanRole(body.role, { allowOwner: true });
      this.#requireAllowed(user, memberActionForRole('namespace.member.add', role), ns.id);
      const target = getActiveUserByUsername(this.db, cleanBoundedString(body.username, 'username', 64));
      if (!target) return this.#error(res, new DbError('MEMBER_ADD_FAILED', 'member cannot be added', 404));
      const member = this.#observeSqliteWrite('member_add', () => {
        const created = addNamespaceMembership(this.db, {
          namespaceId: ns.id,
          userId: target.id,
          role,
          createdBy: user.id,
        });
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: ns.id,
          targetUserId: target.id,
          action: 'namespace.member.add',
          result: 'success',
          requestId,
          details: { role },
        });
        return created;
      });
      return this.#json(res, 201, {
        member: this.#memberDto({
          ...member,
          username: target.username,
          email: target.email,
          display_name: target.display_name,
          user_status: target.status,
        }),
      });
    }
    const nsInvites = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/invites$/);
    if (nsInvites && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const ns = getNamespace(this.db, nsInvites[1]);
      if (!ns || !this.#can(user, 'namespace.invite.view', ns.id).allow) {
        return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      }
      return this.#json(res, 200, { invites: listInvites(this.db, ns.id).map((row) => this.#inviteDto(row)) });
    }
    if (nsInvites && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.member.invite', requestId });
      const ns = getNamespace(this.db, nsInvites[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['role', 'emailHint']);
      const role = cleanRole(body.role, { allowOwner: false });
      this.#requireAllowed(user, memberActionForRole('namespace.member.invite', role), ns.id);
      const emailHint = body.emailHint ? cleanBoundedString(body.emailHint, 'emailHint', 200) : null;
      const invite = this.#observeSqliteWrite('invite_create', () => {
        const created = createInvite(this.db, {
          namespaceId: ns.id,
          role,
          emailHint,
          createdBy: user.id,
          ttlMs: this.config.inviteTtlMs,
        });
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: ns.id,
          action: 'invite.create',
          result: 'success',
          requestId,
          details: { role, emailHintPresent: !!emailHint },
        });
        return created;
      });
      return this.#json(res, 201, { invite: this.#inviteCreatedDto(invite) });
    }
    const inviteRevoke = url.pathname.match(/^\/api\/invites\/([^/]+)\/revoke$/);
    if (inviteRevoke && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'invite.revoke', requestId });
      const invite = this.db.prepare('SELECT * FROM invites WHERE id=?').get(inviteRevoke[1]);
      if (!invite) return this.#error(res, new DbError('INVITE_NOT_FOUND', 'invite not found', 404));
      this.#requireAllowed(user, memberActionForRole('namespace.member.invite', invite.role), invite.namespace_id);
      this.#observeSqliteWrite('invite_revoke', () => {
        revokeInvite(this.db, { inviteId: invite.id, revokedBy: user.id });
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: invite.namespace_id,
          action: 'invite.revoke',
          result: 'success',
          requestId,
          details: { role: invite.role },
        });
      });
      res.writeHead(204);
      return res.end();
    }
    const memberPatch = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/members\/([^/]+)$/);
    if (memberPatch && req.method === 'PATCH') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.member.update', requestId });
      const ns = getNamespace(this.db, memberPatch[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['role']);
      const role = cleanRole(body.role, { allowOwner: true });
      const target = this.db.prepare('SELECT * FROM namespace_memberships WHERE namespace_id=? AND user_id=? AND status=?')
        .get(ns.id, memberPatch[2], 'active');
      if (!target) return this.#error(res, new DbError('MEMBERSHIP_NOT_FOUND', 'member not found', 404));
      this.#requireAllowed(user, memberActionForRole('namespace.member.update', target.role), ns.id);
      this.#requireAllowed(user, memberActionForRole('namespace.member.update', role), ns.id);
      const updated = this.#observeSqliteWrite('member_update', () => {
        const member = updateNamespaceMembershipRole(this.db, {
          namespaceId: ns.id,
          userId: memberPatch[2],
          role,
          updatedBy: user.id,
        });
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
            namespaceId: ns.id,
            targetUserId: memberPatch[2],
            action: 'namespace.member.update',
          result: 'success',
          requestId,
          details: { from: target.role, to: role },
        });
        return member;
      });
      return this.#json(res, 200, { member: updated });
    }
    if (memberPatch && req.method === 'DELETE') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.member.remove', requestId });
      const ns = getNamespace(this.db, memberPatch[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      const target = this.db.prepare('SELECT * FROM namespace_memberships WHERE namespace_id=? AND user_id=? AND status=?')
        .get(ns.id, memberPatch[2], 'active');
      if (!target) return this.#error(res, new DbError('MEMBERSHIP_NOT_FOUND', 'member not found', 404));
      this.#requireAllowed(user, memberActionForRole('namespace.member.remove', target.role), ns.id);
      this.#observeSqliteWrite('member_remove', () => {
        removeNamespaceMembership(this.db, {
          namespaceId: ns.id,
          userId: memberPatch[2],
          removedBy: user.id,
        });
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: ns.id,
          targetUserId: memberPatch[2],
          action: 'namespace.member.remove',
          result: 'success',
          requestId,
          details: { role: target.role },
        });
      });
      res.writeHead(204);
      return res.end();
    }
    const nsRegistryReveal = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/registry-key\/reveal$/);
    if (nsRegistryReveal && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.registry.reveal', requestId });
      const ns = getNamespace(this.db, nsRegistryReveal[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      this.#requireAllowed(user, 'namespace.registry.reveal', ns.id);
      const revealed = this.#observeSqliteWrite('registry_reveal', () => {
        const key = revealRegistryKey(this.db, ns.id);
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: ns.id,
          action: 'namespace.registry.reveal',
          result: 'success',
          requestId,
          details: { version: key.version, prefix: key.prefix },
        });
        return key;
      });
      return this.#json(res, 200, {
        registryKey: revealed.registryKey,
        prefix: revealed.prefix,
        version: revealed.version,
        issuedAt: isoOrNull(revealed.issuedAt),
      });
    }
    const nsRotate = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/rotate$/);
    if (nsRotate && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'namespace.registry.rotate', requestId });
      const ns = getNamespace(this.db, nsRotate[1]);
      if (!ns) return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      this.#requireAllowed(user, 'namespace.registry.rotate', ns.id);
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['expectedVersion', 'reason']);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) {
        return this.#error(res, new DbError('BAD_REQUEST', 'expectedVersion must be a positive integer', 400));
      }
      const reason = body.reason ? cleanBoundedString(body.reason, 'reason', 200) : null;
      const result = this.#observeSqliteWrite('registry_rotate', () => runIdempotent(this.db, {
        actorScope: `user:${user.id}:namespace:${ns.id}`,
        operation: 'namespace.registry.rotate',
        idempotencyKey: req.headers['idempotency-key'],
        request: { namespaceId: ns.id, expectedVersion: body.expectedVersion, reason },
        mutate: () => {
          const rotated = rotateRegistryKey(this.db, ns.id, {
            expectedVersion: body.expectedVersion,
            rotatedBy: user.id,
          });
          this.#mustAudit({
            actorType: 'user',
            actorId: user.id,
            namespaceId: ns.id,
            action: 'namespace.registry.rotate',
            result: 'success',
            requestId,
            details: { version: rotated.version, reason },
          });
          return { statusCode: 200, body: rotated };
        },
      }));
      return this.#json(res, result.statusCode, result.body);
    }
    const nsInstances = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/instances$/);
    if (nsInstances && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const ns = getNamespace(this.db, nsInstances[1]);
      if (!ns || !this.#can(user, 'namespace.view', ns.id).allow) {
        return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      }
      const pageArgs = this.#pageArgs(url);
      const filters = parseInstanceListFilters(url);
      const rows = listInstances(this.db, user.id, {
        namespaceId: ns.id,
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        q: url.searchParams.get('q'),
        deploymentMode: filters.mode,
        state: filters.state,
        delivery: filters.delivery,
        connection: filters.connection,
        connectedInstanceIds: [...this.tunnels.tunnels.keys()],
      });
      return this.#json(res, 200, this.#page(rows, pageArgs.limit, (row) => this.#instanceDto(row)));
    }
    const nsAudit = url.pathname.match(/^\/api\/namespaces\/([^/]+)\/audit$/);
    if (nsAudit && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const ns = getNamespace(this.db, nsAudit[1]);
      if (!ns || !this.#can(user, 'audit.view', ns.id).allow) {
        return this.#error(res, new DbError('NAMESPACE_NOT_FOUND', 'namespace not found', 404));
      }
      const pageArgs = this.#pageArgs(url);
      const rows = listAuditEvents(this.db, ns.id, {
        limit: pageArgs.limit + 1,
        cursor: pageArgs.cursor,
        actor: url.searchParams.get('actor'),
        action: url.searchParams.get('action'),
        result: url.searchParams.get('result'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        q: url.searchParams.get('q'),
      });
      return this.#json(res, 200, this.#page(rows, pageArgs.limit, (row) => this.#auditDto(row)));
    }
    const instDetail = url.pathname.match(/^\/api\/instances\/([^/]+)$/);
    if (instDetail && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const inst = getInstance(this.db, instDetail[1]);
      if (!inst) return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.view', ns.id).allow) {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const row = listInstances(this.db, user.id, { q: inst.id, limit: 20 })
        .find((candidate) => candidate.id === inst.id);
      return this.#json(res, 200, {
        instance: this.#instanceDto(row ?? {
          ...inst,
          namespace_name: ns.name,
          namespace_owner_user_id: ns.owner_user_id,
          owner_username: getUser(this.db, ns.owner_user_id)?.username ?? ns.owner_user_id,
          membership_role: this.#can(user, 'audit.view_global', null).allow
            ? 'system_admin'
            : getNamespaceRole(this.db, user.id, ns.id),
        }),
      });
    }
    const instDiagnostics = url.pathname.match(/^\/api\/instances\/([^/]+)\/diagnostics$/);
    if (instDiagnostics && req.method === 'GET') {
      const originProblem = this.#validatePortalReadOrigin(req);
      if (originProblem) return this.#error(res, originProblem);
      const inst = getInstance(this.db, instDiagnostics[1]);
      if (!inst) return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.diagnostics.view', ns.id).allow) {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const cacheKey = `${user.id}:${inst.id}`;
      const cached = this.diagnosticCache.get(cacheKey);
      const refresh = url.searchParams.get('refresh') === '1';
      if (!refresh && cached && now() - cached.cachedAt < this.config.diagnosticCacheMs) {
        return this.#json(res, 200, { ...cached.body, cache: { hit: true, cachedAt: isoOrNull(cached.cachedAt) } });
      }
      const row = { ...inst, namespace_name: ns.name };
      const diagnostics = await collectInstanceDiagnostics({
        tunnel: this.tunnels.get(inst.id),
        instance: row,
        instanceDto: this.#instanceDto(row),
        instanceOrigin: this.#instancePublicOrigin(inst.id),
      });
      const body = { ...diagnostics, cache: { hit: false, cachedAt: isoOrNull(now()) } };
      this.diagnosticCache.set(cacheKey, { cachedAt: now(), body: diagnostics });
      return this.#json(res, 200, body);
    }
    const instRevoke = url.pathname.match(/^\/api\/instances\/([^/]+)\/revoke$/);
    if (instRevoke && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'instance.revoke', requestId });
      const inst = getInstance(this.db, instRevoke[1]);
      if (!inst) return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.revoke', ns.id).allow) {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['reason']);
      const reason = cleanBoundedString(body.reason, 'reason', 200);
      this.#observeSqliteWrite('instance_revoke_owner', () => revokeInstanceTokenWithAudit(this.db, inst.id, reason, {
        actorType: 'user',
        actorId: user.id,
        namespaceId: ns.id,
        instanceId: inst.id,
        action: 'instance.revoke',
        result: 'success',
        requestId,
        details: { reason },
      }));
      const tunnel = this.tunnels.get(inst.id);
      if (tunnel) {
        tunnel.markDead({
          frame: { type: MSG.BYE, code: 'TOKEN_REVOKED', reason: 'token revoked' },
          closeCode: 4401,
          closeReason: 'token revoked',
        });
      }
      log(`instance ${inst.id} tokens revoked by ${user.id}`);
      res.writeHead(204);
      return res.end();
    }
    const instRecover = url.pathname.match(/^\/api\/instances\/([^/]+)\/recover$/);
    if (instRecover && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'instance.recover', requestId });
      const inst = getInstance(this.db, instRecover[1]);
      if (!inst) return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.recover', ns.id).allow) {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['reason']);
      const reason = cleanBoundedString(body.reason, 'reason', 200);
      const recovered = this.#observeSqliteWrite('instance_recover', () => {
        const row = recoverInstance(this.db, inst.id);
        this.#mustAudit({
          actorType: 'user',
          actorId: user.id,
          namespaceId: ns.id,
          instanceId: inst.id,
          action: 'instance.recover',
          result: 'success',
          requestId,
          details: { reason },
        });
        return row;
      });
      return this.#json(res, 200, { instance: this.#instanceDto({ ...recovered, namespace_name: ns.name }) });
    }
    const replacementGrant = url.pathname.match(/^\/api\/instances\/([^/]+)\/replacement-grants$/);
    if (replacementGrant && req.method === 'POST') {
      const requestId = this.#requestId(req);
      this.#validatePortalWrite(req, user.id, { action: 'instance.replacement.create', requestId });
      const inst = getInstance(this.db, replacementGrant[1]);
      if (!inst) return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.replacement.create', ns.id).allow) {
        return this.#error(res, new DbError('INSTANCE_NOT_FOUND', 'unknown instance', 404));
      }
      const body = await this.#readJson(req);
      requireOnlyFields(body, ['reason']);
      const reason = cleanBoundedString(body.reason, 'reason', 200);
      const result = this.#observeSqliteWrite('replacement_create', () => runIdempotent(this.db, {
        actorScope: `user:${user.id}:instance:${inst.id}`,
        operation: 'instance.replacement.create',
        idempotencyKey: req.headers['idempotency-key'],
        request: { instanceId: inst.id, reason },
        mutate: () => {
          const grant = issueReplacementGrant(this.db, { instanceId: inst.id, issuedBy: user.id, reason });
          this.#mustAudit({
            actorType: 'user',
            actorId: user.id,
            namespaceId: ns.id,
            instanceId: inst.id,
            action: 'instance.replacement.create',
            result: 'success',
            requestId,
            details: { reason, expiresAt: grant.expiresAt },
          });
          return {
            statusCode: 201,
            body: {
              replacementGrant: grant.replacementGrant,
              expiresAt: new Date(grant.expiresAt).toISOString(),
            },
          };
        },
      }));
      return this.#json(res, result.statusCode, result.body);
    }

    return this.#error(res, new DbError('NOT_FOUND', 'not found', 404));
  }

  #handleTlsAsk(res, url) {
    const domain = normalizeTlsAskDomain(url.searchParams.get('domain'));
    if (!domain) return this.#error(res, new DbError('BAD_DOMAIN', 'bad domain', 400));
    if (!this.#allowsTlsDomain(domain)) {
      return this.#error(res, new DbError('FORBIDDEN_DOMAIN', 'forbidden domain', 403));
    }
    return this.#json(res, 200, { ok: true });
  }

  #handleMetrics(res) {
    const body = this.#metricsText();
    res.writeHead(200, {
      ...this.#securityHeaders(),
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  #handleInvitePage(req, res, token) {
    const invite = findInviteByToken(this.db, token);
    const nonce = crypto.randomBytes(16).toString('base64url');
    const body = inviteHtml({ nonce, token, available: !!invite });
    res.writeHead(invite ? 200 : 404, {
      ...this.#securityHeaders({ nonce }),
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  #handleInviteSummary(req, res, token) {
    const invite = findInviteByToken(this.db, token);
    if (!invite) return this.#json(res, 404, { error: { code: 'INVITE_UNAVAILABLE', message: 'invite is unavailable' } });
    return this.#json(res, 200, {
      invite: {
        namespaceName: invite.namespace_name,
        role: invite.role,
        emailHint: invite.email_hint,
        expiresAt: isoOrNull(invite.expires_at),
      },
    });
  }

  async #handleInvitePow(req, res, token) {
    const originProblem = this.#validatePublicInviteWrite(req);
    if (originProblem) return this.#error(res, originProblem);
    const requestId = this.#requestId(req);
    const clientAddress = this.#clientAddress(req);
    this.#checkRateLimit(`invite-pow:${clientAddress}`, {
      action: 'invite.pow',
      actorType: 'network',
      actorId: clientAddress,
      requestId,
      limit: this.config.publicInviteRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    const challenge = createInvitePowChallenge(this.db, {
      inviteToken: token,
      difficulty: this.config.invitePowDifficulty,
      ttlMs: this.config.invitePowTtlMs,
      ipHash: sha256Hex(clientAddress),
    });
    return this.#json(res, 201, {
      challenge: {
        id: challenge.id,
        challenge: challenge.challenge,
        difficulty: challenge.difficulty,
        expiresAt: isoOrNull(challenge.expiresAt),
      },
    });
  }

  async #handleInviteConsume(req, res, token) {
    const originProblem = this.#validatePublicInviteWrite(req);
    if (originProblem) return this.#error(res, originProblem);
    const requestId = this.#requestId(req);
    const body = await this.#readJson(req);
    requireOnlyFields(body, ['username', 'email', 'displayName', 'password', 'powChallengeId', 'powNonce']);
    const username = normalizeUsername(body.username);
    const email = body.email ? cleanBoundedString(body.email, 'email', 200) : null;
    const displayName = body.displayName ? cleanBoundedString(body.displayName, 'displayName', 100) : username;
    const password = String(body.password ?? '');
    validatePassword(password, { username, email, displayName });
    const clientAddress = this.#clientAddress(req);
    this.#checkRateLimit(`invite-consume-ip:${clientAddress}`, {
      action: 'invite.consume',
      actorType: 'network',
      actorId: clientAddress,
      requestId,
      limit: this.config.publicInviteRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    this.#checkRateLimit(`invite-consume-user:${username}`, {
      action: 'invite.consume',
      actorType: 'network',
      actorId: username,
      requestId,
      limit: this.config.publicInviteRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    const cleanPowChallengeId = cleanBoundedString(body.powChallengeId, 'powChallengeId', 80);
    const cleanPowNonce = cleanBoundedString(body.powNonce, 'powNonce', 128);
    const pow = getInvitePowChallenge(this.db, {
      challengeId: cleanPowChallengeId,
      inviteToken: token,
    });
    if (!verifyPow({ challenge: pow.challenge, nonce: cleanPowNonce, difficulty: pow.difficulty })) {
      throw new DbError('POW_INVALID', 'proof of work is invalid', 400);
    }
    consumeInvitePowChallenge(this.db, {
      challengeId: cleanPowChallengeId,
      inviteToken: token,
    });
    const locked = beginInviteConsumption(this.db, { token });
    let lldapProvisioned = false;
    try {
      await this.lldap.createUserWithPasswordAndGroup({
        username,
        email,
        displayName,
        password,
      });
      lldapProvisioned = true;
      const result = completeInviteConsumption(this.db, {
        inviteId: locked.id,
        username,
        email,
        displayName,
        createdBy: locked.created_by,
      });
      this.#audit({
        actorType: 'invite',
        actorId: locked.id,
        namespaceId: result.namespaceId,
        action: 'invite.consume',
        result: 'success',
        requestId,
        details: { role: result.role },
      });
      return this.#json(res, 201, {
        ok: true,
        loginUrl: this.config.authLoginUrl ?? '/',
        user: { username: result.user.username, displayName: result.user.display_name },
      });
    } catch (error) {
      markInviteFailed(this.db, locked.id, error.code ?? 'consume_failed', {
        needsAdmin: lldapProvisioned || error.partialUserCreated === true,
      });
      this.#audit({
        actorType: 'invite',
        actorId: locked.id,
        namespaceId: locked.namespace_id,
        action: 'invite.consume',
        result: 'failed',
        requestId,
        details: { code: error.code ?? 'consume_failed' },
      });
      throw new DbError('INVITE_UNAVAILABLE', 'invite is unavailable', 404);
    }
  }

  async #handleSystemUserStatus(req, res, actor, userId, status) {
    const action = status === 'disabled' ? 'user.disable' : 'user.restore';
    const requestId = this.#requestId(req);
    this.#validatePortalWrite(req, actor.id, { action, requestId });
    this.#requireAllowed(actor, action, null);
    const body = await this.#readJson(req);
    requireOnlyFields(body, ['reason']);
    const reason = cleanBoundedString(body.reason, 'reason', 200);
    const target = this.db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!target) return this.#error(res, new DbError('USER_NOT_FOUND', 'user not found', 404));
    if (status === 'disabled') {
      if (isSystemAdmin(this.db, userId) && countActiveSystemAdmins(this.db, { excludeUserId: userId }) < 1) {
        throw new DbError('LAST_SYSTEM_ADMIN', 'cannot disable the last active system admin', 409);
      }
      const updated = this.#observeSqliteWrite('user_disable', () => {
        const row = setUserStatus(this.db, userId, 'disabled');
        this.#mustAudit({
          actorType: 'user',
          actorId: actor.id,
          targetUserId: userId,
          action,
          result: 'success',
          requestId,
          details: { reason },
        });
        return row;
      });
      let groupSync = 'ok';
      try {
        await this.lldap.removeUserFromAdmissionGroup(target.username);
      } catch {
        groupSync = 'failed_needs_admin';
        this.#audit({
          actorType: 'user',
          actorId: actor.id,
          targetUserId: userId,
          action,
          result: 'partial_failure',
          requestId,
          details: { code: 'LLDAP_GROUP_SYNC_FAILED' },
        });
      }
      return this.#json(res, 200, { user: this.#userDto(updated), groupSync });
    }
    try {
      await this.lldap.addUserToAdmissionGroup(target.username);
    } catch {
      this.#audit({
        actorType: 'user',
        actorId: actor.id,
        targetUserId: userId,
        action,
        result: 'failed',
        requestId,
        details: { code: 'LLDAP_GROUP_SYNC_FAILED' },
      });
      return this.#error(res, new DbError('LLDAP_GROUP_SYNC_FAILED', 'failed to restore admission group', 502));
    }
    const updated = this.#observeSqliteWrite('user_restore', () => {
      const row = setUserStatus(this.db, userId, 'active');
      this.#mustAudit({
        actorType: 'user',
        actorId: actor.id,
        targetUserId: userId,
        action,
        result: 'success',
        requestId,
        details: { reason },
      });
      return row;
    });
    return this.#json(res, 200, { user: this.#userDto(updated), groupSync: 'ok' });
  }

  #metricsText() {
    const lines = [
      '# HELP dsh_hub_build_info dsh-hub service build metadata.',
      '# TYPE dsh_hub_build_info gauge',
      metricLine('dsh_hub_build_info', 1, { version: this.serverVersion }),
      '# HELP dsh_hub_tunnels_active Active instance tunnels.',
      '# TYPE dsh_hub_tunnels_active gauge',
      metricLine('dsh_hub_tunnels_active', this.tunnels.tunnels.size),
      '# HELP dsh_hub_relay_sessions_active Active relay sessions.',
      '# TYPE dsh_hub_relay_sessions_active gauge',
    ];

    const relay = this.#relaySessionMetrics();
    lines.push(metricLine('dsh_hub_relay_sessions_active', relay.total));
    lines.push('# HELP dsh_hub_relay_sessions_by_type Active relay sessions by transport type.');
    lines.push('# TYPE dsh_hub_relay_sessions_by_type gauge');
    lines.push(metricLine('dsh_hub_relay_sessions_by_type', relay.http, { type: 'http' }));
    lines.push(metricLine('dsh_hub_relay_sessions_by_type', relay.ws, { type: 'websocket' }));
    lines.push(metricLine('dsh_hub_relay_sessions_by_type', relay.pendingWs, { type: 'websocket_pending' }));
    const backpressure = this.#relayBackpressureMetrics();
    lines.push('# HELP dsh_hub_relay_queued_bytes Service-observed relay bytes queued or waiting by bounded direction.');
    lines.push('# TYPE dsh_hub_relay_queued_bytes gauge');
    for (const direction of ['browser_to_instance', 'instance_to_browser']) {
      lines.push(metricLine('dsh_hub_relay_queued_bytes', backpressure.queued[direction].sum, { direction, statistic: 'sum' }));
      lines.push(metricLine('dsh_hub_relay_queued_bytes', backpressure.queued[direction].max, { direction, statistic: 'max' }));
    }
    lines.push('# HELP dsh_hub_relay_uncredited_bytes Service-observed relay bytes sent or received without credit return by bounded direction.');
    lines.push('# TYPE dsh_hub_relay_uncredited_bytes gauge');
    for (const direction of ['browser_to_instance', 'instance_to_browser']) {
      lines.push(metricLine('dsh_hub_relay_uncredited_bytes', backpressure.uncredited[direction].sum, { direction, statistic: 'sum' }));
      lines.push(metricLine('dsh_hub_relay_uncredited_bytes', backpressure.uncredited[direction].max, { direction, statistic: 'max' }));
    }
    lines.push('# HELP dsh_hub_relay_downstream_buffered_bytes Service-observed downstream transport buffered bytes by bounded transport.');
    lines.push('# TYPE dsh_hub_relay_downstream_buffered_bytes gauge');
    for (const transport of ['tunnel_websocket', 'http_response', 'browser_websocket']) {
      lines.push(metricLine('dsh_hub_relay_downstream_buffered_bytes', backpressure.downstream[transport].sum, { transport, statistic: 'sum' }));
      lines.push(metricLine('dsh_hub_relay_downstream_buffered_bytes', backpressure.downstream[transport].max, { transport, statistic: 'max' }));
    }
    lines.push('# HELP dsh_hub_relay_credit_waiters Service relay waiters blocked on per-session credit by bounded stream.');
    lines.push('# TYPE dsh_hub_relay_credit_waiters gauge');
    for (const stream of ['req', 'ws_c2i']) {
      lines.push(metricLine('dsh_hub_relay_credit_waiters', backpressure.creditWaiters[stream].sum, { stream, statistic: 'sum' }));
      lines.push(metricLine('dsh_hub_relay_credit_waiters', backpressure.creditWaiters[stream].max, { stream, statistic: 'max' }));
    }
    lines.push('# HELP dsh_hub_relay_credit_wait_bytes Service relay bytes currently waiting for per-session credit by bounded stream.');
    lines.push('# TYPE dsh_hub_relay_credit_wait_bytes gauge');
    for (const stream of ['req', 'ws_c2i']) {
      lines.push(metricLine('dsh_hub_relay_credit_wait_bytes', backpressure.creditWaitBytes[stream].sum, { stream, statistic: 'sum' }));
      lines.push(metricLine('dsh_hub_relay_credit_wait_bytes', backpressure.creditWaitBytes[stream].max, { stream, statistic: 'max' }));
    }
    lines.push('# HELP dsh_hub_tunnels_by_delivery Active instance tunnels by delivery mode.');
    lines.push('# TYPE dsh_hub_tunnels_by_delivery gauge');
    for (const [delivery, count] of Object.entries(this.#tunnelDeliveryMetrics())) {
      lines.push(metricLine('dsh_hub_tunnels_by_delivery', count, { delivery }));
    }
    lines.push('# HELP dsh_hub_rate_limit_scopes Tracked in-memory rate-limit scopes.');
    lines.push('# TYPE dsh_hub_rate_limit_scopes gauge');
    lines.push(metricLine('dsh_hub_rate_limit_scopes', this.rateLimits.size));
    lines.push('# HELP dsh_hub_diagnostic_cache_entries In-memory diagnostic cache entries.');
    lines.push('# TYPE dsh_hub_diagnostic_cache_entries gauge');
    lines.push(metricLine('dsh_hub_diagnostic_cache_entries', this.diagnosticCache.size));
    lines.push('# HELP dsh_hub_http_errors_total HTTP error responses returned by code and status.');
    lines.push('# TYPE dsh_hub_http_errors_total counter');
    for (const [key, count] of sortedMetricEntries(this.metrics.httpErrors)) {
      const [code, status] = key.split(':');
      lines.push(metricLine('dsh_hub_http_errors_total', count, { code, status }));
    }
    lines.push('# HELP dsh_hub_rate_limit_rejections_total Rate-limit rejections by bounded action.');
    lines.push('# TYPE dsh_hub_rate_limit_rejections_total counter');
    for (const [action, count] of sortedMetricEntries(this.metrics.rateLimitRejections)) {
      lines.push(metricLine('dsh_hub_rate_limit_rejections_total', count, { action }));
    }
    lines.push('# HELP dsh_hub_limit_rejections_total Limit rejections observed by bounded kind.');
    lines.push('# TYPE dsh_hub_limit_rejections_total counter');
    for (const [kind, count] of sortedMetricEntries(this.metrics.limitRejections)) {
      lines.push(metricLine('dsh_hub_limit_rejections_total', count, { kind }));
    }
    lines.push('# HELP dsh_hub_ws_upgrade_rejections_total WebSocket upgrade rejections by HTTP status.');
    lines.push('# TYPE dsh_hub_ws_upgrade_rejections_total counter');
    for (const [status, count] of sortedMetricEntries(this.metrics.wsUpgradeRejections)) {
      lines.push(metricLine('dsh_hub_ws_upgrade_rejections_total', count, { status }));
    }
    lines.push('# HELP dsh_hub_tunnel_handshake_failures_total Tunnel handshake failures by bounded code.');
    lines.push('# TYPE dsh_hub_tunnel_handshake_failures_total counter');
    for (const [code, count] of sortedMetricEntries(this.metrics.tunnelHandshakeFailures)) {
      lines.push(metricLine('dsh_hub_tunnel_handshake_failures_total', count, { code }));
    }
    lines.push('# HELP dsh_hub_relay_terminal_frames_total Relay terminal frames observed from instance tunnels.');
    lines.push('# TYPE dsh_hub_relay_terminal_frames_total counter');
    for (const [key, count] of sortedMetricEntries(this.metrics.relayTerminalFrames)) {
      const [type, code] = key.split(':');
      lines.push(metricLine('dsh_hub_relay_terminal_frames_total', count, { type, code }));
    }
    lines.push('# HELP dsh_hub_tunnels_dsh_reachable Active tunnels by latest DSH health report.');
    lines.push('# TYPE dsh_hub_tunnels_dsh_reachable gauge');
    for (const [state, count] of Object.entries(this.#dshReachabilityMetrics())) {
      lines.push(metricLine('dsh_hub_tunnels_dsh_reachable', count, { state }));
    }
    lines.push('# HELP dsh_hub_heartbeat_sent_at_age_seconds Tunnel heartbeat sentAt age observed by service; not end-to-end RTT.');
    lines.push('# TYPE dsh_hub_heartbeat_sent_at_age_seconds summary');
    lines.push(metricLine('dsh_hub_heartbeat_sent_at_age_seconds_count', this.metrics.heartbeat.count));
    lines.push(metricLine('dsh_hub_heartbeat_sent_at_age_seconds_sum', this.metrics.heartbeat.sumSeconds));
    lines.push(metricLine('dsh_hub_heartbeat_sent_at_age_seconds', this.metrics.heartbeat.maxSeconds, { statistic: 'max' }));
    lines.push(metricLine('dsh_hub_heartbeat_sent_at_age_seconds', this.metrics.heartbeat.lastSeconds, { statistic: 'last' }));
    lines.push('# HELP dsh_hub_sqlite_write_seconds Service-level SQLite write operation latency.');
    lines.push('# TYPE dsh_hub_sqlite_write_seconds summary');
    for (const [operation, value] of sortedMetricEntries(this.metrics.sqliteWrites)) {
      lines.push(metricLine('dsh_hub_sqlite_write_seconds_count', value.count, { operation }));
      lines.push(metricLine('dsh_hub_sqlite_write_seconds_sum', value.sumSeconds, { operation }));
      lines.push(metricLine('dsh_hub_sqlite_write_seconds', value.maxSeconds, { operation, statistic: 'max' }));
      lines.push(metricLine('dsh_hub_sqlite_write_seconds', value.lastSeconds, { operation, statistic: 'last' }));
    }

    const memory = process.memoryUsage();
    lines.push('# HELP dsh_hub_process_resident_memory_bytes Resident set size for the service process.');
    lines.push('# TYPE dsh_hub_process_resident_memory_bytes gauge');
    lines.push(metricLine('dsh_hub_process_resident_memory_bytes', memory.rss));
    lines.push('# HELP dsh_hub_process_heap_used_bytes V8 heap used by the service process.');
    lines.push('# TYPE dsh_hub_process_heap_used_bytes gauge');
    lines.push(metricLine('dsh_hub_process_heap_used_bytes', memory.heapUsed));
    lines.push('# HELP dsh_hub_event_loop_delay_seconds Event loop delay sampled by node:perf_hooks.');
    lines.push('# TYPE dsh_hub_event_loop_delay_seconds gauge');
    lines.push(metricLine('dsh_hub_event_loop_delay_seconds', nanosecondsToSeconds(this.eventLoopDelay.mean), { statistic: 'mean' }));
    lines.push(metricLine('dsh_hub_event_loop_delay_seconds', nanosecondsToSeconds(this.eventLoopDelay.max), { statistic: 'max' }));

    return `${lines.join('\n')}\n`;
  }

  #relaySessionMetrics() {
    const counts = { total: 0, http: 0, ws: 0, pendingWs: 0 };
    for (const tunnel of this.tunnels.tunnels.values()) {
      for (const session of tunnel.sessions.values()) {
        counts.total += 1;
        const ctor = session?.constructor?.name;
        if (ctor === 'HttpSession') counts.http += 1;
        else if (ctor === 'WSSession') counts.ws += 1;
        else if (ctor === 'PendingWSSession') counts.pendingWs += 1;
      }
    }
    return counts;
  }

  #relayBackpressureMetrics() {
    const metrics = createBackpressureMetrics();
    for (const tunnel of this.tunnels.tunnels.values()) {
      const tunnelBufferedBytes = safeMetricBytes(tunnel.ws?.bufferedAmount);
      observeMetricAggregate(metrics.downstream.tunnel_websocket, tunnelBufferedBytes);
      for (const session of tunnel.sessions.values()) {
        const snapshot = session?.metricsSnapshot?.();
        if (!snapshot) continue;
        observeMetricAggregate(metrics.queued.browser_to_instance, snapshot.browserToInstanceQueuedBytes);
        observeMetricAggregate(metrics.queued.instance_to_browser, snapshot.instanceToBrowserQueuedBytes);
        observeMetricAggregate(metrics.uncredited.browser_to_instance, snapshot.browserToInstanceUncreditedBytes);
        observeMetricAggregate(metrics.uncredited.instance_to_browser, snapshot.instanceToBrowserUncreditedBytes);
        observeMetricAggregate(metrics.downstream.http_response, snapshot.httpResponseBufferedBytes);
        observeMetricAggregate(metrics.downstream.browser_websocket, snapshot.browserWebSocketBufferedBytes);
        observeMetricAggregate(metrics.creditWaiters.req, snapshot.reqCreditWaiters);
        observeMetricAggregate(metrics.creditWaiters.ws_c2i, snapshot.wsCreditWaiters);
        observeMetricAggregate(metrics.creditWaitBytes.req, snapshot.reqCreditWaitBytes);
        observeMetricAggregate(metrics.creditWaitBytes.ws_c2i, snapshot.wsCreditWaitBytes);
      }
    }
    return metrics;
  }

  #tunnelDeliveryMetrics() {
    const counts = { agent: 0, plugin: 0, unknown: 0 };
    for (const tunnel of this.tunnels.tunnels.values()) {
      if (tunnel.delivery === 'agent') counts.agent += 1;
      else if (tunnel.delivery === 'plugin') counts.plugin += 1;
      else counts.unknown += 1;
    }
    return counts;
  }

  #dshReachabilityMetrics() {
    const counts = { online: 0, offline: 0, unknown: 0, stale: 0 };
    const staleCutoff = now() - this.config.healthStaleAfterMs;
    for (const tunnel of this.tunnels.tunnels.values()) {
      if (!tunnel.dshHealthObserved) counts.unknown += 1;
      else if (!Number.isSafeInteger(tunnel.lastDshHealthAt) || tunnel.lastDshHealthAt < staleCutoff) counts.stale += 1;
      else if (tunnel.dshOnline) counts.online += 1;
      else counts.offline += 1;
    }
    return counts;
  }

  #inc(map, key, amount = 1) {
    map.set(key, (map.get(key) ?? 0) + amount);
  }

  #observeHeartbeat(sentAt) {
    if (!Number.isSafeInteger(sentAt)) return;
    const latencySeconds = Math.max(0, Math.min(3600, (now() - sentAt) / 1000));
    this.metrics.heartbeat.count += 1;
    this.metrics.heartbeat.sumSeconds += latencySeconds;
    this.metrics.heartbeat.maxSeconds = Math.max(this.metrics.heartbeat.maxSeconds, latencySeconds);
    this.metrics.heartbeat.lastSeconds = latencySeconds;
  }

  #observeSqliteWrite(operation, fn) {
    const label = stableMetricAction(operation);
    const started = process.hrtime.bigint();
    this.dbWriteDepth += 1;
    try {
      return fn();
    } finally {
      this.dbWriteDepth -= 1;
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const current = this.metrics.sqliteWrites.get(label) ?? {
        count: 0,
        sumSeconds: 0,
        maxSeconds: 0,
        lastSeconds: 0,
      };
      current.count += 1;
      current.sumSeconds += seconds;
      current.maxSeconds = Math.max(current.maxSeconds, seconds);
      current.lastSeconds = seconds;
      this.metrics.sqliteWrites.set(label, current);
    }
  }

  #setInstanceConnection(instanceId, values) {
    return this.#observeSqliteWrite('instance_connection_update', () => {
      setInstanceConnection(this.db, instanceId, values);
    });
  }

  #internalLoopbackRequest(req) {
    const host = normalizeHostHeader(req.headers.host);
    const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress ?? '');
    const loopbackHost = host === '127.0.0.1' || host === '::1' || host === 'localhost';
    const loopbackRemote = remoteAddress === '127.0.0.1' || remoteAddress === '::1';
    return loopbackHost && loopbackRemote;
  }

  #allowsTlsDomain(domain) {
    if (domain === this.config.portalHost) return true;
    if (domain === this.config.controlHost) return true;
    if (domain === `auth.${this.config.baseDomain}`) return true;

    const suffix = `.${this.config.instanceBaseDomain}`;
    if (!domain.endsWith(suffix) || domain.length <= suffix.length) return false;
    const instanceId = domain.slice(0, -suffix.length);
    if (!/^inst-[a-z2-7]{26}$/.test(instanceId)) return false;
    return Boolean(getInstance(this.db, instanceId));
  }

  async #handleRegister(req, res) {
    const requestId = this.#requestId(req);
    const clientAddress = this.#clientAddress(req);
    this.#checkRateLimit(`control-register:${clientAddress}`, {
      action: 'instance.register',
      actorType: 'network',
      actorId: clientAddress,
      requestId,
      limit: this.config.controlRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    const body = await this.#readJson(req);
    const { registryKey, replacementGrant, installationId, delivery, deploymentMode, hostname, clientVersion, dshVersion } = body;
    if (!!registryKey === !!replacementGrant) {
      return this.#error(res, new DbError('BAD_REQUEST', 'registryKey or replacementGrant required', 400));
    }
    if (delivery !== 'plugin' && delivery !== 'agent') {
      return this.#error(res, new DbError('BAD_REQUEST', 'delivery must be "plugin" or "agent"', 400));
    }
    const normalized = {
      registryKey: registryKey ? String(registryKey) : null,
      replacementGrant: replacementGrant ? String(replacementGrant) : null,
      installationId: String(installationId ?? ''),
      delivery,
      deploymentMode: normalizeDeploymentMode(deploymentMode),
      hostname: hostname ? String(hostname) : null,
      clientVersion: clientVersion ? String(clientVersion) : null,
      dshVersion: dshVersion ? String(dshVersion) : null,
    };
    if (registryKey) return this.#handleRegistryRegister(req, res, normalized, requestId);
    return this.#handleReplacementRegister(req, res, normalized, requestId);
  }

  #handleRegistryRegister(req, res, normalized, requestId) {
    const rk = findRegistryKey(this.db, normalized.registryKey, { includeInactive: true });
    if (!rk) return this.#error(res, new DbError('INVALID_REGISTRY_KEY', 'invalid registry key', 401));
    const result = this.#observeSqliteWrite('instance_register', () => runIdempotent(this.db, {
      actorScope: `registry:${rk.id}`,
      operation: 'instance.register',
      idempotencyKey: req.headers['idempotency-key'],
      request: normalized,
      mutate: () => {
        const active = findRegistryKey(this.db, normalized.registryKey);
        if (!active || active.id !== rk.id) {
          throw new DbError('INVALID_REGISTRY_KEY', 'invalid registry key', 401);
        }
        const inst = registerInstance(this.db, {
          namespaceId: active.namespace_id,
          installationId: normalized.installationId,
          delivery: normalized.delivery,
          deploymentMode: normalized.deploymentMode,
          hostname: normalized.hostname,
          clientVersion: normalized.clientVersion,
          dshVersion: normalized.dshVersion,
        });
        const token = issueInstanceToken(this.db, inst.id);
        this.#audit({
          actorType: 'registry',
          actorId: rk.id,
          namespaceId: active.namespace_id,
          instanceId: inst.id,
          action: 'instance.register',
          result: 'success',
          requestId,
          details: normalized.deploymentMode
            ? { delivery: normalized.delivery, deploymentMode: normalized.deploymentMode }
            : { delivery: normalized.delivery },
        });
        log(`instance registered: ${inst.id} (delivery=${normalized.delivery}) namespace=${active.namespace_id}`);
        return {
          statusCode: 201,
          body: {
            instanceId: inst.id,
            instanceToken: token.instanceToken,
            instanceTokenExpiresAt: new Date(token.expiresAt).toISOString(),
            instanceTokenRenewalUntil: new Date(token.renewalUntil).toISOString(),
            namespaceId: active.namespace_id,
            serverVersion: this.serverVersion,
          },
        };
      },
    }));
    return this.#json(res, result.statusCode, result.body);
  }

  #handleReplacementRegister(req, res, normalized, requestId) {
    const grant = findReplacementGrant(this.db, normalized.replacementGrant, { includeInactive: true });
    if (!grant) return this.#error(res, new DbError('INVALID_REPLACEMENT_GRANT', 'invalid replacement grant', 401));
    const result = this.#observeSqliteWrite('replacement_consume', () => runIdempotent(this.db, {
      actorScope: `replacement:${grant.id}`,
      operation: 'replacement.consume',
      idempotencyKey: req.headers['idempotency-key'],
      request: normalized,
      mutate: () => {
        const activeGrant = findReplacementGrant(this.db, normalized.replacementGrant);
        if (!activeGrant || activeGrant.id !== grant.id) {
          throw new DbError('INVALID_REPLACEMENT_GRANT', 'invalid replacement grant', 401);
        }
        const consumed = consumeReplacementGrant(this.db, {
          grantId: grant.id,
          rawGrant: normalized.replacementGrant,
          installationId: normalized.installationId,
          delivery: normalized.delivery,
          deploymentMode: normalized.deploymentMode,
          hostname: normalized.hostname,
          clientVersion: normalized.clientVersion,
          dshVersion: normalized.dshVersion,
        });
        this.#audit({
          actorType: 'replacement',
          actorId: grant.id,
          instanceId: consumed.instance.id,
          action: 'replacement.consume',
          result: 'success',
          requestId,
          details: normalized.deploymentMode
            ? { delivery: normalized.delivery, deploymentMode: normalized.deploymentMode }
            : { delivery: normalized.delivery },
        });
        log(`replacement grant consumed: instance ${consumed.instance.id}`);
        return {
          statusCode: 201,
          body: {
            instanceId: consumed.instance.id,
            instanceToken: consumed.token.instanceToken,
            instanceTokenExpiresAt: new Date(consumed.token.expiresAt).toISOString(),
            instanceTokenRenewalUntil: new Date(consumed.token.renewalUntil).toISOString(),
            namespaceId: consumed.instance.namespace_id,
            serverVersion: this.serverVersion,
          },
        };
      },
    }));
    if (!result.replayed) this.#closeTunnel(result.body.instanceId, 'TOKEN_REVOKED', 'token revoked');
    return this.#json(res, result.statusCode, result.body);
  }

  #bearerToken(req) {
    const auth = req.headers.authorization;
    const value = Array.isArray(auth) ? auth[0] : auth;
    const match = /^Bearer\s+(.+)$/i.exec(String(value ?? ''));
    return match ? match[1] : null;
  }

  async #handleTokenRotate(req, res, instanceId) {
    const requestId = this.#requestId(req);
    const rawToken = this.#bearerToken(req);
    if (!rawToken) return this.#error(res, new DbError('TOKEN_INVALID', 'token invalid', 401));
    const token = findInstanceToken(this.db, instanceId, rawToken, {
      includeExpiredRenewable: true,
      includeRotated: true,
    });
    if (!token) return this.#error(res, new DbError('TOKEN_INVALID', 'token invalid', 401));
    this.#checkRateLimit(`control-token-rotate:${token.id}`, {
      action: 'token.rotate',
      actorType: 'instance_token',
      actorId: token.id,
      requestId,
      limit: this.config.controlRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    const result = this.#observeSqliteWrite('token_rotate', () => runIdempotent(this.db, {
      actorScope: `instance-token:${token.id}`,
      operation: 'token.rotate',
      idempotencyKey: req.headers['idempotency-key'],
      request: { instanceId },
      mutate: () => {
        const rotated = rotateInstanceToken(this.db, { instanceId, rawToken, tokenId: token.id });
        this.#audit({
          actorType: 'instance_token',
          actorId: token.id,
          instanceId,
          action: 'token.rotate',
          result: 'success',
          requestId,
          details: { overlapUntil: rotated.overlapUntil },
        });
        return {
          statusCode: 200,
          body: {
            instanceToken: rotated.instanceToken,
            instanceTokenExpiresAt: new Date(rotated.expiresAt).toISOString(),
            instanceTokenRenewalUntil: new Date(rotated.renewalUntil).toISOString(),
            overlapUntil: new Date(rotated.overlapUntil).toISOString(),
          },
        };
      },
    }));
    if (result.body?.overlapUntil) {
      this.#scheduleTokenClose(instanceId, token.id, Date.parse(result.body.overlapUntil), 'TOKEN_ROTATED', 'token rotated');
    }
    return this.#json(res, result.statusCode, result.body);
  }

  async #handleSelfRevoke(req, res, instanceId) {
    const requestId = this.#requestId(req);
    const rawToken = this.#bearerToken(req);
    const token = rawToken ? findInstanceToken(this.db, instanceId, rawToken) : null;
    if (!token) return this.#error(res, new DbError('TOKEN_REVOKED', 'token revoked', 403));
    this.#checkRateLimit(`control-self-revoke:${token.id}`, {
      action: 'instance.revoke.self',
      actorType: 'instance_token',
      actorId: token.id,
      requestId,
      limit: this.config.controlRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
    this.#observeSqliteWrite('instance_revoke_self', () => revokeInstanceToken(this.db, instanceId, 'self_revoked'));
    this.#audit({
      actorType: 'instance_token',
      actorId: token.id,
      instanceId,
      action: 'instance.revoke.self',
      result: 'success',
      requestId,
    });
    this.#closeTunnel(instanceId, 'TOKEN_REVOKED', 'token revoked');
    res.writeHead(204);
    return res.end();
  }

  async #readJson(req, maxBytes = 16 * 1024) {
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      throw new DbError('UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json', 415);
    }
    const raw = await this.#collectBody(req, maxBytes);
    try {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('object required');
      return body;
    } catch {
      throw new DbError('BAD_REQUEST', 'bad json', 400);
    }
  }

  #collectBody(req, maxBytes = 256 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', (c) => {
        if (rejected) return;
        size += c.length;
        if (size > maxBytes) {
          rejected = true;
          req.pause();
          const err = new DbError('LIMIT_EXCEEDED', 'body too large', 413);
          err.closeConnection = true;
          reject(err);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!rejected) resolve(Buffer.concat(chunks));
      });
      req.on('error', (err) => {
        if (!rejected) reject(err);
      });
    });
  }

  #csrfToken(user) {
    return crypto.createHmac('sha256', this.csrfSecret)
      .update(`portal-csrf:${user}`)
      .digest('base64url');
  }

  #validatePortalWrite(req, user, { action, requestId }) {
    const originProblem = this.#validatePortalOrigin(req, { required: true });
    if (originProblem) throw originProblem;
    const rawToken = Array.isArray(req.headers['x-csrf-token'])
      ? req.headers['x-csrf-token'][0]
      : req.headers['x-csrf-token'];
    const expected = this.#csrfToken(user);
    if (!rawToken || !constantTimeStringEqual(String(rawToken), expected)) {
      throw new DbError('CSRF_INVALID', 'csrf token invalid', 403);
    }
    this.#checkRateLimit(`portal-write:${user}:${action}`, {
      action,
      actorType: 'user',
      actorId: user,
      requestId,
      limit: this.config.portalWriteRateLimitMax,
      windowMs: this.config.rateLimitWindowMs,
    });
  }

  #validatePortalReadOrigin(req) {
    return this.#validatePortalOrigin(req, { required: false });
  }

  #validatePortalOrigin(req, { required }) {
    const originValues = [];
    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === 'origin') originValues.push(req.rawHeaders[i + 1]);
    }
    const origin = req.headers.origin;
    if (originValues.length > 1 || (typeof origin === 'string' && origin.includes(','))) {
      return new DbError('FORBIDDEN_ORIGIN', 'multiple origins rejected', 403);
    }
    if (!origin) return required ? new DbError('FORBIDDEN_ORIGIN', 'origin required', 403) : null;
    return this.#portalOriginAllowed(origin) ? null : new DbError('FORBIDDEN_ORIGIN', 'origin mismatch', 403);
  }

  #validatePublicInviteWrite(req) {
    const fetchSites = String(req.headers['sec-fetch-site'] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase());
    if (fetchSites.includes('cross-site')) {
      return new DbError('FORBIDDEN_ORIGIN', 'cross-site request rejected', 403);
    }
    return this.#validatePortalOrigin(req, { required: false });
  }

  #portalOriginAllowed(origin) {
    return this.#portalPublicOrigins().some((expected) => originMatches(origin, expected));
  }

  #portalPublicOrigins() {
    const configuredPort = this.config.publicPort ?? (
      this.config.portalHost === 'localhost' && this.http.listening ? this.http.address().port : null
    );
    const port = configuredPort ? `:${configuredPort}` : '';
    const origins = [`${this.config.publicScheme}://${this.config.portalHost}${port}`];
    if (this.config.portalHost === 'localhost') {
      origins.push(`${this.config.publicScheme}://127.0.0.1${port}`);
      origins.push(`${this.config.publicScheme}://[::1]${port}`);
    }
    return origins;
  }

  #instanceFrameSrc() {
    const port = this.config.publicPort ? `:${this.config.publicPort}` : '';
    return `${this.config.publicScheme}://*.${this.config.instanceBaseDomain}${port}`;
  }

  #pageArgs(url) {
    const limitRaw = url.searchParams.get('limit');
    const limit = limitRaw === null ? 50 : Number(limitRaw);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new DbError('BAD_LIMIT', 'limit must be a positive integer', 400);
    }
    return { limit: Math.min(limit, 200), cursor: this.#decodeCursor(url.searchParams.get('cursor')) };
  }

  #page(rows, limit, mapper) {
    const pageRows = rows.slice(0, limit);
    const hasNext = rows.length > limit;
    const items = pageRows.map(mapper);
    const last = hasNext ? pageRows[pageRows.length - 1] : null;
    return { items, nextCursor: last ? this.#encodeCursor(last) : null };
  }

  #encodeCursor(row) {
    const createdAt = row.created_at ?? row.createdAt ?? row.time;
    const id = row.id ?? row.namespaceId ?? row.instanceId;
    const payload = { v: 1, createdAt, id };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  #decodeCursor(raw) {
    if (!raw) return null;
    const [body, sig, extra] = String(raw).split('.');
    if (!body || !sig || extra !== undefined) throw new DbError('BAD_CURSOR', 'cursor is invalid', 400);
    const expected = crypto.createHmac('sha256', this.cursorSecret).update(body).digest('base64url');
    if (!constantTimeStringEqual(sig, expected)) throw new DbError('BAD_CURSOR', 'cursor is invalid', 400);
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new DbError('BAD_CURSOR', 'cursor is invalid', 400);
    }
    if (parsed?.v !== 1 || !Number.isSafeInteger(parsed.createdAt) || typeof parsed.id !== 'string' || !parsed.id) {
      throw new DbError('BAD_CURSOR', 'cursor is invalid', 400);
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  }

  #onlineInstanceCounts() {
    const counts = new Map();
    for (const instanceId of this.tunnels.tunnels.keys()) {
      const instance = getInstance(this.db, instanceId);
      if (!instance) continue;
      counts.set(instance.namespace_id, (counts.get(instance.namespace_id) ?? 0) + 1);
    }
    return counts;
  }

  #namespaceDto(row, onlineInstanceCounts = new Map()) {
    return {
      namespaceId: row.id,
      name: row.name,
      description: row.description ?? null,
      ownerUserId: row.owner_user_id ?? null,
      ownerUsername: row.owner_username ?? row.owner_user_id ?? null,
      ownerDisplayName: row.owner_display_name ?? null,
      registryKey: row.registry_key_prefix ? {
        prefix: row.registry_key_prefix,
        version: row.registry_key_version,
        issuedAt: isoOrNull(row.registry_key_issued_at),
        secretAvailable: !!row.registry_key_secret_available,
      } : null,
      createdAt: isoOrNull(row.created_at),
      updatedAt: isoOrNull(row.updated_at),
      scope: row.scope ?? null,
      role: row.membership_role ?? null,
      memberCount: Number(row.member_count ?? 0),
      instanceCount: Number(row.instance_count ?? 0),
      activeInstanceCount: Number(row.active_instance_count ?? 0),
      onlineInstanceCount: Number(onlineInstanceCounts.get(row.id) ?? 0),
      nameConflict: Number(row.owner_name_conflict_count ?? 0) > 1,
      shortId: String(row.id ?? '').slice(0, 10),
    };
  }

  #meDto(user) {
    return {
      user: this.#userDto(user),
      systemAdmin: isSystemAdmin(this.db, user.id),
      capabilities: {
        canCreateNamespace: this.#can(user, 'namespace.create_self', null).allow,
        canCreateNamespaceForUser: this.#can(user, 'namespace.create_for_user', null).allow,
        canListUsers: this.#can(user, 'user.list', null).allow,
        canViewGlobalAudit: this.#can(user, 'audit.view_global', null).allow,
      },
    };
  }

  #userDto(row) {
    return {
      userId: row.id,
      username: row.username,
      email: row.email ?? null,
      displayName: row.display_name ?? null,
      status: row.status,
      systemAdmin: !!(row.is_system_admin ?? isSystemAdmin(this.db, row.id)),
      ownedNamespaceCount: Number(row.owned_namespace_count ?? 0),
      activeMembershipCount: Number(row.active_membership_count ?? 0),
      createdAt: isoOrNull(row.created_at),
      updatedAt: isoOrNull(row.updated_at),
    };
  }

  #memberDto(row) {
    return {
      membershipId: row.id,
      namespaceId: row.namespace_id,
      userId: row.user_id,
      username: row.username ?? row.user_id,
      email: row.email ?? null,
      displayName: row.display_name ?? null,
      userStatus: row.user_status ?? row.status ?? null,
      role: row.role,
      status: row.status,
      createdAt: isoOrNull(row.created_at),
      updatedAt: isoOrNull(row.updated_at),
    };
  }

  #inviteDto(row) {
    return {
      inviteId: row.id,
      namespaceId: row.namespace_id,
      role: row.role,
      emailHint: row.email_hint,
      status: row.status,
      expiresAt: isoOrNull(row.expires_at),
      createdAt: isoOrNull(row.created_at),
      consumedAt: isoOrNull(row.consumed_at),
      revokedAt: isoOrNull(row.revoked_at),
      failureCode: row.failure_code ?? null,
    };
  }

  #inviteCreatedDto(row) {
    return {
      inviteId: row.inviteId,
      token: row.token,
      role: row.role,
      emailHint: row.emailHint,
      expiresAt: isoOrNull(row.expiresAt),
      createdAt: isoOrNull(row.createdAt),
    };
  }

  #auditDto(row) {
    return {
      auditId: row.id,
      time: isoOrNull(row.time),
      actorType: row.actor_type,
      actorId: row.actor_id,
      namespaceId: row.namespace_id,
      instanceId: row.instance_id,
      targetUserId: row.target_user_id,
      inviteId: row.invite_id,
      action: row.action,
      result: row.result,
      requestId: row.request_id,
      details: safeJsonParse(row.details),
    };
  }

  #instanceDto(row) {
    const connectionState = this.tunnels.get(row.id) ? 'online' : 'offline';
    const dshHealth = row.last_dsh_observed_at === null ? null : {
      lastReportedOnline: !!row.last_dsh_online,
      observedAt: isoOrNull(row.last_dsh_observed_at),
      freshness: now() - row.last_dsh_observed_at > this.config.healthStaleAfterMs ? 'stale' : 'fresh',
    };
    return {
      instanceId: row.id,
      namespaceId: row.namespace_id,
      namespaceName: row.namespace_name,
      namespaceOwnerUserId: row.namespace_owner_user_id ?? null,
      ownerUsername: row.owner_username ?? null,
      installationId: row.installation_id,
      delivery: row.delivery,
      deploymentMode: publicDeploymentMode(row.deployment_mode),
      hostname: row.hostname,
      clientVersion: row.client_version,
      dshVersion: row.dsh_version,
      state: row.state,
      connectionState,
      role: row.membership_role ?? null,
      canOpen: row.membership_role !== 'viewer',
      latestTokenExpiresAt: isoOrNull(row.latest_token_expires_at),
      latestTokenRenewalUntil: isoOrNull(row.latest_token_renewal_until),
      lastSeenAt: isoOrNull(row.last_seen_at),
      dshHealth,
      createdAt: isoOrNull(row.created_at),
    };
  }

  #requestId(req) {
    const raw = Array.isArray(req.headers['x-request-id']) ? req.headers['x-request-id'][0] : req.headers['x-request-id'];
    const value = String(raw ?? '').trim();
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(value)) return value;
    return `req_${rid(8)}`;
  }

  #checkRateLimit(scope, { action, actorType, actorId = null, requestId, limit, windowMs }) {
    this.#sweepRateLimits();
    const at = now();
    const current = this.rateLimits.get(scope);
    const resetAt = current && current.resetAt > at ? current.resetAt : at + windowMs;
    const count = current && current.resetAt > at ? current.count + 1 : 1;
    this.rateLimits.set(scope, { count, resetAt });
    if (count <= limit) return;
    const retryAfter = Math.max(1, Math.ceil((resetAt - at) / 1000));
    this.#audit({
      actorType,
      actorId,
      action,
      result: 'rate_limited',
      requestId,
      details: { retryAfter },
    });
    this.#inc(this.metrics.rateLimitRejections, stableMetricAction(action));
    this.#inc(this.metrics.limitRejections, 'rate_limit');
    const err = new DbError('RATE_LIMITED', 'rate limit exceeded', 429);
    err.retryAfter = retryAfter;
    throw err;
  }

  #audit(event) {
    try {
      if (this.dbWriteDepth > 0) recordAudit(this.db, event);
      else this.#observeSqliteWrite('audit', () => recordAudit(this.db, event));
    } catch (err) {
      log(`audit write failed for ${event.action}: ${err.message}`);
    }
  }

  #mustAudit(event) {
    if (this.dbWriteDepth > 0) recordAudit(this.db, event);
    else this.#observeSqliteWrite('audit', () => recordAudit(this.db, event));
  }

  #sweepRateLimits() {
    const at = now();
    for (const [scope, value] of this.rateLimits.entries()) {
      if (!value || value.resetAt <= at) this.rateLimits.delete(scope);
    }
  }

  #scheduleLldapBootstrapSync(attempt = 1) {
    if (this.config.lldapMode === 'disabled') return;
    const username = this.config.bootstrapSystemAdminUsername;
    this._lldapBootstrapTimer = setTimeout(async () => {
      try {
        await this.lldap.addUserToAdmissionGroup(username);
        log(`LLDAP bootstrap user ${username} is in admission group ${this.config.lldapAdmissionGroup}`);
      } catch (error) {
        const maxAttempts = 24;
        if (attempt >= maxAttempts) {
          log(`LLDAP bootstrap user sync failed after ${attempt} attempts: ${error.code ?? error.message}`);
          this.#audit({
            actorType: 'system',
            actorId: 'bootstrap',
            targetUserId: username,
            action: 'lldap.bootstrap_group_sync',
            result: 'failed',
            details: { code: error.code ?? 'unknown' },
          });
          return;
        }
        this.#scheduleLldapBootstrapSync(attempt + 1);
      }
    }, attempt === 1 ? 1000 : 5000);
    this._lldapBootstrapTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // WebSocket upgrade handling
  // -------------------------------------------------------------------------
  #handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url, 'http://relay');
    } catch {
      socket.destroy();
      return;
    }

    const { kind, instanceId } = this.#routeByHost(req.headers.host);

    // Instance tunnel connection
    if (url.pathname === '/agent') {
      if (!this.#allowsControl(kind)) return this.#rejectUpgrade(socket, 404);
      this.wss.handleUpgrade(req, socket, head, (ws) => this.#onTunnelConnection(ws, req));
      return;
    }

    // Browser WebSocket to an instance subdomain (DSH events.mux / events.host)
    if (kind === 'instance') {
      const originProblem = this.#validateInstanceBrowserRequest(req, instanceId, { webSocket: true });
      if (originProblem) return this.#rejectUpgrade(socket, originProblem.status);
      let user;
      try {
        user = this.#activeUser(req);
      } catch (err) {
        return this.#rejectUpgrade(socket, err.status ?? 403);
      }
      if (!user) return this.#rejectUpgrade(socket, 401);
      const inst = getInstance(this.db, instanceId);
      if (!inst || inst.state !== 'active') return this.#rejectUpgrade(socket, 404);
      const ns = getNamespace(this.db, inst.namespace_id);
      if (!ns || !this.#can(user, 'instance.open', ns.id).allow) return this.#rejectUpgrade(socket, 403);
      const tunnel = this.tunnels.get(instanceId);
      if (!tunnel) return this.#rejectUpgrade(socket, 503);
      try {
        forwardHeaders(normalizeHeaders(req.headers), { hostHeader: tunnel.target.authority });
      } catch (err) {
        return this.#rejectUpgrade(socket, err.status ?? 400);
      }
      try {
        const accepted = forwardWsUpgrade({
          tunnel,
          req,
          socket,
          head,
          wss: this.wss,
          rejectUpgrade: (targetSocket, status) => this.#rejectUpgrade(targetSocket, status),
        });
        if (!accepted) return this.#rejectUpgrade(socket, 503);
      } catch (err) {
        return this.#rejectUpgrade(socket, err.status ?? 400);
      }
      return;
    }
    this.#rejectUpgrade(socket, 400);
  }

  #rejectUpgrade(socket, status) {
    this.#inc(this.metrics.wsUpgradeRejections, String(status));
    const reasons = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      499: 'Client Closed Request',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };
    socket.write(`HTTP/1.1 ${status} ${reasons[status] ?? 'Error'}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  // -------------------------------------------------------------------------
  // Tunnel lifecycle
  // -------------------------------------------------------------------------
  #onTunnelConnection(ws, req) {
    let done = false;
    const fail = (code, reason, frame = null) => {
      if (done) return;
      done = true;
      this.#inc(this.metrics.tunnelHandshakeFailures, stableMetricCode(frame?.code ?? handshakeFailureCode(reason)));
      clearTimeout(timeout);
      closeSocketGracefully(ws, { frame, code, reason });
    };
    const timeout = setTimeout(() => fail(4002, 'hello timeout'), 15000);

    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(timeout);
      if (!done) this.#onTunnelClose(ws, null);
    });
    ws.on('message', (data) => {
      if (done) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return fail(4003, 'bad hello'); }
      if (msg.type !== MSG.HELLO) return fail(4003, 'expected hello');
      clearTimeout(timeout);

      const inst = getInstance(this.db, msg.instanceId);
      if (!inst || inst.installation_id !== msg.installationId) {
        log(`tunnel auth failed for instance ${msg.instanceId} (${req.socket?.remoteAddress ?? '?'})`);
        return fail(4401, 'unauthorized', {
          type: MSG.UNAUTHORIZED,
          code: 'UNAUTHORIZED',
          message: 'invalid or revoked instance token',
        });
      }
      const auth = diagnoseInstanceToken(this.db, msg.instanceId, msg.token);
      if (!auth.ok) {
        log(`tunnel auth failed for instance ${msg.instanceId}: ${auth.code} (${req.socket?.remoteAddress ?? '?'})`);
        return fail(4401, auth.message, {
          type: MSG.UNAUTHORIZED,
          code: auth.code,
          message: auth.message,
        });
      }
      const token = auth.row;
      if (msg.proto !== PROTO_VERSION) {
        return fail(4403, 'bad protocol version', {
          type: MSG.ERROR,
          code: 'BAD_PROTO',
          message: `unsupported proto ${msg.proto}, expected ${PROTO_VERSION}`,
          fatal: true,
        });
      }
      if (!Number.isSafeInteger(msg.minor) || msg.minor < PROTO_MINOR) {
        return fail(4403, 'bad minor version', {
          type: MSG.ERROR,
          code: 'BAD_MINOR',
          message: `unsupported minor ${msg.minor}, expected at least ${PROTO_MINOR}`,
          fatal: true,
        });
      }
      const capabilities = new Set(Array.isArray(msg.capabilities) ? msg.capabilities : []);
      const missingCapability = REQUIRED_CAPABILITIES.find((capability) => !capabilities.has(capability));
      if (missingCapability) {
        return fail(4403, 'missing capability', {
          type: MSG.ERROR,
          code: 'MISSING_CAPABILITY',
          message: `missing required capability: ${missingCapability}`,
          fatal: true,
        });
      }
      const negotiated = negotiateLimits(msg.offeredLimits, this.config.protocolLimits);
      if (!negotiated.ok) {
        return fail(4403, negotiated.message, {
          type: MSG.ERROR,
          code: negotiated.code,
          message: negotiated.message,
          fatal: true,
        });
      }
      if (msg.delivery !== 'plugin' && msg.delivery !== 'agent') {
        return fail(4403, 'bad delivery');
      }
      const deploymentMode = normalizeDeploymentMode(msg.deploymentMode);

      const target = parseTarget(msg.target);
      if (!target.ok) {
        return fail(4403, target.message, {
          type: MSG.ERROR,
          code: target.code,
          message: target.message,
        });
      }
      const tunnel = new Tunnel({
        ws, instanceId: inst.id, tokenId: token.id, target: target.value,
        delivery: msg.delivery, deploymentMode, hostname: msg.hostname, dshVersion: msg.dshVersion,
        limits: negotiated.limits,
      });
      const takeover = this.#prepareTunnelTakeover(tunnel, token);
      if (!takeover.ok) {
        return fail(4401, takeover.reason, {
          type: MSG.UNAUTHORIZED,
          code: takeover.code,
          message: takeover.reason,
        });
      }
      this.tunnels.set(tunnel);
      this.#setInstanceConnection(inst.id, { lastSeen: now(), dshOnline: true, deploymentMode });
      ws.send(JSON.stringify({
        type: MSG.WELCOME,
        proto: PROTO_VERSION,
        minor: PROTO_MINOR,
        instanceId: inst.id,
        serverVersion: this.serverVersion,
        serverTime: now(),
        requiredCapabilities: REQUIRED_CAPABILITIES,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        pongTimeoutMs: this.config.pongTimeoutMs,
        inactiveTimeoutMs: this.config.inactiveMs,
        limits: negotiated.limits,
      }));
      log(`instance ${inst.id} (${msg.delivery}) online — target ${target.value.authority}`);

      ws.on('message', (d) => this.#onTunnelFrame(tunnel, d));
      ws.on('close', () => this.#onTunnelClose(ws, tunnel));
      done = true;
    });
  }

  #onTunnelFrame(tunnel, data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    tunnel.lastSeen = now();

    switch (msg.type) {
      case MSG.HEARTBEAT:
        this.#observeHeartbeat(msg.sentAt);
        tunnel.send({
          type: MSG.PONG,
          seq: Number.isSafeInteger(msg.seq) ? msg.seq : undefined,
          sentAt: Number.isSafeInteger(msg.sentAt) ? msg.sentAt : undefined,
          serverTime: now(),
        });
        break;
      case MSG.HEALTH: {
        tunnel.dshOnline = !!msg.dshOnline;
        tunnel.dshHealthObserved = true;
        tunnel.lastDshHealthAt = now();
        if (msg.dshVersion) tunnel.dshVersion = msg.dshVersion;
        this.#setInstanceConnection(tunnel.instanceId, { lastSeen: now(), dshOnline: tunnel.dshOnline });
        break;
      }
      case MSG.RESP:
      case MSG.RESP_DATA:
      case MSG.RESP_END:
      case MSG.WS_OPEN:
      case MSG.WS_ERR:
        if (msg.type === MSG.WS_ERR) this.#inc(this.metrics.relayTerminalFrames, `ws_error:${stableMetricCode(msg.code)}`);
        // fall through
      case MSG.WS_DATA:
      case MSG.WS_END:
      case MSG.CANCEL:
        if (msg.type === MSG.CANCEL) this.#inc(this.metrics.relayTerminalFrames, `cancel:${stableMetricCode(msg.code)}`);
        // fall through
      case MSG.CREDIT:
      case MSG.ERROR: {
        if (msg.type === MSG.ERROR) this.#inc(this.metrics.relayTerminalFrames, `error:${stableMetricCode(msg.code)}`);
        const s = tunnel.sessions.get(msg.id);
        if (s) s.handleFrame(msg.type, msg);
        break;
      }
      case MSG.BYE:
        tunnel.markDead({ closeCode: 1000, closeReason: 'bye' });
        break;
      default:
        break;
    }
  }

  #onTunnelClose(ws, tunnel) {
    if (!tunnel) return; // never handshook
    if (this.tunnels.get(tunnel.instanceId) === tunnel) {
      this.tunnels.delete(tunnel.instanceId);
    }
    const inst = getInstance(this.db, tunnel.instanceId);
    if (inst && !this.tunnels.get(tunnel.instanceId)) {
      this.#setInstanceConnection(tunnel.instanceId, { lastSeen: now() });
      log(`instance ${tunnel.instanceId} offline`);
    }
  }

  #sweepInactive() {
    this.#sweepRateLimits();
    try {
      this.#observeSqliteWrite('invite_pow_prune', () => pruneInvitePowChallenges(this.db));
    } catch (err) {
      log(`invite PoW cleanup failed: ${err.message}`);
    }
    const cutoff = Date.now() - this.config.inactiveMs;
    for (const t of [...this.tunnels.tunnels.values()]) {
      const token = this.db.prepare('SELECT * FROM instance_tokens WHERE id=?').get(t.tokenId);
      if (token?.rotated_at !== null && token?.overlap_until !== null && now() >= token.overlap_until) {
        log(`instance ${t.instanceId} old rotated token overlap ended, closing tunnel`);
        this.#closeTunnel(t.instanceId, 'TOKEN_ROTATED', 'token rotated', 4401);
        continue;
      }
      if (t.lastSeen < cutoff) {
        log(`instance ${t.instanceId} inactive, closing tunnel`);
        t.markDead();
      }
    }
  }

  #clientAddress(req) {
    const proxyAddress = normalizeRemoteAddress(req.socket?.remoteAddress ?? '');
    if (!this.#trustedProxy(req)) return proxyAddress;
    const forwardedFor = Array.isArray(req.headers['x-forwarded-for'])
      ? req.headers['x-forwarded-for'][0]
      : req.headers['x-forwarded-for'];
    const first = String(forwardedFor ?? '').split(',', 1)[0].trim();
    return normalizeRemoteAddress(first || proxyAddress);
  }

  #closeTunnel(instanceId, code, reason, closeCode = 4401) {
    const tunnel = this.tunnels.get(instanceId);
    if (!tunnel) return;
    tunnel.markDead({
      frame: { type: MSG.BYE, code, reason },
      closeCode,
      closeReason: reason,
    });
    tunnel.closeSessions(reason);
  }

  #prepareTunnelTakeover(nextTunnel, nextToken) {
    const previous = this.tunnels.get(nextTunnel.instanceId);
    if (!previous) return { ok: true };
    if (previous.tokenId === nextToken.id) return { ok: true };
    if (this.#tokenCanReach(previous.tokenId, nextToken.id)) {
      previous.markDead({
        frame: { type: MSG.BYE, code: 'TOKEN_ROTATED', reason: 'token rotated' },
        closeCode: 4401,
        closeReason: 'token rotated',
      });
      previous.closeSessions('token-rotated');
      return { ok: true };
    }
    if (this.#tokenCanReach(nextToken.id, previous.tokenId)) {
      return { ok: false, code: 'TOKEN_ROTATED', reason: 'token rotated' };
    }
    return { ok: true };
  }

  #tokenCanReach(startTokenId, targetTokenId) {
    const seen = new Set();
    let currentId = startTokenId;
    for (let depth = 0; depth < 64 && currentId && !seen.has(currentId); depth++) {
      seen.add(currentId);
      const token = getInstanceToken(this.db, currentId);
      if (!token?.rotated_to_token_id) return false;
      if (token.rotated_to_token_id === targetTokenId) return true;
      currentId = token.rotated_to_token_id;
    }
    return false;
  }

  #scheduleTokenClose(instanceId, tokenId, closeAt, code, reason) {
    const delay = Math.max(0, closeAt - now());
    const timer = setTimeout(() => {
      const tunnel = this.tunnels.get(instanceId);
      if (tunnel?.tokenId === tokenId) {
        tunnel.markDead({
          frame: { type: MSG.BYE, code, reason },
          closeCode: 4401,
          closeReason: reason,
        });
        tunnel.closeSessions(reason);
      }
    }, delay);
    timer.unref?.();
  }

  #validateInstanceBrowserRequest(req, instanceId, { webSocket }) {
    const method = String(req.method ?? 'GET').toUpperCase();
    if (method === 'TRACE' || method === 'CONNECT') {
      return new DbError('METHOD_NOT_ALLOWED', 'method not allowed', 405);
    }
    const target = String(req.url ?? '');
    if (!validOriginFormTarget(target)) {
      return new DbError('BAD_TARGET', 'absolute or invalid request target rejected', 400);
    }
    const fetchSites = String(req.headers['sec-fetch-site'] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase());
    if (fetchSites.includes('cross-site')) {
      return new DbError('FORBIDDEN_ORIGIN', 'cross-site request rejected', 403);
    }
    const originValues = [];
    for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
      if (String(req.rawHeaders[i]).toLowerCase() === 'origin') originValues.push(req.rawHeaders[i + 1]);
    }
    const origin = req.headers.origin;
    if (originValues.length > 1 || (typeof origin === 'string' && origin.includes(','))) {
      return new DbError('FORBIDDEN_ORIGIN', 'multiple origins rejected', 403);
    }
    const requireOrigin = webSocket || !['GET', 'HEAD'].includes(method);
    if (!origin) {
      return requireOrigin ? new DbError('FORBIDDEN_ORIGIN', 'origin required', 403) : null;
    }
    if (!originMatches(origin, this.#instancePublicOrigin(instanceId))) {
      return new DbError('FORBIDDEN_ORIGIN', 'origin mismatch', 403);
    }
    return null;
  }

  #instancePublicOrigin(instanceId) {
    const port = this.config.publicPort ? `:${this.config.publicPort}` : '';
    return `${this.config.publicScheme}://${instanceId}.${this.config.instanceBaseDomain}${port}`;
  }
}

function closeSocketGracefully(ws, { frame = null, code = 1000, reason = 'bye' } = {}) {
  const finalize = () => {
    try {
      if (ws.readyState < ws.CLOSING) ws.close(code, reason);
    } catch {
      /* noop */
    }
  };

  if (frame && ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(frame), () => finalize());
      return;
    } catch {
      /* noop */
    }
  }
  finalize();
}

function parseTarget(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    return { ok: false, code: 'BAD_TARGET', message: 'target object required' };
  }
  const host = String(target.host ?? '').toLowerCase();
  const port = Number(target.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    return { ok: false, code: 'TARGET_NOT_ALLOWED', message: 'target port out of range' };
  }
  if (host !== '127.0.0.1' && host !== '::1') {
    return { ok: false, code: 'TARGET_NOT_ALLOWED', message: 'target host must be 127.0.0.1 or ::1' };
  }
  const authority = host === '::1' ? `[::1]:${port}` : `${host}:${port}`;
  return { ok: true, value: { host, port, authority } };
}

function validOriginFormTarget(target) {
  if (!target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  if (/[\u0000-\u001f\u007f\\#]/.test(target)) return false;
  for (let i = 0; i < target.length; i++) {
    if (target[i] !== '%') continue;
    const encoded = target.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(encoded)) return false;
    const byte = parseInt(encoded, 16);
    if (byte <= 0x1f || byte === 0x7f || byte === 0x5c) return false;
    i += 2;
  }
  return true;
}

function requireOnlyFields(body, allowed) {
  const allowedSet = new Set(allowed);
  rejectDangerousKeys(body);
  for (const key of Object.keys(body)) {
    if (!allowedSet.has(key)) throw new DbError('BAD_REQUEST', `unexpected field: ${key}`, 400);
  }
}

function cleanRole(value, { allowOwner = false } = {}) {
  const role = String(value ?? '').trim();
  const allowed = allowOwner
    ? ['namespace_owner', 'namespace_admin', 'member', 'viewer']
    : ['namespace_admin', 'member', 'viewer'];
  if (!allowed.includes(role)) throw new DbError('BAD_ROLE', 'role is invalid', 400);
  return role;
}

function rejectDangerousKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new DbError('BAD_REQUEST', 'dangerous object key rejected', 400);
    }
    rejectDangerousKeys(value[key]);
  }
}

function cleanBoundedString(value, field, maxChars) {
  if (typeof value !== 'string') throw new DbError('BAD_REQUEST', `${field} must be a string`, 400);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > maxChars) {
    throw new DbError('BAD_REQUEST', `${field} must be 1..${maxChars} chars`, 400);
  }
  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new DbError('BAD_REQUEST', `${field} contains control characters`, 400);
  }
  return normalized;
}

function cleanOptionalBoundedString(value, field, maxChars) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new DbError('BAD_REQUEST', `${field} must be a string`, 400);
  if (!value.trim()) return null;
  return cleanBoundedString(value, field, maxChars);
}

function constantTimeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function safeJsonParse(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function inviteHtml({ nonce, token, available }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>dsh-hub invite</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  main { max-width: 560px; margin: 48px auto; padding: 0 20px; }
  .card { background:#1e293b; border:1px solid #334155; border-radius: 12px; padding: 20px; }
  label { display:block; margin: 12px 0 6px; color:#cbd5e1; font-size:13px; }
  input { box-sizing:border-box; width:100%; background:#0f172a; border:1px solid #334155; color:#e2e8f0; border-radius:8px; padding:9px 10px; font-size:14px; }
  button { margin-top:16px; background:#2563eb; color:white; border:0; border-radius:8px; padding:9px 14px; cursor:pointer; }
  .hint { color:#94a3b8; font-size:13px; }
  .error { color:#fca5a5; }
  .ok { color:#86efac; }
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Join dsh-hub</h1>
    <p id="summary" class="${available ? 'hint' : 'error'}">${available ? 'Loading invite…' : 'This invite is unavailable.'}</p>
    <form id="form">
      <label>Username</label><input name="username" autocomplete="username" required />
      <label>Email</label><input name="email" type="email" autocomplete="email" />
      <label>Display name</label><input name="displayName" autocomplete="name" />
      <label>Password</label><input name="password" type="password" autocomplete="new-password" required />
      <button type="submit">Create account</button>
    </form>
  </div>
</main>
<script nonce="${nonce}">
const token = ${JSON.stringify(token)};
const form = document.getElementById('form');
const summary = document.getElementById('summary');
async function api(url, opts) {
  const r = await fetch(url, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error?.message || r.statusText);
  return body;
}
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
function hasZeroBits(hex, bits) {
  const full = Math.floor(bits / 4);
  const rem = bits % 4;
  if (!hex.startsWith('0'.repeat(full))) return false;
  if (!rem) return true;
  return parseInt(hex[full] || '0', 16) < (1 << (4 - rem));
}
async function solve(challenge, difficulty) {
  for (let i = 0; i < 5000000; i++) {
    const nonce = String(i);
    if (hasZeroBits(await sha256Hex(challenge + ':' + nonce), difficulty)) return nonce;
  }
  throw new Error('proof of work failed');
}
async function init() {
  try {
    const data = await api('/api/invites/' + encodeURIComponent(token) + '/summary');
    summary.textContent = 'Namespace: ' + data.invite.namespaceName + ' · Role: ' + data.invite.role + ' · Expires: ' + data.invite.expiresAt;
  } catch (error) {
    summary.className = 'error';
    summary.textContent = 'This invite is unavailable.';
    form.hidden = true;
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  summary.className = 'hint';
  summary.textContent = 'Solving proof of work…';
  try {
    const pow = await api('/api/invites/' + encodeURIComponent(token) + '/pow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const nonce = await solve(pow.challenge.challenge, pow.challenge.difficulty);
    const values = Object.fromEntries(new FormData(form).entries());
    const result = await api('/api/invites/' + encodeURIComponent(token) + '/consume', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...values, powChallengeId: pow.challenge.id, powNonce: nonce }),
    });
    summary.className = 'ok';
    summary.textContent = 'Account created. Please sign in.';
    window.location.href = result.loginUrl || '/';
  } catch (error) {
    summary.className = 'error';
    summary.textContent = error.message;
  }
});
init();
</script>
</body>
</html>`;
}

function metricLine(name, value, labels = {}) {
  const labelEntries = Object.entries(labels);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, val]) => `${key}="${escapeMetricLabelValue(val)}"`).join(',')}}`
    : '';
  return `${name}${labelText} ${safeMetricNumber(value)}`;
}

function createOperationalMetrics() {
  return {
    httpErrors: new Map(),
    rateLimitRejections: new Map(),
    limitRejections: new Map(),
    wsUpgradeRejections: new Map(),
    tunnelHandshakeFailures: new Map(),
    relayTerminalFrames: new Map(),
    sqliteWrites: new Map(),
    heartbeat: {
      count: 0,
      sumSeconds: 0,
      maxSeconds: 0,
      lastSeconds: 0,
    },
  };
}

function createBackpressureMetrics() {
  return {
    queued: {
      browser_to_instance: createMetricAggregate(),
      instance_to_browser: createMetricAggregate(),
    },
    uncredited: {
      browser_to_instance: createMetricAggregate(),
      instance_to_browser: createMetricAggregate(),
    },
    downstream: {
      tunnel_websocket: createMetricAggregate(),
      http_response: createMetricAggregate(),
      browser_websocket: createMetricAggregate(),
    },
    creditWaiters: {
      req: createMetricAggregate(),
      ws_c2i: createMetricAggregate(),
    },
    creditWaitBytes: {
      req: createMetricAggregate(),
      ws_c2i: createMetricAggregate(),
    },
  };
}

function createMetricAggregate() {
  return { sum: 0, max: 0 };
}

function observeMetricAggregate(metric, value) {
  const n = safeMetricBytes(value);
  metric.sum += n;
  metric.max = Math.max(metric.max, n);
}

function sortedMetricEntries(map) {
  return [...map.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
}

function stableMetricCode(value) {
  const normalized = String(value ?? 'unknown').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const known = new Set([
    'BAD_CURSOR',
    'BAD_DOMAIN',
    'BAD_HOST',
    'BAD_IDENTITY_HEADER',
    'BAD_IDEMPOTENCY_KEY',
    'BAD_LIMIT',
    'BAD_LIMITS',
    'BAD_MINOR',
    'BAD_PROTO',
    'BAD_REQUEST',
    'BAD_ROLE',
    'BAD_USERNAME',
    'BAD_TARGET',
    'CLIENT_GONE',
    'CSRF_INVALID',
    'DIAGNOSTIC_CANCELLED',
    'FORBIDDEN',
    'FORBIDDEN_DOMAIN',
    'FORBIDDEN_HOST',
    'FORBIDDEN_ORIGIN',
    'HELLO_TIMEOUT',
    'IDEMPOTENCY_CONFLICT',
    'IDEMPOTENCY_REQUIRED',
    'INSTANCE_NOT_FOUND',
    'INSTANCE_OFFLINE',
    'INVITE_NOT_FOUND',
    'INVITE_UNAVAILABLE',
    'INTERNAL_ERROR',
    'INVALID_REGISTRY_KEY',
    'INVALID_REPLACEMENT_GRANT',
    'LIMIT_EXCEEDED',
    'LLDAP_GROUP_SYNC_FAILED',
    'LAST_SYSTEM_ADMIN',
    'LAST_OWNER',
    'MEMBER_ADD_FAILED',
    'MEMBERSHIP_NOT_FOUND',
    'METHOD_NOT_ALLOWED',
    'MISSING_CAPABILITY',
    'NOT_FOUND',
    'PARSE_ERROR',
    'POW_INVALID',
    'PROTOCOL_ERROR',
    'RATE_LIMITED',
    'RELAY_ERROR',
    'TARGET_NOT_ALLOWED',
    'TIMEOUT',
    'TOKEN_EXPIRED',
    'TOKEN_INVALID',
    'TOKEN_REVOKED',
    'TOKEN_ROTATED',
    'UNAUTHORIZED',
    'UNSUPPORTED_MEDIA_TYPE',
    'UPSTREAM_DOWN',
    'USER_NOT_FOUND',
    'WEAK_PASSWORD',
    'WS_ERROR',
  ]);
  return known.has(normalized) ? normalized : 'OTHER';
}

function handshakeFailureCode(reason) {
  if (reason === 'hello timeout') return 'HELLO_TIMEOUT';
  if (reason === 'bad hello') return 'PARSE_ERROR';
  if (reason === 'expected hello') return 'BAD_PROTO';
  if (reason === 'unauthorized') return 'UNAUTHORIZED';
  return reason;
}

function stableMetricAction(value) {
  const normalized = String(value ?? 'unknown').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const known = new Set([
    'audit',
    'instance_connection_update',
    'instance_register',
    'instance_revoke',
    'instance_revoke_owner',
    'instance_revoke_self',
    'instance_recover',
    'invite_create',
    'invite_consume',
    'invite_pow',
    'invite_revoke',
    'member_add',
    'member_remove',
    'member_update',
    'namespace_create',
    'namespace_member_add',
    'namespace_member_invite',
    'namespace_member_remove',
    'namespace_member_update',
    'registry_rotate',
    'replacement_consume',
    'replacement_create',
    'token_rotate',
    'user_disable',
    'user_restore',
  ]);
  return known.has(normalized) ? normalized : 'other';
}

function escapeMetricLabelValue(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function safeMetricNumber(value) {
  return Number.isFinite(value) ? String(value) : '0';
}

function safeMetricBytes(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nanosecondsToSeconds(value) {
  return Number.isFinite(value) ? value / 1e9 : 0;
}

function normalizeHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (raw.startsWith('[')) {
    const match = raw.match(/^\[([0-9a-f:.]+)\](?::(\d+))?$/i);
    if (!match) return '';
    if (!parseIpv6Bytes(match[1])) return '';
    if (!validPort(match[2])) return '';
    return match[1];
  }
  const match = raw.match(/^([a-z0-9.-]+)(?::(\d+))?$/);
  if (!match) return '';
  if (!validPort(match[2])) return '';
  const host = match[1];
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return '';
  return host;
}

function normalizeTlsAskDomain(value) {
  const domain = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253) return '';
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return '';
  if (!/^[a-z0-9.-]+$/.test(domain)) return '';
  if (domain.includes(':') || domain.includes('*')) return '';
  const labels = domain.split('.');
  if (labels.some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return '';
  return domain;
}

function parseBooleanFilter(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes'].includes(text)) return true;
  if (['0', 'false', 'no'].includes(text)) return false;
  throw new DbError('BAD_REQUEST', 'boolean filter must be true or false', 400);
}

function parseInstanceListFilters(url) {
  const status = String(url.searchParams.get('status') ?? '').trim().toLowerCase();
  const access = String(url.searchParams.get('access') ?? '').trim().toLowerCase();
  const connection = String(url.searchParams.get('connection') ?? '').trim().toLowerCase();
  const mode = String(url.searchParams.get('mode') ?? '').trim().toLowerCase();
  const delivery = String(url.searchParams.get('delivery') ?? '').trim().toLowerCase();
  const allowedStatus = new Set(['', 'online', 'offline', 'active', 'revoked']);
  if (!allowedStatus.has(status)) {
    throw new DbError('BAD_REQUEST', 'status filter is invalid', 400);
  }
  if (!['', 'active', 'revoked'].includes(access)) {
    throw new DbError('BAD_REQUEST', 'access filter is invalid', 400);
  }
  if (!['', 'online', 'offline'].includes(connection)) {
    throw new DbError('BAD_REQUEST', 'connection filter is invalid', 400);
  }
  if (!['', 'remote', 'hosted'].includes(mode)) {
    throw new DbError('BAD_REQUEST', 'mode filter is invalid', 400);
  }
  if (!['', 'agent', 'plugin'].includes(delivery)) {
    throw new DbError('BAD_REQUEST', 'delivery filter is invalid', 400);
  }
  return {
    state: access || (status === 'active' || status === 'revoked' ? status : null),
    connection: connection || (status === 'online' || status === 'offline' ? status : null),
    mode: mode || null,
    delivery: delivery || null,
  };
}

function validPort(raw) {
  if (raw === undefined) return true;
  const port = Number(raw);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535;
}

function normalizeRemoteAddress(addr) {
  const value = String(addr || '').replace(/^\[/, '').replace(/\]$/, '');
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function parseIpBytes(addr) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const parts = addr.split('.').map(Number);
    if (parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(parts);
    return null;
  }
  return parseIpv6Bytes(addr);
}

function parseIpv6Bytes(addr) {
  const halves = String(addr).toLowerCase().split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const parsePart = (part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : null);
  const leftNums = left.map(parsePart);
  const rightNums = right.map(parsePart);
  if (leftNums.includes(null) || rightNums.includes(null)) return null;
  const missing = halves.length === 2 ? 8 - leftNums.length - rightNums.length : 0;
  if (missing < 0 || (halves.length === 1 && leftNums.length !== 8)) return null;
  const nums = [...leftNums, ...Array(missing).fill(0), ...rightNums];
  const out = Buffer.alloc(16);
  nums.forEach((n, i) => out.writeUInt16BE(n, i * 2));
  return out;
}

function cidrContains(remote, range, bits) {
  const fullBytes = Math.floor(bits / 8);
  const remaining = bits % 8;
  if (fullBytes && !remote.subarray(0, fullBytes).equals(range.subarray(0, fullBytes))) return false;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining) & 0xff;
  return (remote[fullBytes] & mask) === (range[fullBytes] & mask);
}

function originMatches(rawOrigin, expectedOrigin) {
  if (rawOrigin === 'null') return false;
  try {
    const actual = new URL(rawOrigin);
    const expected = new URL(expectedOrigin);
    if (actual.username || actual.password || actual.pathname !== '/' || actual.search || actual.hash) return false;
    const port = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return actual.protocol === expected.protocol
      && actual.hostname.toLowerCase() === expected.hostname.toLowerCase()
      && port(actual) === port(expected);
  } catch {
    return false;
  }
}

function rawHeaderCount(req, headerName) {
  let count = 0;
  const wanted = String(headerName).toLowerCase();
  for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2) {
    if (String(req.rawHeaders[i]).toLowerCase() === wanted) count++;
  }
  return count;
}

function normalizeRuntimeConfig(config) {
  const baseDomain = String(config.baseDomain ?? 'localhost').toLowerCase();
  const lldapMode = String(config.lldapMode ?? 'disabled').toLowerCase();
  if (!['disabled', 'graphql', 'mock'].includes(lldapMode)) {
    throw new DbError('BAD_REQUEST', 'lldapMode must be disabled, graphql, or mock', 400);
  }
  return {
    ...config,
    baseDomain,
    portalHost: String(config.portalHost ?? baseDomain).toLowerCase(),
    controlHost: String(
      config.controlHost ?? (baseDomain === 'localhost' ? 'localhost' : `control.${baseDomain}`),
    ).toLowerCase(),
    instanceBaseDomain: String(
      config.instanceBaseDomain ?? (baseDomain === 'localhost' ? 'localhost' : `instances.${baseDomain}`),
    ).toLowerCase(),
    publicScheme: String(config.publicScheme ?? 'http').toLowerCase(),
    publicPort: config.publicPort ?? null,
    healthStaleAfterMs: config.healthStaleAfterMs ?? 90_000,
    rateLimitWindowMs: config.rateLimitWindowMs ?? 60_000,
    portalWriteRateLimitMax: config.portalWriteRateLimitMax ?? 240,
    controlRateLimitMax: config.controlRateLimitMax ?? 600,
    diagnosticCacheMs: config.diagnosticCacheMs ?? 30_000,
    publicInviteRateLimitMax: config.publicInviteRateLimitMax ?? 40,
    inviteTtlMs: config.inviteTtlMs ?? 24 * 60 * 60 * 1000,
    invitePowTtlMs: config.invitePowTtlMs ?? 5 * 60 * 1000,
    invitePowDifficulty: config.invitePowDifficulty ?? 16,
    authLogoutUrl: config.authLogoutUrl ?? null,
    authLoginUrl: config.authLoginUrl ?? null,
    bootstrapSystemAdminUsername: String(config.bootstrapSystemAdminUsername ?? config.devAuthUser ?? 'owner').toLowerCase(),
    lldapMode,
    lldapHttpUrl: config.lldapHttpUrl ?? null,
    lldapLdapUrl: config.lldapLdapUrl ?? null,
    lldapAdminUsername: config.lldapAdminUsername ?? null,
    lldapAdminPassword: config.lldapAdminPassword ?? null,
    lldapBaseDn: config.lldapBaseDn ?? null,
    lldapAdmissionGroup: config.lldapAdmissionGroup ?? 'dsh-hub-users',
    lldapTimeoutMs: config.lldapTimeoutMs ?? 5000,
    heartbeatIntervalMs: config.heartbeatIntervalMs ?? 20_000,
    pongTimeoutMs: config.pongTimeoutMs ?? 45_000,
    protocolLimits: { ...DEFAULT_LIMITS, ...(config.protocolLimits ?? {}) },
    trustedUserHeader: String(config.trustedUserHeader ?? 'remote-user').toLowerCase(),
    trustedProxyRanges: config.trustedProxyRanges ?? [
      { family: 4, bytes: Buffer.from([127, 0, 0, 1]), bits: 32 },
      { family: 6, bytes: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), bits: 128 },
    ],
  };
}

function createLldapClient(config) {
  if (config.lldapMode === 'graphql') {
    return new GraphqlLldapClient({
      httpUrl: config.lldapHttpUrl,
      ldapUrl: config.lldapLdapUrl,
      adminUsername: config.lldapAdminUsername,
      adminPassword: config.lldapAdminPassword,
      baseDn: config.lldapBaseDn,
      admissionGroup: config.lldapAdmissionGroup,
      timeoutMs: config.lldapTimeoutMs,
    });
  }
  return new NoopLldapClient({ enabled: config.lldapMode === 'mock' });
}
