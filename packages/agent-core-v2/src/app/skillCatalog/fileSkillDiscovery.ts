/**
 * `skillCatalog` domain (L3) — filesystem `ISkillDiscovery` backend.
 *
 * Discovers skill bundles by walking the caller-supplied skill roots on the
 * local filesystem and parsing each SKILL.md through `parser`. This is the only
 * file in the skill domain that imports `node:fs`; the rest of the domain
 * depends on the `ISkillDiscovery` interface and stays filesystem-agnostic.
 * Bound at App scope by the composition root (tests register the in-memory
 * backend instead).
 */

import { promises as fs } from 'node:fs';
import path from 'pathe';

import { ILogService } from '#/_base/log/log';

import { SkillParseError, UnsupportedSkillTypeError, parseSkillText } from './parser';
import type { SkillDiscoveryResult, ISkillDiscovery } from './skillDiscovery';
import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';
import { normalizeSkillName } from './types';

// Bounds recursion so a directory symlink cycle inside a skill root cannot
// loop forever. Real skill trees are 1-3 levels deep.
const MAX_SKILL_SCAN_DEPTH = 8;

export class FileSkillDiscovery implements ISkillDiscovery {
  declare readonly _serviceBrand: undefined;

  constructor(@ILogService private readonly log: ILogService) {}

  async discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
    return scanRoots(roots, this.log);
  }
}

async function scanRoots(
  roots: readonly SkillRoot[],
  log: ILogService,
): Promise<SkillDiscoveryResult> {
  const byName = new Map<string, SkillDefinition>();
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
      // Sorted so first-wins collision resolution across sibling directories
      // is deterministic rather than dependent on filesystem readdir order.
      entries = [...(await fs.readdir(dirPath))].toSorted();
    } catch {
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

    const allowedSubSkillBundles = new Map<string, string>();
    for (const entry of directorySkills) {
      const skill = await parseAndRegister({
        byName,
        skipped,
        log,
        skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
        skillDirName: entry,
        root,
        subSkillParentName,
      });
      if (skill !== undefined && hasSubSkillEnabled(skill)) {
        allowedSubSkillBundles.set(entry, skill.name);
      }
    }

    // Flat .md skills count only at a root's top level; deeper .md files are
    // skill payload (e.g. references/foo.md), not skills.
    if (isTopLevel) {
      // A SKILL.md placed directly at a plugin skill root (e.g. plugin root
      // fallback) is treated as a single skill bundle. This only applies to
      // plugin-derived roots, not to user/project skill directories.
      if (root.plugin !== undefined) {
        const rootSkillMd = path.join(dirPath, 'SKILL.md');
        if (await isFile(rootSkillMd)) {
          await parseAndRegister({
            byName,
            skipped,
            log,
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
          byName,
          skipped,
          log,
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
    skills: sortSkills([...byName.values()]),
    skipped,
    scannedRoots: roots.map((root) => root.path),
  };
}

async function parseAndRegister(input: {
  readonly byName: Map<string, SkillDefinition>;
  readonly skipped: SkippedSkill[];
  readonly log: ILogService;
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
    const key = normalizeSkillName(discovered.name);
    if (!input.byName.has(key)) {
      input.byName.set(key, discovered);
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
      input.log.warn(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
    } else {
      input.log.warn(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
    }
    return undefined;
  }
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
