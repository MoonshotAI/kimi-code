/**
 * `agentFileCatalog` domain (L3) — agent-root resolution primitives.
 *
 * Resolves user, project, and configured discovery roots through the `hostFs`
 * filesystem boundary. Pure path probes; no scoped state.
 */

import { dirname, isAbsolute, join, resolve } from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { AgentFileRoot, AgentFileSource } from './types';

const USER_BRAND_DIRS = ['agents'] as const;
const USER_GENERIC_DIRS = ['.agents/agents'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/agents'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/agents'] as const;

export async function userAgentRoots(
  fs: IHostFileSystem,
  homeDir: string,
  osHomeDir: string,
): Promise<readonly AgentFileRoot[]> {
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, USER_BRAND_DIRS, homeDir, 'user');
  await pushFirstExisting(fs, roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return roots;
}

export async function projectAgentRoots(
  fs: IHostFileSystem,
  workDir: string,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: AgentFileRoot[] = [];
  await pushFirstExisting(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project');
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return roots;
}

export async function configuredAgentRoots(
  fs: IHostFileSystem,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: AgentFileSource,
): Promise<readonly AgentFileRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: AgentFileRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(
      fs,
      roots,
      resolveConfiguredDir(dir, projectRoot, osHomeDir),
      source,
    );
  }
  return roots;
}

async function findProjectRoot(fs: IHostFileSystem, workDir: string): Promise<string> {
  const start = resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(fs, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pushFirstExisting(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dirs: readonly string[],
  base: string,
  source: AgentFileSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, join(base, dir), source)) return;
  }
}

async function pushExistingRoot(
  fs: IHostFileSystem,
  out: AgentFileRoot[],
  dir: string,
  source: AgentFileSource,
): Promise<boolean> {
  if (!(await isDir(fs, dir))) return false;
  const resolved = (await fs.realpath(dir)).replaceAll('\\', '/');
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

function resolveConfiguredDir(dir: string, projectRoot: string, osHomeDir: string): string {
  if (dir === '~') return osHomeDir;
  if (dir.startsWith('~/')) return join(osHomeDir, dir.slice(2));
  if (isAbsolute(dir)) return dir;
  return resolve(projectRoot, dir);
}

async function isDir(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    const resolved = await fs.realpath(p);
    return (await fs.stat(resolved)).isDirectory;
  } catch {
    return false;
  }
}

async function exists(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
