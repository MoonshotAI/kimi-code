/**
 * `skillCatalog` domain (L3) — skill-root resolution primitives.
 *
 * Resolves the ordered `SkillRoot` list a discovery backend should scan for the
 * user (home) and project (workspace) skill locations. Brand directories are
 * preferred over generic ones (`.kimi-code/skills` before `.agents/skills`),
 * and the project root is found by walking up to `.git`. Plugin roots are no
 * longer folded in here — plugins are a separate `ISkillSource`. The
 * `*Candidates` helpers return the same locations WITHOUT the existence filter
 * or realpath resolution, for file watchers that must observe roots appearing
 * later. These helpers are exported so the edge can compose a workspace's
 * skills without a Session. Pure path probes through `IHostFileSystem`; no
 * scoped state.
 */

import path from 'pathe';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';

import type { SkillRoot, SkillSource } from './types';

const USER_BRAND_DIRS = ['skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

export interface SkillRootsOptions {
  readonly mergeAllAvailableSkills?: boolean;
}

export async function userRoots(
  fs: IHostFileSystem,
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
  fs: IHostFileSystem,
  workDir: string,
  options: SkillRootsOptions = {},
): Promise<readonly SkillRoot[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  await pushBrandGroup(
    fs,
    roots,
    PROJECT_BRAND_DIRS,
    projectRoot,
    'project',
    mergeAllAvailableSkills,
  );
  await pushFirstExisting(fs, roots, PROJECT_GENERIC_DIRS, projectRoot, 'project');
  return roots;
}

export async function configuredRoots(
  fs: IHostFileSystem,
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

export function userRootCandidates(homeDir: string, osHomeDir: string): readonly string[] {
  return [
    ...USER_BRAND_DIRS.map((dir) => path.join(homeDir, dir)),
    ...USER_GENERIC_DIRS.map((dir) => path.join(osHomeDir, dir)),
  ];
}

export async function projectRootCandidates(
  fs: IHostFileSystem,
  workDir: string,
): Promise<readonly string[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  return [
    ...PROJECT_BRAND_DIRS.map((dir) => path.join(projectRoot, dir)),
    ...PROJECT_GENERIC_DIRS.map((dir) => path.join(projectRoot, dir)),
  ];
}

export async function configuredRootCandidates(
  fs: IHostFileSystem,
  dirs: readonly string[],
  workDir: string,
  osHomeDir: string,
): Promise<readonly string[]> {
  const projectRoot = await findProjectRoot(fs, workDir);
  return dirs.map((dir) => resolveConfiguredDir(dir, projectRoot, osHomeDir));
}

async function findProjectRoot(fs: IHostFileSystem, workDir: string): Promise<string> {
  const start = path.resolve(workDir);
  let current = start;
  while (true) {
    if (await exists(fs, path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

async function pushFirstExisting(
  fs: IHostFileSystem,
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
  fs: IHostFileSystem,
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
  fs: IHostFileSystem,
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

export async function isDir(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory;
  } catch {
    return false;
  }
}

async function realpath(fs: IHostFileSystem, p: string): Promise<string> {
  return (await fs.realpath(p)).replaceAll('\\', '/');
}

async function exists(fs: IHostFileSystem, p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
