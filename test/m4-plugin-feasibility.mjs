#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REQUIRED_ROWS = [
  'directory-picker',
  'plugin-inventory',
  'api-gateway',
  'webserver',
  'web-runtime',
  'connection',
  'ui-settings-plugin-inventory',
  'ui-settings-plugins',
];

const REQUIRED_PACKAGES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-host-directory-picker-auto',
  '@deepseek-ai/dsh-host-directory-picker-browse',
  '@deepseek-ai/dsh-host-directory-picker-native',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@deepseek-ai/dsh-settings',
];

function main() {
  const globalRoot = execText('npm', ['root', '-g']).trim();
  const dshRoot = join(globalRoot, '@deepseek-ai/dsh');
  assert.ok(existsSync(dshRoot), `global @deepseek-ai/dsh not found under ${globalRoot}`);

  const dshPkg = readPackage(join(dshRoot, 'package.json'));
  assert.equal(dshPkg.name, '@deepseek-ai/dsh');
  assert.equal(dshPkg.bin?.dsh, 'lib/bin.js');

  const dshVersion = execText('dsh', ['--version']).trim();
  assert.equal(dshVersion, dshPkg.version, 'dsh --version must match installed package.json');

  const packages = new Map();
  for (const name of REQUIRED_PACKAGES) {
    const pkgPath = join(dshRoot, 'node_modules', name, 'package.json');
    assert.ok(existsSync(pkgPath), `${name} package.json exists in installed DSH`);
    packages.set(name, readPackage(pkgPath));
  }

  assertBundle(packages.get('@deepseek-ai/dsh-base'), '@deepseek-ai/dsh-base');
  assertBundle(packages.get('@deepseek-ai/dsh-web-app'), '@deepseek-ai/dsh-web-app');
  assertClientPackage(packages.get('@deepseek-ai/dsh-client-ui-directory-picker-browse'), {
    name: '@deepseek-ai/dsh-client-ui-directory-picker-browse',
    requires: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-workspace',
      '@deepseek-ai/dsh-client-locale',
    ],
  });
  assertClientPackage(packages.get('@deepseek-ai/dsh-client-ui-settings-plugins'), {
    name: '@deepseek-ai/dsh-client-ui-settings-plugins',
    requires: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ],
  });
  assertClientPackage(packages.get('@deepseek-ai/dsh-client-ui-settings-plugin-inventory'), {
    name: '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
    requires: [
      '@deepseek-ai/dsh-api-remotes',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-locale',
    ],
  });

  const autoPickerSource = readInstalled(dshRoot, '@deepseek-ai/dsh-host-directory-picker-auto/lib/index.js');
  assertIncludes(autoPickerSource, '"@deepseek-ai/dsh-host-directory-picker-browse"', 'auto picker knows browse backend');
  assertIncludes(autoPickerSource, '"@deepseek-ai/dsh-client-ui-directory-picker-browse"', 'auto picker knows browse client surface');
  assertIncludes(autoPickerSource, 'ctx.webServer.host', 'auto picker samples ctx.webServer.host');

  const browsePickerSource = readInstalled(dshRoot, '@deepseek-ai/dsh-host-directory-picker-browse/lib/index.js');
  assertIncludes(browsePickerSource, 'extends DirectoryPicker', 'browse picker is a Cordis service plugin');
  assertIncludes(browsePickerSource, 'BrowseDirectoryPicker as default', 'browse picker exports a default plugin entry');
  assertIncludes(browsePickerSource, 'kind: "browse"', 'browse picker exposes browse capability');

  const webserverSource = readInstalled(dshRoot, '@deepseek-ai/dsh-host-webserver/lib/index.js');
  assertIncludes(webserverSource, 'extends Service', 'webserver is a Cordis service plugin');
  assertIncludes(webserverSource, 'super(ctx, "webServer")', 'webserver provides ctx.webServer');
  assertIncludes(webserverSource, 'get port()', 'webserver exposes listening port getter');
  assertIncludes(webserverSource, 'get host()', 'webserver exposes configured host getter');
  assertIncludes(webserverSource, 'registerUpgrade', 'webserver exposes upgrade route registration');
  assertIncludes(webserverSource, 'WebServer as default', 'webserver exports a default plugin entry');

  const apiHandlerSource = readInstalled(dshRoot, '@deepseek-ai/dsh-host-apiproxy/lib/types/fetch/handler.js');
  for (const method of [
    'host.pickDirectory',
    'host.listDirectory',
    'host.createDirectory',
    'host.openPath',
    'session.list',
    'workspace.list',
  ]) {
    assertIncludes(apiHandlerSource, `'${method}'`, `api proxy supports ${method}`);
  }

  const settingsTypes = readInstalled(dshRoot, '@deepseek-ai/dsh-settings/lib/types/index.d.ts');
  assertIncludes(settingsTypes, 'register<T>', 'settings service exposes register<T>');
  assertIncludes(settingsTypes, 'SettingsNamespace', 'settings namespace type exists');

  const apiProxyTypes = readInstalled(dshRoot, '@deepseek-ai/dsh-host-apiproxy/lib/types/api-proxy.d.ts');
  assertIncludes(apiProxyTypes, 'openPath?:', 'api proxy has injectable openPath default');
  assertIncludes(apiProxyTypes, 'canOpenPath?:', 'api proxy has injectable canOpenPath default');

  const { dump, profilePackage, browseOverlayDump, ineffectiveNameOverlayDump } = dumpWebProfileConfig();
  assert.deepEqual(profilePackage.dsh?.profile?.bundles, [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ]);
  for (const row of REQUIRED_ROWS) {
    assert.match(dump, new RegExp(`id: ${escapeRegex(row)}\\n\\s+name:`), `web profile contains row ${row}`);
  }
  assertIncludes(dump, "name: '@deepseek-ai/dsh-host-directory-picker-auto'", 'default web profile uses adaptive directory picker');
  assertIncludes(dump, "name: '@deepseek-ai/dsh-host-webserver'", 'default web profile includes host webserver');
  assertIncludes(dump, 'host: !!js ctx.webStartup.host', 'webserver host is derived from webStartup');
  assertIncludes(dump, 'port: !!js ctx.webStartup.port ?? 3080', 'webserver port defaults to 3080');
  assertIncludes(ineffectiveNameOverlayDump, "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'", 'same-id name overlay keeps adaptive directory picker in rc.7');
  assertNotIncludes(ineffectiveNameOverlayDump, 'id: ui-directory-picker-browse', 'same-id name overlay does not mount browse client surface');
  assertIncludes(browseOverlayDump, "id: directory-picker\n  name: '@deepseek-ai/dsh-host-directory-picker-auto'\n  disabled: true", 'overlay can disable adaptive directory picker');
  assertIncludes(browseOverlayDump, "id: directory-picker-browse\n  name: '@deepseek-ai/dsh-host-directory-picker-browse'", 'overlay can mount browse directory picker backend');
  assertIncludes(browseOverlayDump, "id: ui-directory-picker-browse\n  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'", 'overlay can mount browse directory picker client surface');

  const latest = maybeReadLatestDshVersion();
  const summary = {
    ok: true,
    installedDsh: dshPkg.version,
    dshVersion,
    npmLatest: latest.version,
    npmLatestCheck: latest.checked ? 'checked with npm view' : 'skipped by default; set DSH_HUB_CHECK_NPM_LATEST=1 to query npm registry',
    checkedRows: REQUIRED_ROWS,
    checkedPackages: REQUIRED_PACKAGES,
    hostPluginShape: 'verified representative host packages export Cordis service plugin entries',
    ineffectiveNameOverlay: 'verified same-id name patch does not replace auto directory picker or mount browse client surface in rc.7',
    directoryPickerOverlay: 'verified with temporary DSH_HOME + --patch: disable auto row, insert browse backend row and browse client row',
    openPathBoundary: 'M4A proved injectable openPath/canOpenPath defaults; M4D-6 later proved the web profile can disable nativeOpen through api-gateway config but cannot replace it with a remote opener via ordinary profile patch',
    conclusion: 'M4A plugin seams are present for a standard DSH bundle/client plugin feasibility baseline; M4B/M4C must still validate runtime behavior.',
  };
  console.log(JSON.stringify(summary, null, 2));
}

function assertBundle(pkg, name) {
  assert.equal(pkg.name, name);
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', `${name} declares dsh.bundle.patch`);
  assert.ok(pkg.exports?.['./cordis.patch.yml'], `${name} exports cordis.patch.yml`);
}

function assertClientPackage(pkg, { name, requires }) {
  assert.equal(pkg.name, name);
  assert.equal(pkg.dsh?.client?.platform, 'web', `${name} declares web client platform`);
  assert.ok(pkg.exports?.['./client'], `${name} exports ./client`);
  for (const dependency of requires) {
    assert.ok(pkg.dsh.client.inject.includes(dependency), `${name} injects ${dependency}`);
  }
}

function dumpWebProfileConfig() {
  const tempHome = mkdtempSync(join(tmpdir(), 'dsh-hub-m4a-'));
  try {
    const dump = execText('dsh', ['--profile', 'web', '--dump-config'], {
      env: { ...process.env, DSH_HOME: tempHome },
    });
    const profilePackage = readPackage(join(tempHome, 'profiles/web/package.json'));
    const overlayDir = join(tempHome, 'overlays');
    mkdirSync(overlayDir, { recursive: true });
    const ineffectiveNameOverlayPath = join(overlayDir, 'ineffective-name-replacement.yml');
    writeFileSync(
      ineffectiveNameOverlayPath,
      [
        '- id: directory-picker',
        "  name: '@deepseek-ai/dsh-host-directory-picker-browse'",
        '',
      ].join('\n'),
    );
    const ineffectiveNameOverlayDump = execText(
      'dsh',
      ['--profile', 'web', '--patch', ineffectiveNameOverlayPath, '--dump-config'],
      {
        env: { ...process.env, DSH_HOME: tempHome },
      },
    );
    const overlayPath = join(overlayDir, 'browse-picker.yml');
    writeFileSync(
      overlayPath,
      [
        '- id: directory-picker',
        '  disabled: true',
        '- insert:',
        '    - id: directory-picker-browse',
        "      name: '@deepseek-ai/dsh-host-directory-picker-browse'",
        '    - id: ui-directory-picker-browse',
        "      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
        '',
      ].join('\n'),
    );
    const browseOverlayDump = execText('dsh', ['--profile', 'web', '--patch', overlayPath, '--dump-config'], {
      env: { ...process.env, DSH_HOME: tempHome },
    });
    return { dump, profilePackage, browseOverlayDump, ineffectiveNameOverlayDump };
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
}

function maybeReadLatestDshVersion() {
  if (process.env.DSH_HUB_CHECK_NPM_LATEST !== '1') return { checked: false, version: null };
  try {
    return { checked: true, version: execText('npm', ['view', '@deepseek-ai/dsh', 'version']).trim() };
  } catch {
    return { checked: true, version: null };
  }
}

function readPackage(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readInstalled(dshRoot, specifier) {
  return readFileSync(resolve(dshRoot, 'node_modules', specifier), 'utf8');
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assertIncludes(text, needle, message) {
  assert.ok(text.includes(needle), `${message}: missing ${needle}`);
}

function assertNotIncludes(text, needle, message) {
  assert.ok(!text.includes(needle), `${message}: unexpected ${needle}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
