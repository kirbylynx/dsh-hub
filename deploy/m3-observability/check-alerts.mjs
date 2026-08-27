#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const alertsPath = path.join(repoRoot, 'deploy/m3-observability/alerts.dsh-hub.yml');
const serverPath = path.join(repoRoot, 'packages/dsh-hub-service/src/server.js');

const alerts = fs.readFileSync(alertsPath, 'utf8');
const server = fs.readFileSync(serverPath, 'utf8');

const serviceMetrics = new Set([...server.matchAll(/['"`](dsh_hub_[a-zA-Z0-9_:]+)['"`]/g)].map((match) => match[1]));
const referencedMetrics = new Set([...alerts.matchAll(/\b(dsh_hub_[a-zA-Z0-9_:]+)\b/g)].map((match) => match[1]));
const unknownMetrics = [...referencedMetrics].filter((metric) => !serviceMetrics.has(metric));
if (unknownMetrics.length > 0) {
  fail(`alert rules reference metrics not emitted by service.js: ${unknownMetrics.join(', ')}`);
}

const forbiddenLabelPatterns = [
  /\bnamespace\s*=/i,
  /\binstance\s*=/i,
  /\binstance_id\s*=/i,
  /\binstanceId\s*=/,
  /\btoken\s*=/i,
  /\bregistry\s*=/i,
  /\bauthorization\s*=/i,
  /\bworkspace\s*=/i,
  /\bpath\s*=/i,
  /\bhost\s*=/i,
  /\buser\s*=/i,
  /\btarget\s*=/i,
];
for (const pattern of forbiddenLabelPatterns) {
  if (pattern.test(alerts)) fail(`alert rules contain forbidden label pattern: ${pattern}`);
}

const alertNames = [...alerts.matchAll(/^\s*-\s*alert:\s*([A-Za-z][A-Za-z0-9_]*)\s*$/gm)].map((match) => match[1]);
if (alertNames.length === 0) fail('no alert rules found');
if (new Set(alertNames).size !== alertNames.length) fail('duplicate alert names found');

const runbookLinks = [...alerts.matchAll(/^\s*runbook_url:\s*(\S+)\s*$/gm)].map((match) => match[1]);
if (runbookLinks.length !== alertNames.length) {
  fail(`expected one runbook_url per alert; alerts=${alertNames.length} runbook_url=${runbookLinks.length}`);
}

for (const link of runbookLinks) {
  if (!link.startsWith('docs/ops/m3-runbook.md#')) fail(`runbook_url must point to docs/ops/m3-runbook.md: ${link}`);
}

const runbook = fs.readFileSync(path.join(repoRoot, 'docs/ops/m3-runbook.md'), 'utf8');
for (const alertName of alertNames) {
  const heading = new RegExp(`^###\\s+${escapeRegExp(alertName)}\\s*$`, 'm');
  if (!heading.test(runbook)) fail(`runbook is missing heading for ${alertName}`);
}

console.log(JSON.stringify({
  ok: true,
  alerts: alertNames.length,
  referencedMetrics: [...referencedMetrics].sort(),
}, null, 2));

function fail(message) {
  console.error(`M3 alert check failed: ${message}`);
  process.exit(1);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
