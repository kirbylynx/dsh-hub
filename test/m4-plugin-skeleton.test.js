import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const PLUGIN_ROOT = join(ROOT, 'packages/dsh-hub-plugin');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

test('M4B-M4D plugin package declares host bundle and browser settings card bundle', () => {
  const pkg = readJson(join(PLUGIN_ROOT, 'package.json'));
  assert.equal(pkg.name, 'dsh-hub-plugin');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.deepEqual(pkg.dsh?.client, {
    platform: 'web',
    inject: ['@deepseek-ai/dsh-client-ui-settings-plugins', '@deepseek-ai/dsh-client-ui-conversation'],
  });
  assert.ok(pkg.exports?.['.']);
  assert.equal(pkg.exports?.['./client'], './client.js');
  assert.ok(pkg.exports?.['./cordis.patch.yml']);
  assert.ok(pkg.exports?.['./remote-capabilities.patch.yml']);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/cordis']);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/dsh-settings']);
  assert.ok(pkg.peerDependencies?.['@deepseek-ai/schemastery']);
  assert.equal(pkg.devDependencies?.['@deepseek-ai/dsh-settings'], '0.1.0-rc.7');
});

test('M4B plugin patch is default-off and does not mount M4C adapters', () => {
  const patch = readText(join(PLUGIN_ROOT, 'cordis.patch.yml'));
  assert.match(patch, /id: dsh-hub-plugin/);
  assert.match(patch, /name: dsh-hub-plugin/);
  assert.match(patch, /inject: \[webServer\]/);
  assert.match(patch, /enabled: false/);
  assert.match(patch, /historyAutoLoad: true/);
  assert.doesNotMatch(patch, /directory-picker-browse/);
  assert.doesNotMatch(patch, /ui-directory-picker-browse/);
  assert.doesNotMatch(patch, /api-gateway/);
});

test('M4C-M4D-6 remote capabilities overlay is explicit and gates native desktop-only UI affordances', () => {
  const patch = readText(join(PLUGIN_ROOT, 'remote-capabilities.patch.yml'));
  assert.match(patch, /id: directory-picker\n  disabled: true/);
  assert.match(patch, /id: api-gateway\n  config:\n    nativeOpen: false/);
  assert.match(patch, /id: directory-picker-browse/);
  assert.match(patch, /@deepseek-ai\/dsh-host-directory-picker-browse/);
  assert.match(patch, /id: ui-directory-picker-browse/);
  assert.match(patch, /@deepseek-ai\/dsh-client-ui-directory-picker-browse/);
  assert.doesNotMatch(patch, /id: dsh-hub-plugin/);
  assert.doesNotMatch(patch, /name: dsh-hub-plugin/);
  assert.doesNotMatch(patch, /token|registry|credential/i);
});

test('M4D host entry registers settings, plugin runtime, and browser card state', () => {
  const source = readText(join(PLUGIN_ROOT, 'src/index.js'));
  assert.match(source, /extends Service/);
  assert.match(source, /static inject = \['webServer'\]/);
  assert.match(source, /super\(ctx, DSH_HUB_SERVICE_NAME\)/);
  assert.match(source, /settingsNamespace\('dsh-hub'\)/);
  assert.match(source, /installSettingsSection/);
  assert.match(source, /createPluginStatus/);
  assert.match(source, /PluginCredentialStore/);
  assert.match(source, /PluginRuntime/);
  assert.match(source, /tunnel: true/);
  assert.match(source, /tunnelAdapter: true/);
  assert.match(source, /createPluginTunnelAdapter/);
  assert.match(source, /pluginJoin: true/);
  assert.match(source, /pluginCredentialStore: true/);
  assert.match(source, /tokenLifecycle: true/);
  assert.match(source, /browserSettingsCard: true/);
  assert.match(source, /sessionWorkspaceDiagnostics: true/);
  assert.match(source, /sessionHistoryAutoLoad/);
  assert.match(source, /sessionHistoryDiagnostics/);
  assert.match(source, /createPluginStatusView/);
  assert.match(source, /diagnosePluginLocalDsh/);
  assert.match(source, /browserSurface/);
  assert.match(source, /status-card-available/);
  assert.match(source, /hostCapabilities/);
  assert.match(source, /overlay-available/);
  assert.match(source, /can-open-path-overlay-available/);
  assert.match(source, /openPathCanOpenPathOverlay: true/);
  assert.doesNotMatch(source, /new WebSocket/);
  assert.doesNotMatch(source, /registerInstance/);
});

test('M4D browser client bundle remains a settings.plugin.item registration without secret handling', () => {
  const source = readText(join(PLUGIN_ROOT, 'client.js'));
  assert.match(source, /window\.__ModuleLoader__\.load/);
  assert.match(source, /id: 'dsh-hub-plugin'/);
  assert.match(source, /SETTINGS_KEY = 'dsh-hub'/);
  assert.match(source, /STATUS_ENDPOINT = '\/plugins\/dsh-hub-plugin\/status\.json'/);
  assert.match(source, /settings\.plugin\.item/);
  assert.match(source, /conversation\.session\.header\.utilities/);
  assert.match(source, /dsh-hub-history-autoload/);
  assert.match(source, /loadOlder/);
  assert.match(source, /historyRetry/);
  assert.match(source, /只读状态与诊断卡片/);
  assert.match(source, /Session \/ workspace 映射/);
  assert.doesNotMatch(source, /new WebSocket/);
  assert.doesNotMatch(source, /fetch\(['"]?https?:/);
  assert.doesNotMatch(source, /Authorization|Bearer|X-Dsh-Hub-Proxy-Key/i);
  assert.doesNotMatch(source, /registryKey|instanceToken|replacementGrant|dhk_|dht_|dhr_/);
});
