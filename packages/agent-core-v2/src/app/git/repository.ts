import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { directoryKey } from '#/_base/utils/paths';
import { resolveProgramPath } from '#/environment/programPath';
import { Error2, ErrorCodes } from '#/errors';

export interface RepositoryStore {
  readonly type: 'git';
  readonly store: string;
}

export interface DiscoveredRepository {
  readonly vcs: RepositoryStore;
  readonly checkoutRoot: string | null;
  readonly defaultDirectory: { kind: 'checkout' | 'bare'; cwd: string } | { kind: 'unknown' };
}

interface RepositoryPaths {
  readonly control: string;
  readonly store: string;
  readonly checkoutRoot: string | null;
}

type RunGit = (cwd: string, ...args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

function samePath(left: string, right: string): boolean {
  return directoryKey(left) === directoryKey(right);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
}

async function hasMarker(path: string, kind?: 'file' | 'directory'): Promise<boolean> {
  try {
    if (kind === undefined) {
      await lstat(path);
      return true;
    }
    const entry = await stat(path);
    return kind === 'file' ? entry.isFile() : entry.isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function findMarker(cwd: string) {
  for (let root = cwd; ; root = dirname(root)) {
    if (await hasMarker(join(root, '.git'))) return { root, checkout: true };
    if (
      await hasMarker(join(root, 'HEAD'), 'file') &&
      (await hasMarker(join(root, 'objects'), 'directory') || await hasMarker(join(root, 'refs'), 'directory'))
    ) {
      return { root, checkout: false };
    }
    if (root === dirname(root)) return undefined;
  }
}

function localGit(cwd: string): RunGit {
  const program = resolveProgramPath('git', { cwd });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return async (dir, ...args) => {
    const { stdout } = await execFileAsync(program, args, {
      cwd: dir, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return stdout.replace(/\r?\n$/, '');
  };
}

async function gitPath(git: RunGit, cwd: string, option: string): Promise<string> {
  const path = await git(cwd, 'rev-parse', '--path-format=absolute', option);
  if (!isAbsolute(path)) throw new Error(`Git returned a relative path for ${option}: ${path}`);
  return realpath(path);
}

async function defaultDirectory(
  git: RunGit,
  { control, store, checkoutRoot }: RepositoryPaths,
): Promise<DiscoveredRepository['defaultDirectory']> {
  const listing = await git(store, '--git-dir', store, 'worktree', 'list', '--porcelain', '-z');
  const [first, ...fields] = (listing.split('\0\0', 1)[0] ?? '').split('\0');
  if (!first?.startsWith('worktree ')) throw new Error('Git did not list its main worktree');
  const listed = await realpath(first.slice('worktree '.length));
  const inMain = checkoutRoot !== null && samePath(control, store);
  if (fields.includes('bare')) {
    if (!samePath(listed, store) || inMain) throw new Error('Git bare repository registration is inconsistent');
    return { kind: 'bare', cwd: store };
  }
  if (inMain) {
    if (!samePath(listed, store) && !samePath(listed, checkoutRoot)) {
      throw new Error(`Git registers a different main checkout at ${listed}`);
    }
    return { kind: 'checkout', cwd: checkoutRoot };
  }
  let main = listed;
  if (samePath(listed, store)) {
    try {
      const configured = await git(store, 'config', '--local', '--path', '--get', 'core.worktree');
      main = await realpath(resolve(store, configured));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 1) return { kind: 'unknown' };
      throw error;
    }
  }
  const [mainControl, mainRoot] = await Promise.all([
    gitPath(git, main, '--absolute-git-dir'),
    gitPath(git, main, '--show-toplevel'),
  ]);
  if (!samePath(mainControl, store) || !samePath(mainRoot, main)) {
    throw new Error(`Git main checkout at ${main} does not belong to ${store}`);
  }
  return { kind: 'checkout', cwd: main };
}

export async function discoverRepository(cwd: string): Promise<DiscoveredRepository | null> {
  if (!isAbsolute(cwd)) return null;
  let location: string;
  try {
    location = await realpath(cwd);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const marker = await findMarker(location);
    if (marker === undefined) return null;
    const git = localGit(marker.root);
    const [control, store, checkoutRoot] = await Promise.all([
      gitPath(git, location, '--absolute-git-dir'),
      gitPath(git, location, '--git-common-dir'),
      marker.checkout ? gitPath(git, location, '--show-toplevel') : null,
    ]);
    if (!samePath(checkoutRoot ?? control, marker.root)) {
      throw new Error(`Git does not recognize the repository marker at ${marker.root}`);
    }
    if (!samePath(control, store) && checkoutRoot !== null) {
      const backPointer = (await readFile(join(control, 'gitdir'), 'utf8')).replace(/\r?\n$/, '');
      if (!samePath(dirname(control), join(store, 'worktrees')) ||
        !samePath(await realpath(resolve(control, backPointer)), join(checkoutRoot, '.git'))) {
        throw new Error(`Git worktree registration does not point back to ${checkoutRoot}`);
      }
    }
    return {
      vcs: { type: 'git', store },
      checkoutRoot,
      defaultDirectory: await defaultDirectory(git, { control, store, checkoutRoot }),
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `Cannot identify the Git repository at ${cwd}: ${detail}`, { cause });
  }
}
