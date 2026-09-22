import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
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

const INCLUDE_SECTION_RE = /^\s*\[\s*include(?:\.|\s|\]|if)/im;

function parseGitDirPointer(content: string): string | undefined {
  const stripped = content.codePointAt(0) === 0xfeff ? content.slice(1) : content;
  const line = stripped.trimStart().split(/\r?\n/, 1)[0]?.trim();
  if (line === undefined || !line.startsWith('gitdir:')) return undefined;
  const rawPath = line.slice('gitdir:'.length).trim();
  return rawPath.length > 0 ? rawPath : undefined;
}

function resolveConfigPaths(gitDir: string, commondirContent: string | undefined): string[] {
  const configPaths = [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
  const commonDir = commondirContent?.trim();
  if (commonDir !== undefined && commonDir.length > 0) {
    configPaths.push(join(resolve(gitDir, commonDir), 'config'));
  }
  return configPaths;
}

function buildDriverOverrides(outputs: readonly string[]): readonly string[] | null {
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

function isCoreWorktreeSafe(raw: string, resolvedGitDir: string, workTreeRoot: string): boolean {
  const configured = isAbsolute(raw) ? normalize(raw) : resolve(resolvedGitDir, raw);
  if (process.platform === 'win32') {
    return normalize(configured).toLowerCase() === normalize(workTreeRoot).toLowerCase();
  }
  return normalize(configured) === normalize(workTreeRoot);
}

const FILTER_PROBE_TIMEOUT_MS = 500;
const FILTER_PROBE_MAX_BYTES = 16 * 1024 * 1024;

interface FilterArgsCacheEntry {
  readonly stamp: string | null;
  readonly args: readonly string[];
}

const filterArgsCache = new Map<string, FilterArgsCacheEntry>();

export function hardenedGitConfigArgs(git: string, workDir: string): readonly string[] | null {
  const gitDir = findGitDir(workDir);
  const stamp = gitConfigStamp(workDir, gitDir);
  const cached = filterArgsCache.get(workDir);
  if (stamp !== null && cached?.stamp === stamp) return cached.args;
  if (!coreWorktreeSafe(git, workDir, gitDir)) return null;
  const filterArgs = probeFilterArgs(git, workDir);
  if (filterArgs === null) return null;
  const args = [...GIT_CONFIG_ARGS, ...filterArgs];
  filterArgsCache.set(workDir, { stamp, args });
  return args;
}

function coreWorktreeSafe(git: string, workDir: string, gitDir: string | null): boolean {
  if (gitDir === null) return true;
  let resolvedGitDir: string;
  try {
    const realGitPath = realpathSync(gitDir);
    if (statSync(realGitPath).isDirectory()) {
      resolvedGitDir = realGitPath;
    } else {
      const pointer = parseGitDirPointer(readFileSync(realGitPath, 'utf8'));
      if (pointer === undefined) return true;
      resolvedGitDir = resolve(dirname(realGitPath), pointer);
    }
  } catch {
    return false;
  }
  const workTreeRoot = dirname(gitDir);
  for (const scope of ['--local', '--worktree']) {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync(
        git,
        [...GIT_CONFIG_ARGS, '-C', workDir, 'config', scope, '--includes', '--get', 'core.worktree'],
        { encoding: 'utf8', timeout: FILTER_PROBE_TIMEOUT_MS, maxBuffer: FILTER_PROBE_MAX_BYTES },
      );
    } catch {
      return false;
    }
    if (result.error !== undefined || result.status === null) return false;
    if (result.status !== 0 || typeof result.stdout !== 'string') continue;
    const raw = result.stdout.trim();
    if (raw === '' || isCoreWorktreeSafe(raw, resolvedGitDir, workTreeRoot)) continue;
    return false;
  }
  return true;
}

function probeFilterArgs(git: string, workDir: string): readonly string[] | null {
  try {
    const outputs: string[] = [];
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
          '--name-only',
          '^(filter|merge)\\.',
        ],
        { encoding: 'utf8', timeout: FILTER_PROBE_TIMEOUT_MS, maxBuffer: FILTER_PROBE_MAX_BYTES },
      );
      if (result.error !== undefined || result.status === null) return null;
      if (result.status !== 0 || typeof result.stdout !== 'string') continue;
      outputs.push(result.stdout);
    }
    return buildDriverOverrides(outputs);
  } catch {
    return null;
  }
}

function gitConfigStamp(workDir: string, found: string | null): string | null {
  try {
    if (found === null) return null;
    let gitDir = found;
    if (!statSync(gitDir).isDirectory()) {
      const pointer = parseGitDirPointer(readFileSync(gitDir, 'utf8'));
      if (pointer === undefined) return null;
      gitDir = resolve(dirname(found), pointer);
    }
    let commondir: string | undefined;
    try {
      commondir = readFileSync(join(gitDir, 'commondir'), 'utf8');
    } catch {
    }
    const configPaths = resolveConfigPaths(gitDir, commondir);
    for (const path of configPaths) {
      let content: string | null = null;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
      }
      if (content !== null && INCLUDE_SECTION_RE.test(content)) return null;
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

function stampConfigPath(path: string): string {
  try {
    const stat = statSync(path);
    return `${path}:${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return `${path}:missing`;
  }
}
