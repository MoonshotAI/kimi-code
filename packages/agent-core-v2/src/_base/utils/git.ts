import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
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
  const stamp = await gitConfigStamp(cwd);
  const cached = filterArgsCache.get(cwd);
  if (stamp !== null && cached?.stamp === stamp) return cached.args;
  const filterArgs = await probeFilterArgs(cwd, probe);
  if (filterArgs === null) return null;
  const args = [...GIT_CONFIG_ARGS, ...filterArgs];
  filterArgsCache.set(cwd, { stamp, args });
  return args;
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
        '--get-regexp',
        '^filter\\.',
      ]).catch(() => null),
    ),
  );
  const drivers = new Set<string>();
  for (const result of results) {
    if (result === null || result.exitCode < 0) return null;
    if (result.exitCode !== 0) continue;
    for (const line of result.stdout.split('\n')) {
      const match = /^filter\.(.+)\.(?:clean|process)(?:\s|$)/.exec(line);
      const driver = match?.[1];
      if (driver !== undefined) drivers.add(driver);
    }
  }
  const args: string[] = [];
  for (const driver of drivers) {
    args.push('-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.process=`);
  }
  return args;
}

async function gitConfigStamp(cwd: string): Promise<string | null> {
  try {
    const found = await findGitDir(cwd);
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
