import { execFile } from 'node:child_process';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { directoryKey } from '#/_base/utils/paths';
import { resolveProgramPath } from '#/environment/programPath';
import { Error2, ErrorCodes } from '#/errors';
import { toHostFsError } from '#/os/interface/hostFsErrors';

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

type GitPathOption = '--git-dir' | '--git-common-dir' | '--show-toplevel';
type RepositoryConfigKey = 'extensions.worktreeConfig' | 'core.worktree';
type DiscoveryArgument = GitPathOption | RepositoryConfigKey | 'rev-parse' | '--git-dir=.' | '--is-bare-repository'
  | 'config' | 'config.worktree' | '--file' | '--includes' | '--bool' | '--path' | '--get';
type RunGit = (cwd: string, ...args: DiscoveryArgument[]) => Promise<string>;

const execFileAsync = promisify(execFile);

const repositoryOverrides = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_DIR', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_WORK_TREE',
]);

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
    throw toHostFsError(error, { path, op: kind === undefined ? 'lstat' : 'stat' });
  }
}

function physicalCeilingKey(path: string): string {
  return path.split(sep).join('/').replace(/\/$/, '');
}

async function discoveryCeilings(): Promise<Set<string>> {
  const ceilings = new Set<string>();
  let canonicalize = true;
  for (const entry of (process.env['GIT_CEILING_DIRECTORIES'] ?? '').split(delimiter)) {
    if (entry === '') {
      canonicalize = false;
      continue;
    }
    if (!isAbsolute(entry)) continue;
    const key = canonicalize ? await realpath(entry).then(physicalCeilingKey, () => undefined) : entry.replace(/\/$/, '');
    if (key !== undefined) ceilings.add(key);
  }
  return ceilings;
}

async function findMarker(cwd: string) {
  const ceilings = await discoveryCeilings();
  const across = process.env['GIT_DISCOVERY_ACROSS_FILESYSTEM'] ?? '';
  const singleDevice = across === '' || /^(?:no|false|off)$/i.test(across) || /^\s*[+-]?(?:0+|0x0+)[kmg]?$/i.test(across);
  let device: number | undefined;
  for (let root = cwd; ; root = dirname(root)) {
    if (singleDevice) {
      let current: number;
      try {
        current = (await stat(root)).dev;
      } catch (error) {
        throw toHostFsError(error, { path: root, op: 'stat' });
      }
      if (device !== undefined && current !== device) return undefined;
      device = current;
    }
    if (await hasMarker(join(root, '.git'))) return { root, checkout: true };
    if (
      await hasMarker(join(root, 'HEAD'), 'file') &&
      (await hasMarker(join(root, 'objects'), 'directory') || await hasMarker(join(root, 'refs'), 'directory'))
    ) {
      return { root, checkout: false };
    }
    const parent = dirname(root);
    if (root === parent || ceilings.has(physicalCeilingKey(parent))) return undefined;
  }
}

function localGit(cwd: string): RunGit {
  const program = resolveProgramPath('git', { cwd });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !repositoryOverrides.has(key.toUpperCase())));
  const batch = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(program);
  const command = batch ? resolveProgramPath(join(process.env['SystemRoot'] ?? '', 'System32', 'cmd.exe'), { cwd }) : program;
  if (batch) {
    env['KIMI_CODE_GIT_SHIM'] = program;
    env['NoDefaultCurrentDirectoryInExePath'] = '1';
  }
  return async (dir, ...args) => {
    const argv = batch ? ['/d', '/v:off', '/s', '/c', `""%KIMI_CODE_GIT_SHIM%" ${args.join(' ')}"`] : args;
    const { stdout } = await execFileAsync(command, argv, {
      windowsVerbatimArguments: batch,
      cwd: dir, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    return stdout.replace(/\r?\n$/, '');
  };
}

async function gitPath(git: RunGit, cwd: string, option: GitPathOption): Promise<string> {
  const path = await git(cwd, 'rev-parse', option);
  if (path.length === 0) throw new Error(`Git returned an empty path for ${option}`);
  return realpath(resolve(cwd, path));
}

async function repositoryConfig(
  git: RunGit,
  store: string,
  file: 'config' | 'config.worktree',
  type: '--bool' | '--path',
  key: RepositoryConfigKey,
): Promise<string | undefined> {
  try {
    return await git(store, 'config', '--file', file, '--includes', type, '--get', key);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) return undefined;
    throw error;
  }
}

async function defaultDirectory(
  git: RunGit,
  { control, store, checkoutRoot }: RepositoryPaths,
): Promise<DiscoveredRepository['defaultDirectory']> {
  const inMain = checkoutRoot !== null && samePath(control, store);
  if ((await git(store, '--git-dir=.', 'rev-parse', '--is-bare-repository')) === 'true') {
    if (inMain) throw new Error('Git reports a checkout for a bare repository');
    return { kind: 'bare', cwd: store };
  }
  const parent = dirname(store);
  const conventional = samePath(store, join(parent, '.git'));
  if (inMain) {
    if (conventional && !samePath(parent, checkoutRoot)) {
      throw new Error(`Git registers a different main checkout at ${parent}`);
    }
    return { kind: 'checkout', cwd: checkoutRoot };
  }
  let main = parent;
  if (!conventional) {
    const perWorktree = await repositoryConfig(git, store, 'config', '--bool', 'extensions.worktreeConfig');
    const override = perWorktree === 'true'
      ? await repositoryConfig(git, store, 'config.worktree', '--path', 'core.worktree')
      : undefined;
    const configured = override ?? await repositoryConfig(git, store, 'config', '--path', 'core.worktree');
    if (configured === undefined) return { kind: 'unknown' };
    main = await realpath(resolve(store, configured));
  }
  const [mainControl, mainRoot] = await Promise.all([
    gitPath(git, main, '--git-dir'),
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
    throw toHostFsError(error, { path: cwd, op: 'realpath' });
  }
  const marker = await findMarker(location);
  if (marker === undefined) return null;
  try {
    const git = localGit(marker.root);
    const [control, store, checkoutRoot] = await Promise.all([
      gitPath(git, location, '--git-dir'),
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
