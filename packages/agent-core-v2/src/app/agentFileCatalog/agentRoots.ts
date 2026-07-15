/**
 * `agentFileCatalog` domain (L3) — agent-root resolution primitives.
 *
 * Resolves the ordered `AgentFileRoot` list a discovery pass should scan for
 * the user (home) and project (workspace) agent locations. Brand directories
 * are preferred over generic ones (`.kimi-code/agents` before
 * `.agents/agents`), and the project root is found by walking up to `.git`.
 * Mirrors `skillCatalog/skillRoots` so both discovery systems share one
 * directory convention. Pure path/fs probes; no scoped state.
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import type { AgentFileRoot, AgentFileSource } from './types';

const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  homeDir: string,
  osHomeDir: string,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(roots, USER_BRAND_DIRS, homeDir, 'user');
  await pushFirstExisting(roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return roots;
}

export async function projectAgentRoots(workDir: string): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(workDir);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(roots, PROJECT_BRAND_DIRS, projectRoot, 'project');
  await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return roots;
}

export async function configuredAgentRoots(
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(workDir);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(roots, resolveConfiguredDir(dir, projectRoot, osHomeDir), source);
  }
  return roots;
}

async function findProjectRoot(workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pushFirstExisting(
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, path.join(base, dir), source)) return;
  }
}

async function pushExistingRoot(
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
): Promise<boolean> {
  if (!(await isDir(dir))) return false;
  const resolved = await realpath(dir);
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

function resolveConfiguredDir(dir: string, projectRoot: string, osHomeDir: string): string {
  if (dir === '~') return osHomeDir;
  if (dir.startsWith('~/')) return path.join(osHomeDir, dir.slice(2));
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(projectRoot, dir);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function realpath(p: string): Promise<string> {
  return (await fs.realpath(p)).replaceAll('\\', '/');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
