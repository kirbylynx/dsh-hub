import { mkdir, opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';
import z from '@deepseek-ai/schemastery';

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asError(reason) {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isInsideOrSame(root, target) {
  const diff = relative(root, target);
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff));
}

function assertAbsolutePath(path, code, action) {
  if (!isAbsolute(path)) {
    throw new DirectoryPickerError(code, path, `cannot ${action} "${path}": not an absolute path`);
  }
}

function assertInsideRoot({ root, target, code, action }) {
  if (!isInsideOrSame(root, target)) {
    throw new DirectoryPickerError(code, target, `cannot ${action} ${target}: outside hosted workspace root ${root}`);
  }
}

async function raceAbort(operation, signal) {
  if (signal === undefined) return operation;
  return await new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      operation.catch(() => {});
      reject(asError(signal.reason));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise(value);
    }, (reason) => {
      signal.removeEventListener('abort', onAbort);
      reject(asError(reason));
    });
  });
}

function swallowCloseFailure() {}

function workspaceCrumbs(root, target) {
  const crumbs = [];
  let current = target;
  for (;;) {
    crumbs.unshift({
      name: current === root ? root : basename(current),
      path: current,
      hidden: false,
    });
    if (current === root) return crumbs;
    current = dirname(current);
  }
}

function boundedInsert(window, candidate, keep) {
  if (window.length === keep && candidate.name.localeCompare(window[window.length - 1].name) >= 0) return true;
  let lo = 0;
  let hi = window.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (candidate.name.localeCompare(window[mid].name) < 0) hi = mid;
    else lo = mid + 1;
  }
  window.splice(lo, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

async function realWorkspaceRoot(root, signal) {
  const resolvedRoot = resolve(root);
  assertAbsolutePath(resolvedRoot, 'directory-unreadable', 'use hosted workspace root');
  try {
    const rootStat = await raceAbort(stat(resolvedRoot), signal);
    if (!rootStat.isDirectory()) {
      throw new DirectoryPickerError('directory-unreadable', resolvedRoot, `hosted workspace root is not a directory: ${resolvedRoot}`);
    }
    return await raceAbort(realpath(resolvedRoot), signal);
  } catch (error) {
    if (error instanceof DirectoryPickerError) throw error;
    throw new DirectoryPickerError('directory-unreadable', resolvedRoot, `cannot access hosted workspace root ${resolvedRoot}: ${messageOf(error)}`);
  }
}

async function safeTarget({ requestedPath, root, realRoot, code, action, signal }) {
  const target = resolve(requestedPath ?? root);
  assertAbsolutePath(target, code, action);
  assertInsideRoot({ root, target, code, action });
  try {
    const realTarget = await raceAbort(realpath(target), signal);
    assertInsideRoot({ root: realRoot, target: realTarget, code, action });
    return { target, realTarget };
  } catch (error) {
    if (error instanceof DirectoryPickerError) throw error;
    throw new DirectoryPickerError(code, target, `cannot ${action} ${target}: ${messageOf(error)}`);
  }
}

async function directoryRow({ parent, name, isDirectory: direntDirectory, isSymbolicLink, realRoot, signal }) {
  const path = join(parent, name);
  let enterable = direntDirectory;
  if (!enterable && isSymbolicLink) {
    try {
      enterable = (await raceAbort(stat(path), signal)).isDirectory();
    } catch {
      if (signal?.aborted) throw asError(signal.reason);
      return null;
    }
  }
  if (!enterable) return null;
  try {
    const realTarget = await raceAbort(realpath(path), signal);
    if (!isInsideOrSame(realRoot, realTarget)) return null;
  } catch {
    if (signal?.aborted) throw asError(signal.reason);
    return null;
  }
  return {
    name,
    path,
    hidden: name.startsWith('.'),
  };
}

export class RestrictedDirectoryPicker extends DirectoryPicker {
  static Config = z.object({
    root: z.string().default('/workspace'),
    maxEntries: z.natural().min(1).default(1000),
  });

  config;
  browseCapability;

  constructor(ctx, config = {}) {
    super(ctx);
    this.config = {
      root: cleanText(config.root) || '/workspace',
      maxEntries: Number.isInteger(config.maxEntries) && config.maxEntries > 0 ? config.maxEntries : 1000,
    };
    this.browseCapability = Object.freeze({
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    });
  }

  capability() {
    return this.browseCapability;
  }

  async list(path, signal) {
    const root = resolve(this.config.root);
    const realRoot = await realWorkspaceRoot(root, signal);
    const { target } = await safeTarget({
      requestedPath: path,
      root,
      realRoot,
      code: 'directory-unreadable',
      action: 'list',
      signal,
    });
    const keep = this.config.maxEntries + 1;
    const window = [];
    let evicted = false;
    try {
      const opening = opendir(target);
      const level = await raceAbort(opening, signal).catch((error) => {
        opening.then((dir) => dir.close().catch(swallowCloseFailure), () => {});
        throw error;
      });
      try {
        for (;;) {
          const dirent = await raceAbort(level.read(), signal);
          if (dirent === null) break;
          if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
          if (boundedInsert(window, {
            name: dirent.name,
            isDirectory: dirent.isDirectory(),
            isSymbolicLink: dirent.isSymbolicLink(),
          }, keep)) evicted = true;
        }
      } finally {
        const closing = level.close();
        if (signal?.aborted) closing.catch(swallowCloseFailure);
        else await closing;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DirectoryPickerError) throw error;
      throw new DirectoryPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`);
    }

    const entries = [];
    let truncated = evicted;
    for (const candidate of window) {
      signal?.throwIfAborted();
      const row = await directoryRow({
        parent: target,
        name: candidate.name,
        isDirectory: candidate.isDirectory,
        isSymbolicLink: candidate.isSymbolicLink,
        realRoot,
        signal,
      });
      if (row === null) continue;
      if (entries.length === this.config.maxEntries) {
        truncated = true;
        break;
      }
      entries.push(row);
    }

    return Object.freeze({
      path: target,
      home: root,
      crumbs: workspaceCrumbs(root, target),
      entries,
      truncated,
      root,
      restricted: true,
    });
  }

  async createDirectory(path, name) {
    const root = resolve(this.config.root);
    const realRoot = await realWorkspaceRoot(root);
    const parentPath = cleanText(path) || root;
    const { target: parent } = await safeTarget({
      requestedPath: parentPath,
      root,
      realRoot,
      code: 'directory-create-failed',
      action: 'create under',
    });
    const segment = cleanText(name);
    if (segment === '' || segment === '.' || segment === '..' || /[/\\]/.test(segment)) {
      throw new DirectoryPickerError('directory-create-failed', join(parent, segment), `"${name}" is not a single path segment`);
    }
    const target = resolve(parent, segment);
    assertInsideRoot({
      root,
      target,
      code: 'directory-create-failed',
      action: 'create',
    });
    try {
      await mkdir(target);
      const realTarget = await realpath(target);
      assertInsideRoot({
        root: realRoot,
        target: realTarget,
        code: 'directory-create-failed',
        action: 'create',
      });
      return target;
    } catch (error) {
      if (error instanceof DirectoryPickerError) throw error;
      if (typeof error === 'object' && error !== null && error.code === 'EEXIST') {
        throw new DirectoryPickerError('directory-exists', target, `${target} already exists`);
      }
      throw new DirectoryPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`);
    }
  }
}

export { boundedInsert, raceAbort };

export default RestrictedDirectoryPicker;
