import { dirname, isAbsolute, join, resolve } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';

import type { SkillRoot, SkillSource } from './types';

const USER_BRAND_DIRS = ['skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

export interface SkillRootsOptions {
  readonly mergeAllAvailableSkills?: boolean;
}

export async function userRoots(
  fs: OsFsPort,
  homeDir: string,
  osHomeDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(fs, roots, USER_BRAND_DIRS, homeDir, 'user', mergeAllAvailableSkills);
  await pushFirstExisting(fs, roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return roots;
}

export async function projectRoots(
  fs: OsFsPort,
  workDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project', mergeAllAvailableSkills);
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return roots;
}

export async function configuredRoots(
  fs: OsFsPort,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
  source: SkillSource,
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: SkillRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(fs, roots, resolveConfiguredDir(dir, projectRoot, osHomeDir), source);
  }
  return roots;
}

async function findProjectRoot(fs: OsFsPort, workDir: string): Promise<string> {
  return findUpwardRoot(workDir, '.git', (marker) => exists(fs, marker));
}

async function findUpwardRoot(
  workDir: string,
  markerName: string,
  hasMarker: (markerPath: string) => Promise<boolean>,
): Promise<string> {
  const start = resolve(workDir);
  let current = start;
  while (true) {
    if (await hasMarker(join(current, markerName))) return normalizeSlashes(current);
    const parent = dirname(current);
    if (parent === current) return normalizeSlashes(start);
    current = parent;
  }
}

function normalizeSlashes(p: string): string {
  return p.replaceAll('\\', '/');
}

async function pushFirstExisting(
  fs: OsFsPort,
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, join(base, dir), source)) return;
  }
}

async function pushBrandGroup(
  fs: OsFsPort,
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  mergeAllAvailableSkills: boolean,
): Promise<void> {
  if (!mergeAllAvailableSkills) {
    await pushFirstExisting(fs, out, dirs, base, source);
    return;
  }
  for (const dir of dirs) {
    await pushExistingRoot(fs, out, join(base, dir), source);
  }
}

async function pushExistingRoot(
  fs: OsFsPort,
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
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

async function isDir(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function exists(fs: OsFsPort, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
