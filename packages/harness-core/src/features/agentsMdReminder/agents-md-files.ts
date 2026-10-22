import { dirname, join, normalize } from 'pathe';

import type { OsFsPort } from '#/todo-features/os/host/index';

import { findGitWorkTree } from './git-work-tree';

export const AGENTS_MD_PLAIN_NAMES = ['AGENTS.md', 'agents.md'] as const;

export interface AgentsMdFsDeps {
  readonly fs: OsFsPort;
}

export interface AgentsMdDeps extends AgentsMdFsDeps {
  readonly homeDir: string;
}

export interface AgentsMdRoot {
  readonly leaf: string;
  readonly boundary: string;
}

export function dotKimiAgentsMdPath(dir: string): string {
  return join(dir, '.kimi-code', 'AGENTS.md');
}

export function agentsMdCandidatePaths(dir: string): string[] {
  return [dotKimiAgentsMdPath(dir), ...AGENTS_MD_PLAIN_NAMES.map((name) => join(dir, name))];
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

export async function loadAgentsMdForRoots(
  deps: AgentsMdDeps,
  brandHome: string | undefined,
  roots: readonly AgentsMdRoot[],
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

  await collect(join(brandHome ?? join(deps.homeDir, '.kimi-code'), 'AGENTS.md'));
  for (const fileName of AGENTS_MD_PLAIN_NAMES) {
    if (await collect(join(deps.homeDir, '.agents', fileName))) break;
  }

  for (const root of roots) {
    for (const dir of dirsRootToLeaf(root.leaf, normalize(root.boundary))) {
      await collect(dotKimiAgentsMdPath(dir));
      for (const fileName of AGENTS_MD_PLAIN_NAMES) {
        if (await collect(join(dir, fileName))) break;
      }
    }
  }
  return found;
}

export async function agentsMdWatchCandidatesForRoots(
  deps: AgentsMdDeps,
  brandHome: string | undefined,
  roots: readonly AgentsMdRoot[],
): Promise<string[]> {
  const candidates: string[] = [
    join(brandHome ?? join(deps.homeDir, '.kimi-code'), 'AGENTS.md'),
    join(deps.homeDir, '.agents', 'AGENTS.md'),
    join(deps.homeDir, '.agents', 'agents.md'),
  ];
  for (const root of roots) {
    for (const dir of dirsRootToLeaf(root.leaf, normalize(root.boundary))) {
      candidates.push(...agentsMdCandidatePaths(dir));
    }
  }
  return candidates;
}

export async function loadAgentsMdContent(
  deps: AgentsMdFsDeps,
  paths: readonly string[],
): Promise<string> {
  const sections: string[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = (await deps.fs.readText(path, { errors: 'ignore' })).trim();
    } catch {
      continue;
    }
    if (text.length === 0) continue;
    sections.push(`<!-- From: ${path} -->\n${text}`);
  }
  return sections.join('\n\n');
}
