/**
 * `skillCatalog` domain (L3) — filesystem `ISkillDiscovery` backend.
 *
 * Discovers skill bundles by walking caller-supplied roots and parsing each
 * SKILL.md through `parser`. Provides the App-scoped filesystem backend for
 * `ISkillDiscovery` and the same stateless path for `PluginManager`'s standalone
 * API; other consumers stay filesystem-agnostic through the interface.
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import { ILogService, type LogPayload } from '#/_base/log/log';

import { SkillParseError, UnsupportedSkillTypeError, parseSkillText } from './parser';
import type { SkillDiscoveryResult, ISkillDiscovery } from './skillDiscovery';
import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

const MAX_SKILL_SCAN_DEPTH = 8;

export class FileSkillDiscovery implements ISkillDiscovery {
  declare readonly _serviceBrand: undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  async discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
    return discoverFileSkills(roots, (message, payload) => {
      this.log.warn(message, payload);
    });
  }
}

export async function discoverFileSkills(
  roots: readonly SkillRoot[],
  warn?: (message: string, payload?: LogPayload) => void,
): Promise<SkillDiscoveryResult> {
  const byDiscoveryKey = new Map<string, SkillDefinition>();
  const skipped: SkippedSkill[] = [];

  async function walkSkillDir(
    dirPath: string,
    root: SkillRoot,
    isTopLevel: boolean,
    depth: number,
    subSkillParentName?: string,
  ): Promise<void> {
    if (depth > MAX_SKILL_SCAN_DEPTH) return;

    let entries: readonly string[];
    try {
      entries = [...(await fs.readdir(dirPath))].toSorted();
    } catch {
      return;
    }

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      if (await isFile(path.join(entryPath, 'SKILL.md'))) {
        directorySkills.add(entry);
      }
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      if (await isDir(entryPath)) subdirs.push(entry);
    }

    const allowedSubSkillBundles = new Map<string, string>();
    for (const entry of directorySkills) {
      const skill = await parseAndRegister({
        byDiscoveryKey,
        skipped,
        warn,
        skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
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
        const rootSkillMd = path.join(dirPath, 'SKILL.md');
        if (await isFile(rootSkillMd)) {
          await parseAndRegister({
            byDiscoveryKey,
            skipped,
            warn,
            skillMdPath: rootSkillMd,
            skillDirName: path.basename(dirPath),
            root,
          });
        }
      }

      for (const entry of entries) {
        if (!entry.endsWith('.md')) continue;
        if (entry === 'SKILL.md') continue;
        const skillName = entry.slice(0, -'.md'.length);
        if (directorySkills.has(skillName)) continue;
        const skillMdPath = path.join(dirPath, entry);
        if (!(await isFile(skillMdPath))) continue;
        await parseAndRegister({
          byDiscoveryKey,
          skipped,
          warn,
          skillMdPath,
          skillDirName: skillName,
          root,
        });
      }
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      const allowedSubSkillParentName = allowedSubSkillBundles.get(entry);
      await walkSkillDir(
        path.join(dirPath, entry),
        root,
        false,
        depth + 1,
        allowedSubSkillParentName ?? subSkillParentName,
      );
    }
  }

  for (const root of roots) {
    await walkSkillDir(root.path, root, true, 0);
  }

  return {
    skills: sortSkills([...byDiscoveryKey.values()]),
    skipped,
    scannedRoots: roots.map((root) => root.path),
  };
}

async function parseAndRegister(input: {
  readonly byDiscoveryKey: Map<string, SkillDefinition>;
  readonly skipped: SkippedSkill[];
  readonly warn?: (message: string, payload?: LogPayload) => void;
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly subSkillParentName?: string;
}): Promise<SkillDefinition | undefined> {
  try {
    const text = await fs.readFile(input.skillMdPath, 'utf8');
    const parsed = parseSkillText({
      skillMdPath: input.skillMdPath,
      skillDirName: input.skillDirName,
      source: input.root.source,
      text,
    });
    const subSkillParentName = input.subSkillParentName;
    const skill =
      subSkillParentName !== undefined
        ? {
            ...parsed,
            name: qualifySubSkillName(subSkillParentName, parsed.name),
            metadata: {
              ...parsed.metadata,
              isSubSkill: true,
            },
          }
        : parsed;
    const discovered =
      input.root.plugin === undefined ? skill : { ...skill, plugin: input.root.plugin };
    const key = skillDiscoveryKey(input.root, discovered.name);
    if (!input.byDiscoveryKey.has(key)) {
      input.byDiscoveryKey.set(key, discovered);
    }
    return discovered;
  } catch (error) {
    if (error instanceof UnsupportedSkillTypeError) {
      input.skipped.push({
        path: input.skillMdPath,
        type: error.skillType,
        reason: `unsupported skill type "${error.skillType}"`,
      });
    } else if (error instanceof SkillParseError) {
      input.warn?.(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
    } else {
      input.warn?.(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
    }
    return undefined;
  }
}

function skillDiscoveryKey(root: SkillRoot, name: string): string {
  const normalizedName = normalizeSkillName(name);
  return root.plugin === undefined ? normalizedName : `${root.plugin.id}\0${normalizedName}`;
}

function sortSkills(skills: readonly SkillDefinition[]): readonly SkillDefinition[] {
  return [...skills].toSorted((a, b) => a.name.localeCompare(b.name));
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

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}
