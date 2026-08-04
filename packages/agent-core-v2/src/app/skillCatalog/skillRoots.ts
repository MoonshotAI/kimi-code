/**
 * `skillCatalog` domain — skill-root resolution primitives.
 *
 * Resolves the ordered `SkillRoot` list a discovery backend should scan for the
 * user (home) and project (workspace) skill locations. Brand directories are
 * preferred over generic ones (`.kimi-code/skills` before `.agents/skills`),
 * and the project root is found by walking up to `.git`. Pure path/fs probes;
 * no scoped state.
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import type { SkillRoot, SkillSource } from './types';

const USER_BRAND_DIRS = ['skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

export interface SkillRootsOptions {
  readonly mergeAllAvailableSkills?: boolean;
}

export interface SkillRootResolution {
  readonly candidates: readonly string[];
  readonly roots: readonly SkillRoot[];
}

export async function resolveUserSkillRoots(
  homeDir: string,
  osHomeDir: string,
  options: SkillRootsOptions = {},
): Promise<SkillRootResolution> {
  const candidates = userRootCandidates(homeDir, osHomeDir);
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(roots, USER_BRAND_DIRS, homeDir, 'user', mergeAllAvailableSkills);
  await pushFirstExisting(roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return { candidates, roots };
}

export async function userRoots(
  homeDir: string,
  osHomeDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  return (await resolveUserSkillRoots(homeDir, osHomeDir, options)).roots;
}

export async function resolveProjectSkillRoots(
  workDir: string,
  options: SkillRootsOptions = {},
): Promise<SkillRootResolution> {
  const projectRoot = await findProjectRoot(workDir);
  const candidates = [
    ...PROJECT_BRAND_DIRS.map((dir) => path.join(projectRoot, dir)),
    ...PROJECT_GENERIC_DIRS.map((dir) => path.join(projectRoot, dir)),
  ];
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(roots, PROJECT_BRAND_DIRS, projectRoot, 'project', mergeAllAvailableSkills);
  await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return { candidates, roots };
}

export async function projectRoots(
  workDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  return (await resolveProjectSkillRoots(workDir, options)).roots;
}

export async function resolveConfiguredSkillRoots(
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: SkillSource,
): Promise<SkillRootResolution> {
  const projectRoot = await findProjectRoot(workDir);
  const candidates = dirs.map((dir) => resolveConfiguredDir(dir, projectRoot, osHomeDir));
  const roots: SkillRoot[] = [];
  for (const candidate of candidates) {
    await pushExistingRoot(roots, candidate, source);
  }
  return { candidates, roots };
}

export interface ProjectSkillRootCandidates {
  readonly projectRoot: string;
  readonly candidates: readonly string[];
}

export async function projectSkillRootCandidates(
  workDir: string,
): Promise<ProjectSkillRootCandidates> {
  const projectRoot = await findProjectRoot(workDir);
  return {
    projectRoot,
    candidates: [...PROJECT_BRAND_DIRS, ...PROJECT_GENERIC_DIRS].map((dir) =>
      path.join(projectRoot, dir),
    ),
  };
}

export async function configuredRoots(
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: SkillSource,
): Promise<readonly SkillRoot[]> {
  return (await resolveConfiguredSkillRoots(dirs, workDir, osHomeDir, source)).roots;
}

export function userRootCandidates(homeDir: string, osHomeDir: string): readonly string[] {
  return [
    ...USER_BRAND_DIRS.map((dir) => path.join(homeDir, dir)),
    ...USER_GENERIC_DIRS.map((dir) => path.join(osHomeDir, dir)),
  ];
}

export async function projectRootCandidates(workDir: string): Promise<readonly string[]> {
  const projectRoot = await findProjectRoot(workDir);
  return [
    ...PROJECT_BRAND_DIRS.map((dir) => path.join(projectRoot, dir)),
    ...PROJECT_GENERIC_DIRS.map((dir) => path.join(projectRoot, dir)),
  ];
}

export async function configuredRootCandidates(
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
): Promise<readonly string[]> {
  const projectRoot = await findProjectRoot(workDir);
  return dirs.map((dir) => resolveConfiguredDir(dir, projectRoot, osHomeDir));
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
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, path.join(base, dir), source)) return;
  }
}

async function pushBrandGroup(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  mergeAllAvailableSkills: boolean,
): Promise<void> {
  if (!mergeAllAvailableSkills) {
    await pushFirstExisting(out, dirs, base, source);
    return;
  }
  for (const dir of dirs) {
    await pushExistingRoot(out, path.join(base, dir), source);
  }
}

async function pushExistingRoot(
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
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
