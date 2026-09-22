import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  buildDriverOverrides,
  GIT_CONFIG_ARGS,
  GIT_DIFF_ARGS,
  INCLUDE_SECTION_RE,
  isCoreWorktreeSafe,
  parseGitDirPointer,
  resolveConfigPaths,
} from '@moonshot-ai/git-hardening';

export { GIT_CONFIG_ARGS, GIT_DIFF_ARGS };

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
    if ((await stat(gitDir)).isDirectory()) {
      resolvedGitDir = gitDir;
    } else {
      const pointer = parseGitDirPointer(await readFile(gitDir, 'utf8'));
      if (pointer === undefined) return true;
      resolvedGitDir = resolve(cwd, pointer);
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
      gitDir = resolve(cwd, pointer);
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
