import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

export const GIT_CONFIG_ARGS: readonly string[] = [
  '-c',
  'core.fsmonitor=false',
  '-c',
  `core.hooksPath=${NULL_DEVICE}`,
  '-c',
  'commit.gpgSign=false',
];

export const GIT_DIFF_ARGS: readonly string[] = ['--no-ext-diff', '--no-textconv'];

const FILTER_PROBE_TIMEOUT_MS = 500;
const FILTER_PROBE_MAX_BYTES = 16 * 1024 * 1024;

interface FilterArgsCacheEntry {
  readonly stamp: string | null;
  readonly args: readonly string[];
}

const filterArgsCache = new Map<string, FilterArgsCacheEntry>();

export function hardenedGitConfigArgs(git: string, workDir: string): readonly string[] | null {
  const stamp = gitConfigStamp(workDir);
  const cached = filterArgsCache.get(workDir);
  if (stamp !== null && cached?.stamp === stamp) return cached.args;
  const filterArgs = probeFilterArgs(git, workDir);
  if (filterArgs === null) return null;
  const args = [...GIT_CONFIG_ARGS, ...filterArgs];
  filterArgsCache.set(workDir, { stamp, args });
  return args;
}

function probeFilterArgs(git: string, workDir: string): readonly string[] | null {
  try {
    const filterDrivers = new Set<string>();
    const mergeDrivers = new Set<string>();
    for (const scope of ['--local', '--worktree']) {
      const result = spawnSync(
        git,
        [
          ...GIT_CONFIG_ARGS,
          '-C',
          workDir,
          'config',
          scope,
          '--includes',
          '--get-regexp',
          '^(filter|merge)\\.',
        ],
        { encoding: 'utf8', timeout: FILTER_PROBE_TIMEOUT_MS, maxBuffer: FILTER_PROBE_MAX_BYTES },
      );
      if (result.error !== undefined || result.status === null) return null;
      if (result.status !== 0 || typeof result.stdout !== 'string') continue;
      for (const line of result.stdout.split('\n')) {
        const filter = /^filter\.(.+)\.(?:clean|process|smudge)(?:\s|$)/.exec(line);
        const filterDriver = filter?.[1];
        if (filterDriver !== undefined) filterDrivers.add(filterDriver);
        const merge = /^merge\.(.+)\.driver(?:\s|$)/.exec(line);
        const mergeDriver = merge?.[1];
        if (mergeDriver !== undefined) mergeDrivers.add(mergeDriver);
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
  } catch {
    return null;
  }
}

function gitConfigStamp(workDir: string): string | null {
  try {
    const found = findGitDir(workDir);
    if (found === null) return null;
    let gitDir = found;
    if (!statSync(gitDir).isDirectory()) {
      const pointer = parseGitDirPointer(readFileSync(gitDir, 'utf8'));
      if (pointer === undefined) return null;
      gitDir = resolve(workDir, pointer);
    }
    const configPaths = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
    try {
      const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      if (commonDir.length > 0) configPaths.push(join(resolve(gitDir, commonDir), 'config'));
    } catch {
    }
    return configPaths.map(stampConfigPath).join('|');
  } catch {
    return null;
  }
}

function findGitDir(start: string): string | null {
  let dir = start;
  for (;;) {
    const candidate = join(dir, '.git');
    try {
      statSync(candidate);
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

function stampConfigPath(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return `${path}:missing`;
  }
}
