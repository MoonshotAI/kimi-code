import path from 'pathe';

import type { ILogService, LogPayload } from '#/_base/log/log';
import type { ISkillDiscovery, SkillDiscoveryResult } from '#/features/skill/catalog/skillDiscovery';
import { SkillParseError, UnsupportedSkillTypeError, parseSkillText } from '#/features/skill/catalog/parser';
import type { SkillDefinition, SkillRoot, SkippedSkill } from '#/features/skill/catalog/types';
import { normalizeSkillName } from '#/features/skill/catalog/types';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';

const MAX_SKILL_SCAN_DEPTH = 8;
const SKILL_SCAN_CONCURRENCY = 8;

interface SkillFileInput {
  readonly skillMdPath: string;
  readonly skillDirName: string;
  readonly root: SkillRoot;
  readonly subSkillParentName?: string;
}

export class EnvironmentSkillDiscovery implements ISkillDiscovery {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly log: ILogService,
    private readonly fs: IHostFileSystem,
  ) {}

  async discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
    return discoverEnvironmentSkills(this.fs, roots, (message, payload) => this.log.warn(message, payload));
  }
}

async function discoverEnvironmentSkills(
  fs: IHostFileSystem,
  roots: readonly SkillRoot[],
  warn?: (message: string, payload?: LogPayload) => void,
): Promise<SkillDiscoveryResult> {
  const byDiscoveryKey = new Map<string, SkillDefinition>();
  const skipped: SkippedSkill[] = [];
  const scannedDirectories: string[] = [];

  const register = async (
    input: SkillFileInput,
    content?: PromiseSettledResult<string>,
  ): Promise<SkillDefinition | undefined> => {
    try {
      if (content?.status === 'rejected') throw content.reason;
      const text = content?.status === 'fulfilled' ? content.value : await fs.readText(input.skillMdPath);
      const parsed = parseSkillText({
        skillMdPath: input.skillMdPath,
        skillDirName: input.skillDirName,
        source: input.root.source,
        text,
      });
      const skill = input.subSkillParentName === undefined
        ? parsed
        : {
            ...parsed,
            name: qualifySubSkillName(input.subSkillParentName, parsed.name),
            metadata: { ...parsed.metadata, isSubSkill: true },
          };
      const discovered = input.root.plugin === undefined ? skill : { ...skill, plugin: input.root.plugin };
      const key = input.root.plugin === undefined
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
        warn?.(`Skipping invalid skill at ${input.skillMdPath}: ${error.message}`, error);
      } else {
        warn?.(`Skipping skill at ${input.skillMdPath} due to unexpected error`, error);
      }
      return undefined;
    }
  };

  const registerAll = async (inputs: readonly SkillFileInput[]) => {
    const skills: (SkillDefinition | undefined)[] = [];
    for (let offset = 0; offset < inputs.length; offset += SKILL_SCAN_CONCURRENCY) {
      const batch = inputs.slice(offset, offset + SKILL_SCAN_CONCURRENCY);
      const contents = await Promise.allSettled(batch.map((input) => fs.readText(input.skillMdPath)));
      for (const [index, input] of batch.entries()) {
        skills.push(await register(input, contents[index]));
      }
    }
    return skills;
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
      const skillMdPath = path.join(dirPath, 'SKILL.md');
      if (await isFile(skillMdPath)) {
        await register({ skillMdPath, skillDirName: path.basename(dirPath), root });
      }
      return;
    }

    let entries;
    try {
      entries = [...await fs.readdir(dirPath)].toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } catch (error) {
      if (!isHostFsNotFound(error) && !isHostFsNotDirectory(error)) {
        warn?.(`Unable to scan skills in ${dirPath}`, error);
      }
      return;
    }
    scannedDirectories.push(dirPath);

    const directorySkills = new Set<string>();
    const subdirs: string[] = [];
    for (let offset = 0; offset < entries.length; offset += SKILL_SCAN_CONCURRENCY) {
      const batch = await Promise.all(entries.slice(offset, offset + SKILL_SCAN_CONCURRENCY).map(async (entry) => {
        const entryPath = path.join(dirPath, entry.name);
        const directory = entry.isDirectory || (entry.isSymbolicLink === true && await isDirectory(entryPath));
        const skill = directory && await isFile(path.join(entryPath, 'SKILL.md'));
        return { entry, directory, skill };
      }));
      for (const { entry, directory, skill } of batch) {
        if (skill) directorySkills.add(entry.name);
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (directory) subdirs.push(entry.name);
      }
    }

    const allowedSubSkillBundles = new Map<string, string>();
    const skillNames = [...directorySkills];
    const skills = await registerAll(skillNames.map((entry) => ({
      skillMdPath: path.join(dirPath, entry, 'SKILL.md'),
      skillDirName: entry,
      root,
      subSkillParentName,
    })));
    for (const [index, entry] of skillNames.entries()) {
      const skill = skills[index];
      if (skill !== undefined && hasSubSkillEnabled(skill)) {
        allowedSubSkillBundles.set(entry, skill.name);
      }
    }

    if (isTopLevel) {
      if (root.plugin !== undefined) {
        const skillMdPath = path.join(dirPath, 'SKILL.md');
        if (await isFile(skillMdPath)) {
          await register({ skillMdPath, skillDirName: path.basename(dirPath), root });
        }
      }
      await registerAll(entries
        .filter((entry) => entry.isFile && entry.name.endsWith('.md') && entry.name !== 'SKILL.md' &&
          !directorySkills.has(entry.name.slice(0, -'.md'.length)))
        .map((entry) => ({
          skillMdPath: path.join(dirPath, entry.name),
          skillDirName: entry.name.slice(0, -'.md'.length),
          root,
        })));
    }

    for (const entry of subdirs) {
      if (directorySkills.has(entry) && !allowedSubSkillBundles.has(entry)) continue;
      await walk(
        path.join(dirPath, entry),
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
  const nestedFlag = typeof nested === 'object' && nested !== null
    ? (nested as Record<string, unknown>)['has-sub-skill'] === true ||
      (nested as Record<string, unknown>)['hasSubSkill'] === true
    : false;
  return skill.metadata['has-sub-skill'] === true || skill.metadata['hasSubSkill'] === true || nestedFlag;
}
