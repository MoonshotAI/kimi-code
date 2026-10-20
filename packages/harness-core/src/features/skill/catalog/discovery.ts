import { basename, join } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';

import { SkillParseError, UnsupportedSkillTypeError } from './errors';
import { parseSkillText } from './parser';
import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

export const MAX_SKILL_SCAN_DEPTH = 8;

export interface SkillDiscoveryResult {
  readonly skills: readonly SkillDefinition[];
  readonly skipped: readonly SkippedSkill[];
  readonly scannedRoots: readonly string[];
  readonly scannedDirectories: readonly string[];
}

export async function discoverSkills(
  fs: OsFsPort,
  roots: readonly SkillRoot[],
  warn?: (message: string) => void,
): Promise<SkillDiscoveryResult> {
  const byDiscoveryKey = new Map<string, SkillDefinition>();
  const skipped: SkippedSkill[] = [];
  const scannedDirectories: string[] = [];

  const register = async (input: {
    readonly skillMdPath: string;
    readonly skillDirName: string;
    readonly root: SkillRoot;
    readonly subSkillParentName?: string;
  }): Promise<SkillDefinition | undefined> => {
    try {
      const text = await fs.readText(input.skillMdPath);
      const parsed = parseSkillText({
        skillMdPath: input.skillMdPath,
        skillDirName: input.skillDirName,
        source: input.root.source,
        text,
      });
      const skill =
        input.subSkillParentName === undefined
          ? parsed
          : {
              ...parsed,
              name: qualifySubSkillName(input.subSkillParentName, parsed.name),
              metadata: { ...parsed.metadata, isSubSkill: true },
            };
      const discovered =
        input.root.plugin === undefined ? skill : { ...skill, plugin: input.root.plugin };
      const key =
        input.root.plugin === undefined
          ? normalizeSkillName(discovered.name)
          : `${input.root.plugin.id}\0${normalizeSkillName(discovered.name)}`;
      if (!byDiscoveryKey.has(key)) byDiscoveryKey.set(key, discovered);
      return discovered;
    } catch (error) {
      if (error instanceof UnsupportedSkillTypeError) {
        skipped.push({
          path: input.skillMdPath,
          type: error.skillType,
          reason: `unsupported skill type "${error.skillType}"`,
        });
      } else if (error instanceof SkillParseError) {
        warn?.(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`);
      } else {
        warn?.(`Skipping skill at ${input.skillMdPath} due to unexpected error`);
      }
      return undefined;
    }
  };

  const isFile = async (value: string): Promise<boolean> => {
    try {
      return (await fs.stat(value)).isFile;
    } catch {
      return false;
    }
  };

  const isDirectory = async (value: string): Promise<boolean> => {
    try {
      return (await fs.stat(value)).isDirectory;
    } catch {
      return false;
    }
  };

  const walk = async (
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
    subSkillParentName?: string,
  ): Promise<void> => {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;
    if (root.scanMode === 'root-skill-only') {
      const skillMdPath = join(dirPath, 'SKILL.md');
      if (await isFile(skillMdPath)) {
        await register({ skillMdPath, skillDirName: basename(dirPath), root });
      }
      return;
    }

    let entries;
    try {
      entries = [...(await fs.readdir(dirPath))].toSorted((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return;
    }
    scannedDirectories.push(dirPath);

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (const entry of entries) {
      const entryPath = join(dirPath, entry.name);
      const directory =
        entry.isDirectory === true ||
        (entry.isSymbolicLink === true && (await isDirectory(entryPath)));
      if (directory && (await isFile(join(entryPath, 'SKILL.md')))) {
        directorySkills.add(entry.name);
      }
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      if (directory) subdirs.push(entry.name);
    }

    const allowedSubSkillBundles = new Map<string, string>();
    for (const entry of directorySkills) {
      const skill = await register({
        skillMdPath: join(dirPath, entry, 'SKILL.md'),
        skillDirName: entry,
        root,
        subSkillParentName,
      });
      if (skill !== undefined && hasSubSkillEnabled(skill)) {
        allowedSubSkillBundles.set(entry, skill.name);
      }
    }

    if (isTopLevel) {
      if (root.plugin !== undefined) {
        const skillMdPath = join(dirPath, 'SKILL.md');
        if (await isFile(skillMdPath)) {
          await register({ skillMdPath, skillDirName: basename(dirPath), root });
        }
      }
      for (const entry of entries) {
        if (entry.isFile !== true || !entry.name.endsWith('.md') || entry.name === 'SKILL.md')
          continue;
        const skillName = entry.name.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) continue;
        await register({
          skillMdPath: join(dirPath, entry.name),
          skillDirName: skillName,
          root,
        });
      }
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      await walk(
        join(dirPath, entry),
        root,
        false,
        depth + 1,
        allowedSubSkillBundles.get(entry) ?? subSkillParentName,
      );
    }
  };

  for (const root of roots) await walk(root.path, root, true, 0);
  return {
    skills: [...byDiscoveryKey.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    skipped,
    scannedRoots: roots.map((root) => root.path),
    scannedDirectories,
  };
}

function qualifySubSkillName(parentName: string, skillName: string): string {
  if (skillName === parentName || skillName.startsWith(`${parentName}.`)) return skillName;
  return `${parentName}.${skillName}`;
}

function hasSubSkillEnabled(skill: SkillDefinition): boolean {
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
