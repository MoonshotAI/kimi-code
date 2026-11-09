import type { Session, SkillSummary } from '@moonshot-ai/kimi-code-sdk';

import type { KimiSlashCommand } from './types';

export type SkillListSession = Pick<Session, 'listSkills'>;

export interface SkillSlashCommands {
  readonly commands: readonly KimiSlashCommand[];
  readonly commandMap: ReadonlyMap<string, string>;
  readonly defaultPaths: ReadonlyMap<string, string>;
}

export function isUserActivatableSkill(skill: SkillSummary): boolean {
  return (
    skill.type === undefined ||
    skill.type === 'prompt' ||
    skill.type === 'inline' ||
    skill.type === 'flow'
  );
}

function isVisibleOnTui(skill: SkillSummary): boolean {
  return skill.scopes === undefined || skill.scopes.includes('tui');
}

function compareSkillSlashCommands(a: SkillSummary, b: SkillSummary): number {
  return (
    getSkillSlashCommandGroup(a.source) - getSkillSlashCommandGroup(b.source) ||
    a.name.localeCompare(b.name)
  );
}

function getSkillSlashCommandGroup(source: SkillSummary['source']): number {
  return source === 'builtin' ? 0 : 1;
}

export function skillSourceLabel(source: SkillSummary['source'] | undefined): string | undefined {
  if (source === 'builtin') return 'Built-in';
  if (source === 'user' || source === 'extra') return 'Global';
  return undefined;
}

export function buildSkillSlashCommands(skills: readonly SkillSummary[]): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const defaultPaths = new Map<string, string>();
  const defaultSkills = new Map<string, SkillSummary>();
  const sortedSkills = [...skills].toSorted(compareSkillSlashCommands);
  for (const skill of sortedSkills) {
    const commandName = skill.source === 'builtin' || skill.isSubSkill === true ? skill.name : `skill:${skill.name}`;
    if (!defaultSkills.has(commandName)) defaultSkills.set(commandName, skill);
  }
  const commands = sortedSkills.filter(isUserActivatableSkill).filter(isVisibleOnTui).map((skill) => {
    const commandName =
      skill.source === 'builtin' || skill.isSubSkill === true
        ? skill.name
        : `skill:${skill.name}`;
    if (!commandMap.has(commandName)) {
      commandMap.set(commandName, skill.name);
      if (defaultSkills.get(commandName) !== skill) defaultPaths.set(commandName, skill.path);
    }
    return {
      name: commandName,
      aliases: [],
      description: skill.description ?? '',
      skillPath: skill.path,
      skillSource: skill.source,
      isSkill: true,
      workspaceDir: skill.workspaceDir,
    };
  });
  return { commands, commandMap, defaultPaths };
}
