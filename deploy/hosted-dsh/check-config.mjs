import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(__dirname, '../..');
const composeFile = path.join(__dirname, 'docker-compose.yml');
const envFile = path.join(__dirname, '.env.example');
const dockerfile = path.join(__dirname, 'Dockerfile');
const entrypoint = path.join(__dirname, 'entrypoint.sh');
const pluginPackage = path.join(repoRoot, 'packages/dsh-hub-plugin/package.json');
const hostedPatch = path.join(repoRoot, 'packages/dsh-hub-plugin/hosted-capabilities.patch.yml');
const restrictedPicker = path.join(repoRoot, 'packages/dsh-hub-plugin/src/restricted-directory-picker.js');

function fail(message) {
  console.error(`G11 hosted DSH config check failed: ${message}`);
  process.exit(1);
}

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function run(cmd, args, { capture = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    fail(`${cmd} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

for (const file of [composeFile, envFile, dockerfile, entrypoint, pluginPackage, hostedPatch, restrictedPicker]) {
  if (!fs.existsSync(file)) fail(`missing required file: ${path.relative(repoRoot, file)}`);
}

const combinedText = [composeFile, envFile, dockerfile, entrypoint, hostedPatch, restrictedPicker].map(read).join('\n');
const forbiddenSecretPatterns = [
  /\b(?:dhk|dhr|dht|dit)_[A-Za-z0-9_-]{8,}\b/,
  /registry[_-]?key/i,
  /replacement[_-]?grant/i,
  /instance[_-]?token/i,
  /BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY/,
];
for (const pattern of forbiddenSecretPatterns) {
  if (pattern.test(combinedText)) fail(`template contains forbidden secret-shaped text: ${pattern}`);
}

const rendered = run('docker', ['compose', '--env-file', envFile, '-f', composeFile, 'config', '--format', 'json'], { capture: true });
let config;
try {
  config = JSON.parse(rendered);
} catch (err) {
  fail(`docker compose JSON output could not be parsed: ${err.message}`);
}

const service = config.services?.['hosted-dsh'];
if (!service) fail('compose service hosted-dsh is missing');
if (service.privileged === true) fail('hosted-dsh must not be privileged');
if (Array.isArray(service.ports) && service.ports.length > 0) fail('hosted-dsh must not publish ports');
if (service.read_only !== true) fail('hosted-dsh root filesystem should be read_only');
if (!service.security_opt?.includes('no-new-privileges:true')) fail('no-new-privileges security option is required');
if (!service.cap_drop?.includes('ALL')) fail('cap_drop: ALL is required');
if (!service.mem_limit) fail('mem_limit is required');
if (!service.pids_limit) fail('pids_limit is required');
if (!service.cpus) fail('cpus limit is required');
if (service.user === '0' || service.user === 'root') fail('service must not run as root');
if (!service.healthcheck) fail('healthcheck is required');
if (service.logging?.driver !== 'json-file') fail('json-file logging driver is required');
if (service.logging?.options?.['max-size'] !== '10m') fail('json-file max-size=10m is required');
if (String(service.logging?.options?.['max-file']) !== '7') fail('json-file max-file=7 is required');

const env = service.environment ?? {};
for (const key of Object.keys(env)) {
  if (/REGISTRY|REPLACEMENT|TOKEN|KEY/i.test(key)) fail(`long-lived secret-like environment variable is not allowed: ${key}`);
}
for (const required of ['DSH_HOME', 'DSH_HUB_ENDPOINT', 'DSH_HUB_NAMESPACE', 'DSH_HUB_INSTANCE_NAME', 'DSH_HUB_REMOTE_PATCH', 'DSH_HUB_DEPLOYMENT_MODE']) {
  if (!Object.prototype.hasOwnProperty.call(env, required)) fail(`missing environment ${required}`);
}
if (env.DSH_HUB_REMOTE_PATCH !== 'hosted-capabilities.patch.yml') {
  fail('hosted-dsh should default to hosted-capabilities.patch.yml');
}
if (env.DSH_HUB_DEPLOYMENT_MODE !== 'hosted') {
  fail('hosted-dsh should default to deployment mode hosted');
}

const volumes = service.volumes ?? [];
if (volumes.length < 3) fail('expected dsh-home, workspace, and logs bind mounts');
for (const volume of volumes) {
  const source = volume.source ?? '';
  const target = volume.target ?? '';
  if (source === '/' || source === '/home' || source === '/root' || source === '/var' || source === '/var/run') {
    fail(`broad host mount is not allowed: ${source}`);
  }
  if (source.includes('/var/run/docker.sock') || target.includes('/var/run/docker.sock')) {
    fail('Docker socket mount is not allowed');
  }
}
for (const target of ['/dsh-home', '/workspace', '/logs']) {
  if (!volumes.some((volume) => volume.target === target)) fail(`missing bind mount target ${target}`);
}

const dockerfileText = read(dockerfile);
if (!/USER dsh/.test(dockerfileText)) fail('Dockerfile must switch to USER dsh');
if (!/0\.1\.0-rc\.7/.test(dockerfileText)) fail('Dockerfile must pin the initial DSH version to 0.1.0-rc.7');
if (!/dsh-hub-hosted-entrypoint/.test(dockerfileText)) fail('Dockerfile must install the hosted entrypoint');
if (!/dsh-hub-client/.test(dockerfileText) || !/dsh-hub-web/.test(dockerfileText)) {
  fail('Dockerfile must expose dsh-hub-client and dsh-hub-web on PATH');
}
if (!/@deepseek-ai\/dsh\/node_modules\/dsh-hub-plugin/.test(dockerfileText)) {
  fail('Dockerfile must make dsh-hub-plugin resolvable by the global DSH loader');
}
if (!/--expose-internals/.test(dockerfileText)) {
  fail('Dockerfile must wrap dsh with node --expose-internals for the DSH HMR service');
}
if (!/npm ci --include=dev/.test(dockerfileText)) {
  fail('Dockerfile must keep plugin peer dependencies available for the DSH loader');
}

const entrypointText = read(entrypoint);
for (const expected of ['plugin-install', 'plugin-join', 'dsh-hub-web', '--registry-key-stdin']) {
  if (expected === '--registry-key-stdin') continue;
  if (!entrypointText.includes(expected)) fail(`entrypoint should reference ${expected}`);
}
if (!/--no-open/.test(entrypointText)) fail('entrypoint should pass --no-open to DSH web');
if (!/--host 127\.0\.0\.1/.test(entrypointText)) fail('entrypoint should bind DSH web to loopback');
if (!entrypointText.includes('DSH_HUB_REMOTE_PATCH')) fail('entrypoint should pass the hosted remote patch explicitly');
if (!entrypointText.includes('DSH_HUB_DEPLOYMENT_MODE')) fail('entrypoint should pass deployment mode explicitly');

const hostedPatchText = read(hostedPatch);
if (!hostedPatchText.includes('dsh-hub-plugin/restricted-directory-picker')) {
  fail('hosted overlay must mount the restricted directory picker backend');
}
if (hostedPatchText.includes('@deepseek-ai/dsh-host-directory-picker-browse')) {
  fail('hosted overlay must not mount the whole-filesystem browse backend');
}
if (!hostedPatchText.includes('root: /workspace')) {
  fail('hosted overlay must restrict the picker root to /workspace');
}

console.log(JSON.stringify({
  ok: true,
  template: 'deploy/hosted-dsh',
  service: 'hosted-dsh',
  dshVersion: env.DSH_VERSION ?? '0.1.0-rc.7',
  publishedPorts: service.ports?.length ?? 0,
  volumes: volumes.map((volume) => volume.target),
  resourceLimits: {
    cpus: service.cpus,
    memLimit: service.mem_limit,
    pidsLimit: service.pids_limit,
  },
}, null, 2));
