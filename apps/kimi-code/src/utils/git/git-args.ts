import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  buildDriverOverrides,
  GIT_CONFIG_ARGS,
  GIT_DIFF_ARGS,
  INCLUDE_SECTION_RE,
  isCoreWorktreeSafe,
  parseGitDirPointer,
  resolveConfigPaths,
} from '@moonshot-ai/agent-core-v2/_base/utils/gitHardening';

export { GIT_CONFIG_ARGS, GIT_DIFF_ARGS };

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
  let resolvedGitDir = gitDir;
  if (!statSync(gitDir).isDirectory()) {
    const pointer = parseGitDirPointer(readFileSync(gitDir, 'utf8'));
    if (pointer === undefined) return true;
    resolvedGitDir = resolve(workDir, pointer);
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
      gitDir = resolve(workDir, pointer);
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
