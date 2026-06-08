import { promises as fs } from 'node:fs';
import path from 'pathe';

import { flags } from '../flags/resolver';
import { SkillParseError, UnsupportedSkillTypeError, parseSkillFromFile } from './parser';
import type { SkillDefinition, SkillRoot, SkillSource, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

const USER_BRAND_DIRS = ['.kimi-code/skills'] as const;
const USER_GENERIC_DIRS = ['.agents/skills'] as const;
const PROJECT_BRAND_DIRS = ['.kimi-code/skills'] as const;
const PROJECT_GENERIC_DIRS = ['.agents/skills'] as const;

type SubSkillFlagResolver = {
  enabled(id: 'sub_skill'): boolean;
};

// Bounds recursion so a directory symlink cycle inside a skill root cannot
// loop forever. Real skill trees are 1-3 levels deep.
const MAX_SKILL_SCAN_DEPTH = 8;

export interface SkillPathContext {
  readonly userHomeDir: string;
  readonly workDir: string;
}

export interface ResolveSkillRootsOptions {
  readonly paths: SkillPathContext;
  readonly builtinDir?: string;
  readonly explicitDirs?: readonly string[];
  readonly extraDirs?: readonly string[];
  readonly pluginSkillRoots?: readonly SkillRoot[];
  readonly mergeAllAvailableSkills?: boolean;
  readonly realpath?: (p: string) => Promise<string>;
  readonly isDir?: (p: string) => Promise<boolean>;
}

export interface DiscoverSkillsOptions {
  readonly roots: readonly SkillRoot[];
  readonly experimentalFlags?: SubSkillFlagResolver;
  readonly onWarning?: (message: string, cause?: unknown) => void;
  readonly onSkippedByPolicy?: (skill: SkippedSkill) => void;
  readonly onDiscoveredSkill?: (skill: SkillDefinition) => void;
  readonly readdir?: (p: string) => Promise<readonly string[]>;
  readonly isFile?: (p: string) => Promise<boolean>;
  readonly isDir?: (p: string) => Promise<boolean>;
  readonly parse?: (input: {
    readonly skillMdPath: string;
    readonly skillDirName: string;
    readonly source: SkillSource;
  }) => Promise<SkillDefinition>;
}

export interface WorkspaceWithAdditionalDirs {
  readonly workspaceDir: string;
  readonly additionalDirs: readonly string[];
}

export async function resolveSkillRoots(
  options: ResolveSkillRootsOptions,
): Promise<readonly SkillRoot[]> {
  const isDir = options.isDir ?? defaultIsDir;
  const realpath =
    options.realpath ??
    ((p: string) => fs.realpath(p).then((r) => r.replaceAll('\\', '/')));
  const roots: SkillRoot[] = [];
  const mergeAllAvailableSkills = options.mergeAllAvailableSkills ?? true;
  const { userHomeDir, workDir } = options.paths;
  const projectRoot = await findProjectRoot(workDir);

  if (options.explicitDirs !== undefined && options.explicitDirs.length > 0) {
    await pushConfiguredDirs(
      roots,
      options.explicitDirs,
      projectRoot,
      userHomeDir,
      'user',
      isDir,
      realpath,
    );
  } else {
    await pushBrandGroup(
      roots,
      PROJECT_BRAND_DIRS,
      projectRoot,
      'project',
      mergeAllAvailableSkills,
      isDir,
      realpath,
    );
    await pushFirstExisting(roots, PROJECT_GENERIC_DIRS, projectRoot, 'project', isDir, realpath);
    await pushBrandGroup(
      roots,
      USER_BRAND_DIRS,
      userHomeDir,
      'user',
      mergeAllAvailableSkills,
      isDir,
      realpath,
    );
    await pushFirstExisting(roots, USER_GENERIC_DIRS, userHomeDir, 'user', isDir, realpath);
  }

  if (options.extraDirs !== undefined) {
    await pushConfiguredDirs(
      roots,
      options.extraDirs,
      projectRoot,
      userHomeDir,
      'extra',
      isDir,
      realpath,
    );
  }

  if (options.pluginSkillRoots !== undefined) {
    for (const root of options.pluginSkillRoots) {
      await pushProvidedRoot(roots, root, isDir, realpath);
    }
  }

  if (options.builtinDir !== undefined) {
    await pushExistingRoot(roots, options.builtinDir, 'builtin', isDir, realpath);
  }

  return roots;
}

export async function discoverSkills(
  options: DiscoverSkillsOptions,
): Promise<readonly SkillDefinition[]> {
  const readdir = options.readdir ?? ((p: string) => fs.readdir(p));
  const isFile = options.isFile ?? defaultIsFile;
  const isDir = options.isDir ?? defaultIsDir;
  const parse = options.parse ?? parseSkillFromFile;
  const subSkillFlags = options.experimentalFlags ?? flags;
  const warn = options.onWarning ?? (() => {});
  const skip = options.onSkippedByPolicy ?? (() => {});
  const byName = new Map<string, SkillDefinition>();

  async function walkSkillDir(
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      // Sorted so first-wins collision resolution across sibling directories
      // is deterministic rather than dependent on filesystem readdir order.
      entries = [...(await readdir(dirPath))].toSorted();
    } catch (error) {
      warn(`Failed to read skill directory ${dirPath}`, error);
      return;
    }

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      // A directory holding SKILL.md is a skill bundle: register it, then keep
      // descending so nested SKILL.md bundles remain discoverable as sub-skills.
      if (await isFile(path.join(entryPath, 'SKILL.md'))) {
        directorySkills.add(entry);
      }
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      if (await isDir(entryPath)) subdirs.push(entry);
    }

    const allowedSubSkillBundles = new Set<string>();
    for (const entry of directorySkills) {
      const skill = await parseAndRegister({
        parse,
        byName,
        skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
        skillDirName: entry,
        root,
        onDiscoveredSkill: options.onDiscoveredSkill,
        warn,
        skip,
      });
      if (skill !== undefined && hasSubSkillEnabled(skill, subSkillFlags)) {
        allowedSubSkillBundles.add(entry);
      }
    }

    // Flat .md skills count only at a root's top level; deeper .md files are
    // skill payload (e.g. references/foo.md), not skills.
    if (isTopLevel) {
      // A SKILL.md placed directly at a plugin skill root (e.g. plugin root fallback)
      // is treated as a single skill bundle. This only applies to plugin-derived roots,
      // not to user/project skill directories.
      if (root.plugin !== undefined) {
        const rootSkillMd = path.join(dirPath, 'SKILL.md');
        if (await isFile(rootSkillMd)) {
          await parseAndRegister({
            parse,
            byName,
            skillMdPath: rootSkillMd,
            skillDirName: path.basename(dirPath),
            root,
            onDiscoveredSkill: options.onDiscoveredSkill,
            warn,
            skip,
          });
        }
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        if (entry === 'SKILL.md') continue;
        const skillName = entry.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) {
          warn(
            `Ignoring flat skill ${path.join(dirPath, entry)} because ${path.join(dirPath, skillName, 'SKILL.md')} exists with the same name`,
          );
          continue;
        }
        const skillMdPath = path.join(dirPath, entry);
        if (!(await isFile(skillMdPath))) continue;
        await parseAndRegister({
          parse,
          byName,
          skillMdPath,
          skillDirName: skillName,
          root,
          onDiscoveredSkill: options.onDiscoveredSkill,
          warn,
          skip,
        });
      }
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      await walkSkillDir(path.join(dirPath, entry), root, false, depth + 1);
    }
  }

  for (const root of options.roots) {
    await walkSkillDir(root.path, root, true, 0);
  }

  return sortSkills([...byName.values()]);
}

export function extendWorkspaceWithSkillRoots<T extends WorkspaceWithAdditionalDirs>(
  workspace: T,
  skillRoots: readonly string[],
): T {
  const additionalDirs = [...workspace.additionalDirs];
  for (const root of skillRoots) {
    if (isWithin(root, workspace.workspaceDir)) continue;
    if (additionalDirs.some((dir) => root === dir || isWithin(root, dir))) continue;
    additionalDirs.push(root);
  }
  if (additionalDirs.length === workspace.additionalDirs.length) return workspace;
  return { ...workspace, additionalDirs };
}

function sortSkills(skills: readonly SkillDefinition[]): readonly SkillDefinition[] {
  return [...skills].toSorted((a, b) => a.name.localeCompare(b.name));
}

async function pushFirstExisting(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  for (const dir of dirs) {
    if (await pushExistingRoot(out, path.join(base, dir), source, isDir, realpath)) return;
  }
}

async function pushBrandGroup(
  out: SkillRoot[],
  dirs: readonly string[],
  base: string,
  source: SkillSource,
  mergeAllAvailableSkills: boolean,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  if (!mergeAllAvailableSkills) {
    await pushFirstExisting(out, dirs, base, source, isDir, realpath);
    return;
  }
  for (const dir of dirs) {
    await pushExistingRoot(out, path.join(base, dir), source, isDir, realpath);
  }
}

async function pushConfiguredDirs(
  out: SkillRoot[],
  dirs: readonly string[],
  projectRoot: string,
  userHomeDir: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<void> {
  for (const dir of dirs) {
    await pushExistingRoot(
      out,
      resolveConfiguredDir(dir, projectRoot, userHomeDir),
      source,
      isDir,
      realpath,
    );
  }
}

async function pushExistingRoot(
  out: SkillRoot[],
  dir: string,
  source: SkillSource,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<boolean> {
  if (!(await isDir(dir))) return false;
  const resolved = await realpath(dir);
  if (!out.some((root) => root.path === resolved)) out.push({ path: resolved, source });
  return true;
}

async function pushProvidedRoot(
  out: SkillRoot[],
  root: SkillRoot,
  isDir: (p: string) => Promise<boolean>,
  realpath: (p: string) => Promise<string>,
): Promise<boolean> {
  if (!(await isDir(root.path))) return false;
  const resolved = await realpath(root.path);
  const existingIndex = out.findIndex((existing) => existing.path === resolved);
  if (existingIndex < 0) {
    out.push({ ...root, path: resolved });
    return true;
  }
  const existing = out[existingIndex];
  if (existing !== undefined && existing.plugin === undefined && root.plugin !== undefined) {
    out[existingIndex] = { ...existing, plugin: root.plugin };
  }
  return true;
}

async function parseAndRegister(input: {
  readonly parse: NonNullable<DiscoverSkillsOptions['parse']>;
  readonly byName: Map<string, SkillDefinition>;
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly onDiscoveredSkill?: (skill: SkillDefinition) => void;
  readonly warn: (message: string, cause?: unknown) => void;
  readonly skip: (skill: SkippedSkill) => void;
}): Promise<SkillDefinition | undefined> {
  try {
    const skill = await input.parse({
      skillMdPath: input.skillMdPath,
      skillDirName: input.skillDirName,
      source: input.root.source,
    });
    const discovered = input.root.plugin === undefined ? skill : {
      ...skill,
      plugin: input.root.plugin,
    };
    input.onDiscoveredSkill?.(discovered);
    const key = normalizeSkillName(discovered.name);
    if (!input.byName.has(key)) {
      input.byName.set(key, discovered);
    }
    return skill;
  } catch (error) {
    if (error instanceof UnsupportedSkillTypeError) {
      input.skip({
        path: input.skillMdPath,
        type: error.skillType,
        reason: `unsupported skill type "${error.skillType}"`,
      });
    } else if (error instanceof SkillParseError) {
      input.warn(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
    } else {
      input.warn(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
    }
    return undefined;
  }
}

function hasSubSkillEnabled(
  skill: SkillDefinition,
  experimentalFlags: SubSkillFlagResolver,
): boolean {
  if (!experimentalFlags.enabled('sub_skill')) return false;
  const nested = skill.metadata['metadata'];
  const nestedFlag =
    typeof nested === 'object' && nested !== null
      ? (nested as Record<string, unknown>)['has-sub-skill'] === true ||
        (nested as Record<string, unknown>)['hasSubSkill'] === true
      : false;
  return (
    skill.metadata['has-sub-skill'] === true ||
    skill.metadata['hasSubSkill'] === true ||
    nestedFlag
  );
}

async function defaultIsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function defaultIsFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
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

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function resolveConfiguredDir(dir: string, projectRoot: string, userHomeDir: string): string {
  if (dir === '~') return userHomeDir;
  if (dir.startsWith('~/')) return path.join(userHomeDir, dir.slice(2));
  if (path.isAbsolute(dir)) return dir;
  return path.resolve(projectRoot, dir);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
