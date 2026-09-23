import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'commit.gpgSign=false',
  '-c',
  'log.showSignature=false',
  '-c',
  'merge.verifySignatures=false',
  '-c',
  'core.editor=',
  '-c',
  'gpg.program=',
  '-c',
  'submodule.recurse=false',
];

export const GIT_DIFF_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

export const INCLUDE_SECTION_RE = /^\s*\[\s*include(?:\.|\s|\]|if)/im;

export function parseGitDirPointer(content: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;
  const rawPath = line.slice('gitdir:'.length).trim();
  return rawPath.length > 0 ? rawPath : undefined;
}

export function resolveConfigPaths(gitDir: string, commondirContent: string | undefined): string[] {
  const configPaths = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
  const commonDir = commondirContent?.trim();
  if (commonDir !== undefined && commonDir.length > 0) {
    configPaths.push(join(resolve(gitDir, commonDir), 'config'));
  }
  return configPaths;
}

export function buildDriverOverrides(outputs: readonly string[]): readonly string[] | null {
  const filterDrivers = new Set<string>();
  const mergeDrivers = new Set<string>();
  for (const output of outputs) {
    for (const line of output.split('\n')) {
      const filter = /^filter\.(.+)\.(?:clean|process|smudge)$/.exec(line);
      const filterDriver = filter?.[1];
      if (filterDriver !== undefined) {
        if (filterDriver.includes('=')) return null;
        filterDrivers.add(filterDriver);
      }
      const merge = /^merge\.(.+)\.driver$/.exec(line);
      const mergeDriver = merge?.[1];
      if (mergeDriver !== undefined) {
        if (mergeDriver.includes('=')) return null;
        mergeDrivers.add(mergeDriver);
      }
    }
  }
  const args: string[] = [];
  for (const driver of filterDrivers) {
    args.push(
      '-c',
      `filter.${driver}.clean=`,
      '-c',
      `filter.${driver}.process=`,
      '-c',
      `filter.${driver}.smudge=`,
    );
  }
  for (const driver of mergeDrivers) {
    args.push('-c', `merge.${driver}.driver=`);
  }
  return args;
}

export function isCoreWorktreeSafe(
  raw: string,
  resolvedGitDir: string,
  workTreeRoot: string,
): boolean {
  const configured = isAbsolute(raw) ? normalize(raw) : resolve(resolvedGitDir, raw);
  if (process.platform === 'win32') {
    return normalize(configured).toLowerCase() === normalize(workTreeRoot).toLowerCase();
  }
  return normalize(configured) === normalize(workTreeRoot);
}

export interface GitProbeResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type GitProbe = (args: readonly string[]) => Promise<GitProbeResult>;

interface FilterArgsCacheEntry {
  readonly stamp: string | null;
  readonly args: readonly string[];
}

const filterArgsCache = new Map<string, FilterArgsCacheEntry>();

export async function hardenedGitConfigArgs(
  cwd: string,
  probe: GitProbe,
): Promise<readonly string[] | null> {
  const gitDir = await findGitDir(cwd);
  const stamp = await gitConfigStamp(cwd, gitDir);
  const cached = filterArgsCache.get(cwd);
  if (stamp !== null && cached?.stamp === stamp) return cached.args;
  if (!(await coreWorktreeSafe(cwd, probe, gitDir))) return null;
  const filterArgs = await probeFilterArgs(cwd, probe);
  if (filterArgs === null) return null;
  const args = [...GIT_CONFIG_ARGS, ...filterArgs];
  filterArgsCache.set(cwd, { stamp, args });
  return args;
}

async function coreWorktreeSafe(
  cwd: string,
  probe: GitProbe,
  gitDir: string | null,
): Promise<boolean> {
  if (gitDir === null) return true;
  let resolvedGitDir: string;
  try {
    const realGitPath = await realpath(gitDir);
    if ((await stat(realGitPath)).isDirectory()) {
      resolvedGitDir = realGitPath;
    } else {
      const pointer = parseGitDirPointer(await readFile(realGitPath, 'utf8'));
      if (pointer === undefined) return true;
      resolvedGitDir = resolve(dirname(realGitPath), pointer);
    }
  } catch {
    return false;
  }
  const workTreeRoot = dirname(gitDir);
  const results = await Promise.all(
    ['--local', '--worktree'].map((scope) =>
      probe([
        ...GIT_CONFIG_ARGS,
        '-C',
        cwd,
        'config',
        scope,
        '--includes',
        '--get',
        'core.worktree',
      ]).catch(() => null),
    ),
  );
  for (const result of results) {
    if (result === null || result.exitCode < 0) return false;
    if (result.exitCode !== 0) continue;
    const raw = result.stdout.trim();
    if (raw === '' || isCoreWorktreeSafe(raw, resolvedGitDir, workTreeRoot)) continue;
    return false;
  }
  return true;
}

async function probeFilterArgs(cwd: string, probe: GitProbe): Promise<readonly string[] | null> {
  const results = await Promise.all(
    ['--local', '--worktree'].map((scope) =>
      probe([
        ...GIT_CONFIG_ARGS,
        '-C',
        cwd,
        'config',
        scope,
        '--includes',
        '--get-regexp',
        '--name-only',
        '^(filter|merge)\\.',
      ]).catch(() => null),
    ),
  );
  const outputs: string[] = [];
  for (const result of results) {
    if (result === null || result.exitCode < 0) return null;
    if (result.exitCode !== 0) continue;
    outputs.push(result.stdout);
  }
  return buildDriverOverrides(outputs);
}

async function gitConfigStamp(cwd: string, found: string | null): Promise<string | null> {
  try {
    if (found === null) return null;
    let gitDir = found;
    if (!(await stat(gitDir)).isDirectory()) {
      const pointer = parseGitDirPointer(await readFile(gitDir, 'utf8'));
      if (pointer === undefined) return null;
      gitDir = resolve(dirname(found), pointer);
    }
    const commondir = await readFile(join(gitDir, 'commondir'), 'utf8').catch(() => undefined);
    const configPaths = resolveConfigPaths(gitDir, commondir);
    const stamps = await Promise.all(configPaths.map(stampConfigPath));
    for (const path of configPaths) {
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content !== null && INCLUDE_SECTION_RE.test(content)) return null;
    }
    return stamps.join('|');
  } catch {
    return null;
  }
}

async function findGitDir(start: string): Promise<string | null> {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.git');
    try {
      await stat(candidate);
      return candidate;
    } catch {
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function stampConfigPath(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${path}:${String(stats.mtimeMs)}:${String(stats.size)}`;
  } catch {
    return `${path}:missing`;
  }
}
