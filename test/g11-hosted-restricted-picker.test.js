import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';
import { DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';

import RestrictedDirectoryPicker from '../packages/dsh-hub-plugin/src/restricted-directory-picker.js';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function rejectsWithCode(fn, code) {
  await assert.rejects(fn, (error) => {
    assert.equal(error instanceof DirectoryPickerError, true);
    assert.equal(error.code, code);
    return true;
  });
}

function createPicker(root, maxEntries = 1000) {
  return new RestrictedDirectoryPicker(new Context(), { root, maxEntries }).capability();
}

test('G11 restricted directory picker defaults to hosted workspace root and hides outside symlinks', async () => {
  const base = tempDir('dsh-hub-g11-picker-');
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
  fs.writeFileSync(path.join(root, 'file.txt'), 'not a directory');
  fs.symlinkSync(path.join(root, 'project'), path.join(root, 'link-in'), 'dir');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link-out'), 'dir');

  const picker = createPicker(root);
  const listing = await picker.list();

  assert.equal(listing.path, root);
  assert.equal(listing.home, root);
  assert.equal(listing.root, root);
  assert.equal(listing.restricted, true);
  assert.deepEqual(listing.crumbs, [{ name: root, path: root, hidden: false }]);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['link-in', 'project']);
});

test('G11 restricted directory picker allows only paths inside root', async () => {
  const base = tempDir('dsh-hub-g11-picker-');
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'project'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');

  const picker = createPicker(root);
  const project = await picker.list(path.join(root, 'project'));
  assert.equal(project.path, path.join(root, 'project'));
  assert.deepEqual(project.crumbs.map((crumb) => crumb.path), [root, path.join(root, 'project')]);

  await rejectsWithCode(() => picker.list(outside), 'directory-unreadable');
  await rejectsWithCode(() => picker.list(path.join(root, '..', 'outside')), 'directory-unreadable');
  await rejectsWithCode(() => picker.list(path.join(root, 'link-out')), 'directory-unreadable');
});

test('G11 restricted directory picker creates directories only inside root', async () => {
  const base = tempDir('dsh-hub-g11-picker-');
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'link-out'), 'dir');

  const picker = createPicker(root);
  const created = await picker.createDirectory(root, 'new-project');
  assert.equal(created, path.join(root, 'new-project'));
  assert.equal(fs.statSync(created).isDirectory(), true);

  await rejectsWithCode(() => picker.createDirectory(outside, 'x'), 'directory-create-failed');
  await rejectsWithCode(() => picker.createDirectory(path.join(root, 'link-out'), 'x'), 'directory-create-failed');
  await rejectsWithCode(() => picker.createDirectory(root, '../escape'), 'directory-create-failed');
});

test('G11 restricted directory picker keeps listing bounded and marks truncation', async () => {
  const root = path.join(tempDir('dsh-hub-g11-picker-'), 'workspace');
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['a', 'b', 'c']) fs.mkdirSync(path.join(root, name));

  const picker = createPicker(root, 2);
  const listing = await picker.list(root);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ['a', 'b']);
  assert.equal(listing.truncated, true);
});
