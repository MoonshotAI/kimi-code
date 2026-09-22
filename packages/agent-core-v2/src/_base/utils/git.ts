import { readFile, stat } from 'node:fs/promises';
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
];

export const GIT_DIFF_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

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
  let resolvedGitDir = gitDir;
  if (!(await stat(gitDir)).isDirectory()) {
    const pointer = parseGitDirPointer(await readFile(gitDir, 'utf8'));
    if (pointer === undefined) return true;
    resolvedGitDir = resolve(cwd, pointer);
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
    if (raw === '') continue;
    const configured = isAbsolute(raw) ? normalize(raw) : resolve(resolvedGitDir, raw);
    if (normalize(configured) !== normalize(workTreeRoot)) return false;
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
  const filterDrivers = new Set<string>();
  const mergeDrivers = new Set<string>();
  for (const result of results) {
    if (result === null || result.exitCode < 0) return null;
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.split('\n')) {
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

async function gitConfigStamp(cwd: string, found: string | null): Promise<string | null> {
  try {
    if (found === null) return null;
    let gitDir = found;
    if (!(await stat(gitDir)).isDirectory()) {
      const pointer = parseGitDirPointer(await readFile(gitDir, 'utf8'));
      if (pointer === undefined) return null;
      gitDir = resolve(cwd, pointer);
    }
    const configPaths = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
    try {
      const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
      if (commonDir.length > 0) configPaths.push(join(resolve(gitDir, commonDir), 'config'));
    } catch {
    }
    const stamps = await Promise.all(configPaths.map(stampConfigPath));
    for (const path of configPaths) {
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content !== null && content.toLowerCase().includes('include')) return null;
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

function parseGitDirPointer(content: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;
  const rawPath = line.slice('gitdir:'.length).trim();
  return rawPath.length > 0 ? rawPath : undefined;
}

async function stampConfigPath(path: string): Promise<string> {
  try {
    const stats = await stat(path);
    return `${path}:${String(stats.mtimeMs)}:${String(stats.size)}`;
  } catch {
    return `${path}:missing`;
  }
}
