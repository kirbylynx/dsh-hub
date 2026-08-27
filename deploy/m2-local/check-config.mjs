#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'docker-compose.yml');
const envFile = path.join(__dirname, '.env.example');
const deep = process.argv.includes('--deep');

const requiredFiles = [
  composeFile,
  path.join(root, 'Dockerfile'),
  path.join(root, '.dockerignore'),
  path.join(__dirname, 'caddy/Caddyfile'),
  path.join(__dirname, 'authelia/configuration.yml'),
  path.join(__dirname, 'authelia/users_database.yml.example'),
  path.join(__dirname, 'secrets/token-pepper-keyring.example.json'),
  path.join(__dirname, 'secrets/idempotency-encryption-keyring.example.json'),
  path.join(__dirname, 'secrets/proxy-key.example.txt'),
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
  'TRUSTED_PROXY_CIDRS',
  'CURRENT_TOKEN_PEPPER_KEY_ID',
  'CURRENT_IDEMPOTENCY_ENCRYPTION_KEY_ID',
]) {
  if (!env[key]) fail(`missing ${key} in ${path.relative(root, envFile)}`);
}

if (env.PORTAL_HOST !== env.BASE_DOMAIN) fail('PORTAL_HOST must equal BASE_DOMAIN for the v0.1.0 compose baseline');
if (env.CONTROL_HOST !== `control.${env.BASE_DOMAIN}`) fail('CONTROL_HOST must be control.<BASE_DOMAIN>');
if (env.AUTH_HOST !== `auth.${env.BASE_DOMAIN}`) fail('AUTH_HOST must be auth.<BASE_DOMAIN>');
if (env.INSTANCE_BASE_DOMAIN !== `instances.${env.BASE_DOMAIN}`) fail('INSTANCE_BASE_DOMAIN must be instances.<BASE_DOMAIN>');

run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--quiet']);
const rendered = run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--format', 'json'], { capture: true });
const model = JSON.parse(rendered.stdout);

assertService(model.services, 'caddy');
assertService(model.services, 'authelia');
assertService(model.services, 'dsh-hub-service');

const network = model.networks?.dsh_hub_net;
if (network?.ipam?.config?.length) {
  fail('dsh_hub_net must not pin a subnet in the local template; let Docker choose a non-conflicting range');
}

for (const [serviceName, service] of Object.entries(model.services)) {
  const serviceNetwork = service.networks?.dsh_hub_net;
  if (serviceNetwork?.ipv4_address || serviceNetwork?.ipv6_address) {
    fail(`${serviceName} must not pin a container IP in the local template`);
  }
}

if (model.services['dsh-hub-service'].ports?.length) fail('dsh-hub-service must not publish host ports');
if (!model.services.caddy.ports?.some((p) => String(p.published) === '80')) fail('caddy must publish port 80');
if (!model.services.caddy.ports?.some((p) => String(p.published) === '443')) fail('caddy must publish port 443');
if (!model.services.caddy.command?.some((part) => String(part).includes('DSH_HUB_PROXY_KEY'))) {
  fail('caddy must load DSH_HUB_PROXY_KEY from the Docker secret before starting');
}

const serviceCommand = (model.services['dsh-hub-service'].command ?? []).join(' ');
for (const expected of [
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
  'DSH_HUB_PROXY_KEY_FILE',
]) {
  if (!serviceEnv[key]) fail(`dsh-hub-service must use secret file env ${key}`);
}

const caddy = fs.readFileSync(path.join(__dirname, 'caddy/Caddyfile'), 'utf8');
for (const expected of [
  'request_header -Remote-User',
  'request_header -X-Authenticated-User',
  'request_header -X-Remote-User',
  'import scrub_spoofed_identity',
  'respond /metrics 404',
]) {
  if (!caddy.includes(expected)) fail(`Caddyfile missing required public-entry guard: ${expected}`);
}

if (deep) {
  run('docker', [
    'run', '--rm',
    '-e', `ACME_EMAIL=${env.ACME_EMAIL}`,
    '-e', `AUTH_HOST=${env.AUTH_HOST}`,
    '-e', `PORTAL_HOST=${env.PORTAL_HOST}`,
    '-e', `CONTROL_HOST=${env.CONTROL_HOST}`,
    '-e', `INSTANCE_BASE_DOMAIN=${env.INSTANCE_BASE_DOMAIN}`,
    '-e', 'DSH_HUB_PROXY_KEY=insecure-m2-local-proxy-key-replace-on-vps',
    '-v', `${path.join(__dirname, 'caddy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    'caddy:2.8-alpine',
    'caddy', 'validate', '--config', '/etc/caddy/Caddyfile',
  ]);
  const adapted = run('docker', [
    'run', '--rm',
    '-e', `ACME_EMAIL=${env.ACME_EMAIL}`,
    '-e', `AUTH_HOST=${env.AUTH_HOST}`,
    '-e', `PORTAL_HOST=${env.PORTAL_HOST}`,
    '-e', `CONTROL_HOST=${env.CONTROL_HOST}`,
    '-e', `INSTANCE_BASE_DOMAIN=${env.INSTANCE_BASE_DOMAIN}`,
    '-e', 'DSH_HUB_PROXY_KEY=insecure-m2-local-proxy-key-replace-on-vps',
    '-v', `${path.join(__dirname, 'caddy/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    'caddy:2.8-alpine',
    'caddy', 'adapt', '--pretty', '--config', '/etc/caddy/Caddyfile',
  ], { capture: true });
  const adaptedConfig = JSON.parse(adapted.stdout);
  assertCaddyIdentityOrder(adaptedConfig, [
    { host: env.PORTAL_HOST, authDial: 'authelia:9091', backendDial: 'dsh-hub-service:8081' },
    { host: `*.${env.INSTANCE_BASE_DOMAIN}`, authDial: 'authelia:9091', backendDial: 'dsh-hub-service:8081' },
    { host: env.CONTROL_HOST, authDial: null, backendDial: 'dsh-hub-service:8081' },
  ]);
  assertCaddyMetricsRejectOrder(adaptedConfig, [
    { host: env.AUTH_HOST, backendDial: 'authelia:9091' },
  ]);
  run('docker', [
    'run', '--rm',
    '-v', `${path.join(__dirname, 'authelia')}:/config:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-jwt.example.txt')}:/run/secrets/authelia_jwt_secret:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-session.example.txt')}:/run/secrets/authelia_session_secret:ro`,
    '-v', `${path.join(__dirname, 'secrets/authelia-storage.example.txt')}:/run/secrets/authelia_storage_encryption_key:ro`,
    '-e', 'AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET_FILE=/run/secrets/authelia_jwt_secret',
    '-e', 'AUTHELIA_SESSION_SECRET_FILE=/run/secrets/authelia_session_secret',
    '-e', 'AUTHELIA_STORAGE_ENCRYPTION_KEY_FILE=/run/secrets/authelia_storage_encryption_key',
    'authelia/authelia:4',
    'authelia', 'validate-config', '--config', '/config/configuration.yml',
  ]);
}

console.log('M2 local config check passed.');
console.log('This is a local template/config check. For v0.1.0 live deployment evidence and remaining production hardening work, see docs/releases/v0.1.0.md.');

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
    const backendIndex = handlers.findIndex(reverseProxyTo(spec.backendDial));
    if (scrubIndex < 0) fail(`adapted Caddy route for ${spec.host} must delete spoofed Remote-User before proxying`);
    if (backendIndex < 0) fail(`adapted Caddy route for ${spec.host} must proxy to ${spec.backendDial}`);
    if (scrubIndex >= backendIndex) fail(`adapted Caddy route for ${spec.host} deletes Remote-User after backend proxy`);
    assertMetricsRejectsBeforeBackend(spec.host, handlers, backendIndex);
    if (spec.authDial) {
      const authIndex = handlers.findIndex(reverseProxyTo(spec.authDial));
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

function flattenHandlers(route) {
  const handlers = [];
  for (const handler of route.handle ?? []) {
    handlers.push({ ...handler, __routeMatch: route.match ?? [] });
    if (handler.handler === 'subroute') {
      for (const child of handler.routes ?? []) handlers.push(...flattenHandlers(child));
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
  console.error(`M2 local config check failed: ${message}`);
  process.exit(1);
}
