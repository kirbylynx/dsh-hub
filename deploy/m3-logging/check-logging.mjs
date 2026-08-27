#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  log as serviceLog,
  redactLogText as redactServiceLogText,
} from '../../packages/dsh-hub-service/src/util.js';
import {
  log as clientLog,
  redactLogText as redactClientLogText,
} from '../../packages/dsh-hub-client/src/util.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const localComposePath = path.join(repoRoot, 'deploy/m2-local/docker-compose.yml');
const existingCaddyComposePath = path.join(repoRoot, 'deploy/m2-existing-caddy/docker-compose.yml');
const runbookPath = path.join(repoRoot, 'docs/ops/m3-log-retention.md');
const readmePath = path.join(repoRoot, 'deploy/m3-logging/README.md');
const clientIndexPath = path.join(repoRoot, 'packages/dsh-hub-client/src/index.js');
const redactionOnly = process.argv.includes('--redaction-only');

const requiredLogDriver = 'json-file';
const requiredMaxSize = '10m';
const requiredMaxFile = 7;

const secretSamples = [
  'dhk_abcdefghijklmnopqrstuvwxyzABCDEF',
  'dhr_abcdefghijklmnopqrstuvwxyzABCDEF',
  'dht_abcdefghijklmnopqrstuvwxyzABCDEF',
  'dit_abcdefghijklmnopqrstuvwxyzABCDEF',
];
const redactionFixtures = [
  {
    input: 'Cookie: sid=abc; other=def',
    forbidden: ['sid=abc', 'other=def'],
  },
  {
    input: 'authorization: Basic abcdef',
    forbidden: ['Basic abcdef'],
  },
  {
    input: 'authorization=Basic abcdef',
    forbidden: ['Basic abcdef', 'abcdef'],
  },
  {
    input: 'proxyAuthorization=Basic abcdef',
    forbidden: ['Basic abcdef', 'abcdef'],
  },
  {
    input: 'proxy-authorization=Basic abcdef',
    forbidden: ['Basic abcdef', 'abcdef'],
  },
  {
    input: 'cookie=sid=abc; other=def',
    forbidden: ['sid=abc', 'other=def'],
  },
  {
    input: '{"cookie":"sid=abc; other=def"}',
    forbidden: ['sid=abc', 'other=def'],
  },
  {
    input: '{"authorization":"Basic abcdef"}',
    forbidden: ['Basic abcdef'],
  },
  {
    input: '{"registryKey":"plain-nonpattern"}',
    forbidden: ['plain-nonpattern'],
  },
  {
    input: "{ registryKey: 'plain-nonpattern' }",
    forbidden: ['plain-nonpattern'],
  },
  {
    input: 'Idempotency-Key: abcdefghijklmnop',
    forbidden: ['abcdefghijklmnop'],
  },
];

try {
  if (!redactionOnly) {
    checkCompose({
      composePath: localComposePath,
      envPath: path.join(repoRoot, 'deploy/m2-local/.env.example'),
      services: ['caddy', 'authelia', 'dsh-hub-service'],
      forbiddenServices: [],
    });
    checkCompose({
      composePath: existingCaddyComposePath,
      envPath: path.join(repoRoot, 'deploy/m2-existing-caddy/.env.example'),
      services: ['authelia', 'dsh-hub-service'],
      forbiddenServices: ['caddy'],
    });
  }
  checkDocs();
  checkCliErrorRedaction();
  checkRuntimeRedaction();
  console.log(JSON.stringify({
    ok: true,
    mode: redactionOnly ? 'redaction-only' : 'full',
    compose: redactionOnly ? 'skipped' : {
      driver: requiredLogDriver,
      maxSize: requiredMaxSize,
      maxFile: requiredMaxFile,
      profiles: [
        path.relative(repoRoot, localComposePath),
        path.relative(repoRoot, existingCaddyComposePath),
      ],
    },
    redactionSamples: secretSamples.length + redactionFixtures.length,
  }, null, 2));
} catch (err) {
  console.error('M3 logging check failed:', err?.stack || err);
  process.exit(1);
}

function checkCompose({ composePath, envPath, services, forbiddenServices }) {
  const text = fs.readFileSync(composePath, 'utf8');
  assert.match(text, /x-dsh-hub-log-retention:\s*&dsh-hub-log-retention/, `${composePath} missing logging anchor`);
  const model = renderCompose(composePath, envPath);
  const renderedServices = model.services ?? {};

  for (const service of services) {
    const block = serviceBlock(text, service);
    assert.ok(block.includes('logging: *dsh-hub-log-retention'), `${composePath} service ${service} missing shared logging retention`);
    const rendered = renderedServices[service];
    assert.ok(rendered, `${composePath} rendered config missing service ${service}`);
    assert.equal(rendered.logging?.driver, requiredLogDriver, `${composePath} ${service} logging driver`);
    assert.equal(rendered.logging?.options?.['max-size'], requiredMaxSize, `${composePath} ${service} logging max-size`);
    assert.equal(String(rendered.logging?.options?.['max-file']), String(requiredMaxFile), `${composePath} ${service} logging max-file`);
  }
  for (const service of forbiddenServices) {
    assert.equal(renderedServices[service], undefined, `${composePath} must not render service ${service}`);
  }
}

function renderCompose(composePath, envPath) {
  const result = spawnSync('docker', [
    'compose',
    '--env-file',
    envPath,
    '-f',
    composePath,
    'config',
    '--format',
    'json',
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`docker compose config failed for ${path.relative(repoRoot, composePath)}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

function serviceBlock(text, service) {
  const match = text.match(new RegExp(`\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\nsecrets:\\n|\\nvolumes:\\n|\\nnetworks:\\n|$)`));
  if (!match) throw new Error(`missing service block: ${service}`);
  return match[1];
}

function checkDocs() {
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const requiredRunbookPhrases = [
    '## 1. Scope and boundaries',
    '## 2. Retention policy',
    '## 3. Evidence collection',
    '## 4. Redaction rules',
    '## 5. Acceptance evidence',
    'json-file',
    '10m × 7',
    'existing-Caddy',
    'does not take over system Caddy',
    'Do not paste registry keys, replacement grants, instance tokens, Authorization',
  ];
  for (const phrase of requiredRunbookPhrases) {
    assert.ok(runbook.includes(phrase), `runbook missing phrase: ${phrase}`);
  }
  for (const phrase of ['npm run deploy:m3:logging:check', 'does not connect to the production server', 'json-file', '10m × 7']) {
    assert.ok(readme.includes(phrase), `README missing phrase: ${phrase}`);
  }
  for (const secret of secretSamples) {
    assert.equal(runbook.includes(secret), false, `runbook contains raw sample secret ${secret}`);
    assert.equal(readme.includes(secret), false, `README contains raw sample secret ${secret}`);
  }
}

function checkCliErrorRedaction() {
  const clientIndex = fs.readFileSync(clientIndexPath, 'utf8');
  assert.match(clientIndex, /import \{[^}]*redactLogText[^}]*\} from '\.\/util\.js';/, 'client CLI must import redactLogText');
  assert.match(clientIndex, /console\.error\(`error: \$\{redactLogText\(err\.message\)\}`\)/, 'client CLI top-level error output must redact err.message');
}

function checkRuntimeRedaction() {
  for (const redact of [redactServiceLogText, redactClientLogText]) {
    for (const secret of secretSamples) {
      assert.equal(redact(`secret=${secret}`).includes(secret), false);
    }
    assert.equal(redact(`Authorization: Bearer ${secretSamples[2]}`).includes(secretSamples[2]), false);
    assert.equal(redact(`Cookie: session=${secretSamples[0]}`).includes(secretSamples[0]), false);
    for (const fixture of redactionFixtures) {
      const rendered = redact(fixture.input);
      assert.match(rendered, /\[redacted-secret\]/, `redacted output missing marker for ${fixture.input}`);
      for (const forbidden of fixture.forbidden) {
        assert.equal(rendered.includes(forbidden), false, `redacted output contains raw value ${forbidden}: ${rendered}`);
      }
    }
  }

  const captured = [];
  const originalLog = console.log;
  try {
    console.log = (...args) => captured.push(args.join(' '));
    serviceLog('service Authorization: Bearer ' + secretSamples[2], { instanceToken: secretSamples[2] });
    clientLog(new Error('client failed with ' + secretSamples[0] + ' Cookie: sid=' + secretSamples[1]));
    serviceLog('headers', {
      authorization: 'Basic abcdef',
      cookie: 'sid=abc; other=def',
      registryKey: 'plain-nonpattern',
      idempotencyKey: 'abcdefghijklmnop',
    });
  } finally {
    console.log = originalLog;
  }
  const rendered = captured.join('\n');
  assert.match(rendered, /\[redacted-secret\]/);
  for (const secret of secretSamples) {
    assert.equal(rendered.includes(secret), false, `captured log contains raw secret ${secret}`);
  }
  for (const secret of ['Basic abcdef', 'sid=abc', 'other=def', 'plain-nonpattern', 'abcdefghijklmnop']) {
    assert.equal(rendered.includes(secret), false, `captured log contains raw sensitive value ${secret}`);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
