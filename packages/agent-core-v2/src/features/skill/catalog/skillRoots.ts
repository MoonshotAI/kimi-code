import { promises as fs } from 'node:fs';
import path from 'pathe';

import { findUpwardRoot } from '#/_base/utils/paths';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { SkillRoot, SkillSource } from './types';

const USER_BRAND_DIRS = ['skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

export type SkillRootsFs = Pick<IHostFileSystem, 'stat' | 'realpath'>;

export interface SkillRootsOptions {
  readonly mergeAllAvailableSkills?: boolean;
}

const nodeFs: SkillRootsFs = {
  stat: async (p) => {
    const s = await fs.stat(p);
    return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size };
  },
  realpath: (p) => fs.realpath(p),
};

export async function userRoots(
  homeDir: string,
  osHomeDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(nodeFs, roots, USER_BRAND_DIRS, homeDir, 'user', mergeAllAvailableSkills);
  await pushFirstExisting(nodeFs, roots, USER_GENERIC_DIRS, osHomeDir, 'user');
  return roots;
}

export async function projectRoots(
  workDir: string,
  options: SkillRootsOptions = {},
  fs: SkillRootsFs = nodeFs,
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(fs, roots, PROJECT_BRAND_DIRS, projectRoot, 'project', mergeAllAvailableSkills);
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return roots;
}

export interface ProjectSkillRootCandidates {
  readonly projectRoot: string;
  readonly candidates: readonly string[];
}

export async function projectSkillRootCandidates(
  workDir: string,
  fs: SkillRootsFs = nodeFs,
): Promise<ProjectSkillRootCandidates> {
  const projectRoot = await realpathOrSelf(fs, await findProjectRoot(fs, workDir));
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
  fs: SkillRootsFs = nodeFs,
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: SkillRoot[] = [];
  for (const dir of dirs) {
    await pushExistingRoot(fs, roots, resolveConfiguredDir(dir, projectRoot, osHomeDir), source);
  }
  return roots;
}

async function findProjectRoot(fs: SkillRootsFs, workDir: string): Promise<string> {
  return findUpwardRoot(workDir, '.git', (p) => exists(fs, p));
}

async function pushFirstExisting(
  fs: SkillRootsFs,
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(fs, out, path.join(base, dir), source)) return;
  }
}

async function pushBrandGroup(
  fs: SkillRootsFs,
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
    await pushExistingRoot(fs, out, path.join(base, dir), source);
  }
}

async function pushExistingRoot(
  fs: SkillRootsFs,
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
): Promise<boolean> {
  if (!(await isDir(fs, dir))) return false;
  const resolved = await realpath(fs, dir);
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

function resolveConfiguredDir(dir: string, projectRoot: string, osHomeDir: string): string {
  if (dir === '~') return osHomeDir;
  if (dir.startsWith('~/')) return path.join(osHomeDir, dir.slice(2));
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(projectRoot, dir);
}

async function isDir(fs: SkillRootsFs, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function realpath(fs: SkillRootsFs, p: string): Promise<string> {
  return (await fs.realpath(p)).replaceAll('\\', '/');
}

async function realpathOrSelf(fs: SkillRootsFs, p: string): Promise<string> {
  try {
    return await realpath(fs, p);
  } catch {
    return p.replaceAll('\\', '/');
  }
}

async function exists(fs: SkillRootsFs, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
