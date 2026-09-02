#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'docker-compose.yml');
const envFile = path.join(__dirname, '.env.example');
const caddyExample = path.join(__dirname, 'caddy/Caddyfile.hub.example.com.example');
const deep = process.argv.includes('--deep');

const requiredFiles = [
  composeFile,
  envFile,
  path.join(root, 'Dockerfile'),
  path.join(root, '.dockerignore'),
  path.join(__dirname, 'authelia/configuration.yml'),
  path.join(__dirname, 'secrets/token-pepper-keyring.example.json'),
  path.join(__dirname, 'secrets/idempotency-encryption-keyring.example.json'),
  path.join(__dirname, 'secrets/authelia-jwt.example.txt'),
  path.join(__dirname, 'secrets/authelia-session.example.txt'),
  path.join(__dirname, 'secrets/authelia-storage.example.txt'),
  path.join(__dirname, 'secrets/lldap-jwt.example.txt'),
  path.join(__dirname, 'secrets/lldap-key-seed.example.txt'),
  path.join(__dirname, 'secrets/lldap-admin-password.example.txt'),
  caddyExample,
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) fail(`missing required file: ${path.relative(root, file)}`);
}

const env = readEnvFile(envFile);
for (const key of [
  'BASE_DOMAIN',
  'PORTAL_HOST',
  'CONTROL_HOST',
  'AUTH_HOST',
  'INSTANCE_BASE_DOMAIN',
  'DSH_HUB_SERVICE_BIND_PORT',
  'AUTHELIA_BIND_PORT',
  'LLDAP_LDAP_BIND_PORT',
  'LLDAP_HTTP_BIND_PORT',
  'TRUSTED_PROXY_CIDRS',
  'AUTH_LOGOUT_URL',
  'LLDAP_BASE_DN',
  'LLDAP_ADMIN_USERNAME',
  'LLDAP_ADMISSION_GROUP',
  'BOOTSTRAP_SYSTEM_ADMIN_USERNAME',
  'CURRENT_TOKEN_PEPPER_KEY_ID',
  'CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID',
]) {
  if (!env[key]) fail(`missing ${key} in ${path.relative(root, envFile)}`);
}

if (env.PORTAL_HOST !== env.BASE_DOMAIN) fail('PORTAL_HOST must equal BASE_DOMAIN for the existing-Caddy profile');
if (env.CONTROL_HOST !== `control.${env.BASE_DOMAIN}`) fail('CONTROL_HOST must be control.<BASE_DOMAIN>');
if (env.AUTH_HOST !== `auth.${env.BASE_DOMAIN}`) fail('AUTH_HOST must be auth.<BASE_DOMAIN>');
if (env.INSTANCE_BASE_DOMAIN !== `instances.${env.BASE_DOMAIN}`) fail('INSTANCE_BASE_DOMAIN must be instances.<BASE_DOMAIN>');
if (env.BOOTSTRAP_SYSTEM_ADMIN_USERNAME !== env.LLDAP_ADMIN_USERNAME) {
  fail('BOOTSTRAP_SYSTEM_ADMIN_USERNAME should match LLDAP_ADMIN_USERNAME in the example so the initial admin can sign in');
}
if (env.BASE_DOMAIN !== 'hub.example.com') {
  fail('public example check expects BASE_DOMAIN=hub.example.com; copy .env.example before adapting a private deployment');
}
if (env.TRUSTED_PROXY_CIDRS !== '127.0.0.1/32,::1/128') {
  fail('existing-Caddy host-network profile should only trust localhost proxies');
}

run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--quiet']);
const rendered = run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--format', 'json'], { capture: true });
const model = JSON.parse(rendered.stdout);

if (model.services?.caddy) fail('existing-Caddy profile must not start a compose Caddy service');
assertService(model.services, 'lldap');
assertService(model.services, 'authelia');
assertService(model.services, 'dsh-hub-service');

for (const [name, service] of Object.entries(model.services)) {
  if (service.network_mode !== 'host') fail(`${name} must use host network mode on the existing-Caddy profile`);
  if (service.ports?.length) fail(`${name} must not publish compose ports; bind loopback inside the container`);
}

const serviceCommand = (model.services['dsh-hub-service'].command ?? []).join(' ');
for (const expected of [
  '--host 127.0.0.1',
  `--port ${env.DSH_HUB_SERVICE_BIND_PORT}`,
  '--public-scheme https',
  `--portal-host ${env.PORTAL_HOST}`,
  `--control-host ${env.CONTROL_HOST}`,
  `--instance-base-domain ${env.INSTANCE_BASE_DOMAIN}`,
  `--trusted-proxy-cidrs ${env.TRUSTED_PROXY_CIDRS}`,
]) {
  if (!serviceCommand.includes(expected)) fail(`dsh-hub-service command missing: ${expected}`);
}

const serviceEnv = model.services['dsh-hub-service'].environment ?? {};
for (const key of [
  'TOKEN_PEPPER_KEYRING_FILE',
  'IDEMPOTENCY_ENCRYPTION_KEYRING_FILE',
  'LLDAP_MODE',
  'LLDAP_HTTP_URL',
  'LLDAP_LDAP_URL',
  'LLDAP_ADMIN_USERNAME',
  'LLDAP_ADMIN_PASSWORD_FILE',
  'LLDAP_BASE_DN',
  'LLDAP_ADMISSION_GROUP',
  'AUTH_LOGOUT_URL',
  'BOOTSTRAP_SYSTEM_ADMIN_USERNAME',
]) {
  if (!serviceEnv[key]) fail(`dsh-hub-service must configure env ${key}`);
}
if (serviceEnv.LLDAP_MODE !== 'graphql') fail('dsh-hub-service must enable LLDAP GraphQL provisioning');
if (serviceEnv.DSH_HUB_PROXY_KEY_FILE) fail('existing-Caddy profile must not require a proxy key in the system Caddyfile');

const autheliaEnv = model.services.authelia.environment ?? {};
if (!autheliaEnv.AUTHELIA_AUTHENTICATION_BACKEND_LDAP_PASSWORD_FILE) {
  fail('authelia must receive the LLDAP bind password from a Docker secret');
}

const lldapEnv = model.services.lldap.environment ?? {};
for (const key of [
  'LLDAP_LDAP_HOST',
  'LLDAP_HTTP_HOST',
  'LLDAP_LDAP_BASE_DN',
  'LLDAP_LDAP_USER_DN',
  'LLDAP_JWT_SECRET_FILE',
  'LLDAP_KEY_SEED_FILE',
  'LLDAP_LDAP_USER_PASS_FILE',
]) {
  if (!lldapEnv[key]) fail(`lldap must configure ${key}`);
}
if (lldapEnv.LLDAP_LDAP_HOST !== '127.0.0.1' || lldapEnv.LLDAP_HTTP_HOST !== '127.0.0.1') {
  fail('existing-Caddy LLDAP must bind LDAP and HTTP listeners to loopback only');
}

const autheliaConfig = fs.readFileSync(path.join(__dirname, 'authelia/configuration.yml'), 'utf8');
for (const expected of [
  `tcp://127.0.0.1:${env.AUTHELIA_BIND_PORT}/`,
  'implementation: lldap',
  `address: ldap://127.0.0.1:${env.LLDAP_LDAP_BIND_PORT}`,
  `base_dn: ${env.LLDAP_BASE_DN}`,
  `user: uid=${env.LLDAP_ADMIN_USERNAME},ou=people,${env.LLDAP_BASE_DN}`,
  `subject: "group:${env.LLDAP_ADMISSION_GROUP}"`,
  env.PORTAL_HOST,
  `*.${env.INSTANCE_BASE_DOMAIN}`,
  `https://${env.AUTH_HOST}`,
]) {
  if (!autheliaConfig.includes(expected)) fail(`Authelia config missing: ${expected}`);
}

const caddy = fs.readFileSync(caddyExample, 'utf8');
for (const expected of [
  `ask http://127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}/api/tls/ask`,
  'on_demand_tls',
  'tls {\n\t\ton_demand\n\t}',
  'request_header -Remote-User',
  'request_header -X-Authenticated-User',
  'request_header -X-Remote-User',
  'import dsh_hub_scrub_spoofed_identity',
  '@dsh_hub_public_invite path /invite/* /api/invites/*/summary /api/invites/*/pow /api/invites/*/consume',
  'respond /metrics 404',
  env.PORTAL_HOST,
  env.CONTROL_HOST,
  env.AUTH_HOST,
  `*.${env.INSTANCE_BASE_DOMAIN}`,
  `127.0.0.1:${env.AUTHELIA_BIND_PORT}`,
  `127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}`,
]) {
  if (!caddy.includes(expected)) fail(`Caddy example missing: ${expected}`);
}

if (deep) {
  run('docker', [
    'run', '--rm',
    '-v', `${caddyExample}:/etc/caddy/Caddyfile:ro`,
    'caddy:2.8-alpine',
    'caddy', 'validate', '--config', '/etc/caddy/Caddyfile',
  ]);
  const adapted = run('docker', [
    'run', '--rm',
    '-v', `${caddyExample}:/etc/caddy/Caddyfile:ro`,
    'caddy:2.8-alpine',
    'caddy', 'adapt', '--pretty', '--config', '/etc/caddy/Caddyfile',
  ], { capture: true });
  const adaptedConfig = JSON.parse(adapted.stdout);
  assertCaddyIdentityOrder(adaptedConfig, [
    { host: env.PORTAL_HOST, authDial: `127.0.0.1:${env.AUTHELIA_BIND_PORT}`, backendDial: `127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}` },
    { host: `*.${env.INSTANCE_BASE_DOMAIN}`, authDial: `127.0.0.1:${env.AUTHELIA_BIND_PORT}`, backendDial: `127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}` },
    { host: env.CONTROL_HOST, authDial: null, backendDial: `127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}` },
  ]);
  assertCaddyPublicInviteBypass(adaptedConfig, {
    host: env.PORTAL_HOST,
    authDial: `127.0.0.1:${env.AUTHELIA_BIND_PORT}`,
    backendDial: `127.0.0.1:${env.DSH_HUB_SERVICE_BIND_PORT}`,
  });
  assertCaddyMetricsRejectOrder(adaptedConfig, [
    { host: env.AUTH_HOST, backendDial: `127.0.0.1:${env.AUTHELIA_BIND_PORT}` },
  ]);
  run('docker', [
    'run', '--rm',
    '-v', `${path.join(__dirname, 'authelia')}:/config:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-jwt.example.txt')}:/run/secrets/authelia_jwt_secret:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-session.example.txt')}:/run/secrets/authelia_session_secret:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-storage.example.txt')}:/run/secrets/authelia_storage_encryption_key:ro`,
    '-v', `${path.join(__dirname, 'secrets/lldap-admin-password.example.txt')}:/run/secrets/lldap_admin_password:ro`,
    '-e', 'AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE=/run/secrets/authelia_jwt_secret',
    '-e', 'AUTHELIA_SESSION_SECRET_FILE=/run/secrets/authelia_session_secret',
    '-e', 'AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/run/secrets/authelia_storage_encryption_key',
    '-e', 'AUTHELIA_AUTHENTICATION_BACKEND_LDAP_PASSWORD_FILE=/run/secrets/lldap_admin_password',
    'authelia/authelia:4',
    'authelia', 'validate-config', '--config', '/config/configuration.yml',
  ]);
}

console.log('M2 existing-Caddy config check passed.');
console.log('This is an existing-Caddy template/config check. For release baselines, see docs/releases/.');

function assertService(services, name) {
  if (!services?.[name]) fail(`compose service missing: ${name}`);
}

function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function run(cmd, args, { capture = false } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (res.status !== 0) {
    if (capture) process.stderr.write(`${res.stdout ?? ''}${res.stderr ?? ''}`);
    fail(`${cmd} ${args.join(' ')} failed`);
  }
  return res;
}

function assertCaddyIdentityOrder(adapted, specs) {
  for (const spec of specs) {
    const handlers = findHandlersForHost(adapted, spec.host);
    const scrubIndex = handlers.findIndex(deletesRequestHeader('Remote-User'));
    if (scrubIndex < 0) fail(`adapted Caddy route for ${spec.host} must delete spoofed Remote-User before proxying`);
    const backendIndex = handlers.findIndex((handler, index) => index > scrubIndex && reverseProxyTo(spec.backendDial)(handler));
    if (backendIndex < 0) fail(`adapted Caddy route for ${spec.host} must proxy to ${spec.backendDial}`);
    assertMetricsRejectsBeforeBackend(spec.host, handlers, backendIndex);
    if (spec.authDial) {
      const authIndex = handlers.findIndex((handler, index) => index > scrubIndex && reverseProxyTo(spec.authDial)(handler));
      if (authIndex < 0) fail(`adapted Caddy route for ${spec.host} must forward_auth via ${spec.authDial}`);
      if (!(scrubIndex < authIndex && authIndex < backendIndex)) {
        fail(`adapted Caddy route for ${spec.host} must order scrub -> forward_auth -> backend proxy`);
      }
      const lateScrub = handlers.findIndex((handler, index) => (
        index > authIndex && index < backendIndex && deletesRequestHeader('Remote-User')(handler)
      ));
      if (lateScrub >= 0) fail(`adapted Caddy route for ${spec.host} deletes Authelia Remote-User before backend proxy`);
    }
  }
}

function assertCaddyMetricsRejectOrder(adapted, specs) {
  for (const spec of specs) {
    const handlers = findHandlersForHost(adapted, spec.host);
    const backendIndex = handlers.findIndex(reverseProxyTo(spec.backendDial));
    if (backendIndex < 0) fail(`adapted Caddy route for ${spec.host} must proxy to ${spec.backendDial}`);
    assertMetricsRejectsBeforeBackend(spec.host, handlers, backendIndex);
  }
}

function assertCaddyPublicInviteBypass(adapted, spec) {
  const handlers = findHandlersForHost(adapted, spec.host);
  const publicBackendIndex = handlers.findIndex((handler) => (
    reverseProxyTo(spec.backendDial)(handler) && routeMatchesPath(handler.__routeMatch, '/invite/*')
  ));
  if (publicBackendIndex < 0) fail(`adapted Caddy route for ${spec.host} must proxy public invite paths without auth`);
  const publicAuthIndex = handlers.findIndex((handler) => (
    reverseProxyTo(spec.authDial)(handler) && routeMatchesPath(handler.__routeMatch, '/invite/*')
  ));
  if (publicAuthIndex >= 0) fail(`adapted Caddy route for ${spec.host} must not forward_auth public invite paths`);
}

function assertMetricsRejectsBeforeBackend(host, handlers, backendIndex) {
  const metricsRejectIndex = handlers.findIndex(rejectsPath('/metrics'));
  if (metricsRejectIndex < 0) fail(`adapted Caddy route for ${host} must reject public /metrics before proxying`);
  if (metricsRejectIndex >= backendIndex) fail(`adapted Caddy route for ${host} rejects /metrics after backend proxy`);
}

function findHandlersForHost(adapted, host) {
  const routes = Object.values(adapted?.apps?.http?.servers ?? {}).flatMap((server) => server.routes ?? []);
  const route = routes.find((candidate) => (candidate.match ?? []).some((match) => (match.host ?? []).includes(host)));
  if (!route) fail(`adapted Caddy route missing for host ${host}`);
  return flattenHandlers(route);
}

function flattenHandlers(route, inheritedMatch = []) {
  const handlers = [];
  const routeMatch = [...inheritedMatch, ...(route.match ?? [])];
  for (const handler of route.handle ?? []) {
    handlers.push({ ...handler, __routeMatch: routeMatch });
    if (handler.handler === 'subroute') {
      for (const child of handler.routes ?? []) handlers.push(...flattenHandlers(child, routeMatch));
    }
  }
  return handlers;
}

function deletesRequestHeader(name) {
  return (handler) => handler.handler === 'headers' && (handler.request?.delete ?? []).includes(name);
}

function reverseProxyTo(dial) {
  return (handler) => handler.handler === 'reverse_proxy'
    && (handler.upstreams ?? []).some((upstream) => upstream.dial === dial);
}

function rejectsPath(pathname) {
  return (handler) => handler.handler === 'static_response'
    && String(handler.status_code) === '404'
    && routeMatchesPath(handler.__routeMatch, pathname);
}

function routeMatchesPath(matchers, pathname) {
  return (matchers ?? []).some((match) => (match.path ?? []).includes(pathname));
}

function fail(message) {
  console.error(`M2 existing-Caddy config check failed: ${message}`);
  process.exit(1);
}
