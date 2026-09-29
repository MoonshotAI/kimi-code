import { basename, dirname, join, normalize } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';

import { findGitWorkTree } from './git-work-tree';

export const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

export interface AgentsMdFsDeps {
  readonly fs: OsFsPort;
}

export interface AgentsMdDeps extends AgentsMdFsDeps {
  readonly homeDir: string;
}

export function dotKimiAgentsMdPath(dir: string): string {
  return join(dir, '.kimi-code', 'AGENTS.md');
}

export function agentsMdCandidatePaths(dir: string): string[] {
  return [dotKimiAgentsMdPath(dir), ...AGENTS_MD_PLAIN_NAMES.map((name) => join(dir, name))];
}

export function extractAgentsMdPathsFromSystemPrompt(systemPrompt: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of systemPrompt.matchAll(/^<!-- From: (.+) -->$/gm)) {
    const path = match[1];
    if (
      path === undefined ||
      !AGENTS_MD_PLAIN_NAMES.some((candidate) => candidate === basename(path))
    ) {
      continue;
    }
    const normalized = normalize(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

export async function isNonEmptyFile(deps: AgentsMdFsDeps, path: string): Promise<boolean> {
  try {
    const content = await deps.fs.readText(path, { errors: 'ignore' });
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

export async function findAgentsMdInDir(deps: AgentsMdFsDeps, dir: string): Promise<string[]> {
  const found: string[] = [];
  const dotKimi = dotKimiAgentsMdPath(dir);
  if (await isNonEmptyFile(deps, dotKimi)) found.push(dotKimi);
  for (const fileName of AGENTS_MD_PLAIN_NAMES) {
    const candidate = join(dir, fileName);
    if (await isNonEmptyFile(deps, candidate)) {
      found.push(candidate);
      break;
    }
  }
  return found;
}

export async function findProjectRoot(deps: AgentsMdFsDeps, workDir: string): Promise<string> {
  const rootWorkDir = normalize(workDir);
  return (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
}

export function dirsRootToLeaf(workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = normalize(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

export async function loadAgentsMdPaths(
  deps: AgentsMdDeps,
  workDir: string,
  brandHome?: string,
): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const collect = async (path: string): Promise<boolean> => {
    if (!(await isNonEmptyFile(deps, path))) return false;
    const key = normalize(path);
    if (seen.has(key)) return false;
    seen.add(key);
    found.push(key);
    return true;
  };

  const brandDir = brandHome ?? join(deps.homeDir, '.kimi-code');
  await collect(join(brandDir, 'AGENTS.md'));
  for (const fileName of AGENTS_MD_PLAIN_NAMES) {
    if (await collect(join(deps.homeDir, '.agents', fileName))) break;
  }

  const rootWorkDir = normalize(workDir);
  const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
  for (const dir of dirsRootToLeaf(rootWorkDir, projectRoot)) {
    await collect(dotKimiAgentsMdPath(dir));
    for (const fileName of AGENTS_MD_PLAIN_NAMES) {
      if (await collect(join(dir, fileName))) break;
    }
  }
  return found;
}

export async function agentsMdWatchCandidates(
  deps: AgentsMdDeps,
  workDir: string,
  brandHome?: string,
): Promise<string[]> {
  const brandDir = brandHome ?? join(deps.homeDir, '.kimi-code');
  const candidates: string[] = [
    join(brandDir, 'AGENTS.md'),
    join(deps.homeDir, '.agents', 'AGENTS.md'),
    join(deps.homeDir, '.agents', 'agents.md'),
  ];
  const rootWorkDir = normalize(workDir);
  const projectRoot = (await findGitWorkTree(deps.fs, rootWorkDir))?.root ?? rootWorkDir;
  for (const dir of dirsRootToLeaf(rootWorkDir, projectRoot)) {
    candidates.push(...agentsMdCandidatePaths(dir));
  }
  return candidates;
}
