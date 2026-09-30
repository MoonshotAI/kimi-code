import {
  isUserActivatableSkillType,
  type SkillSummary,
} from '#/features/skill/index';

import { ACP_BUILTIN_SLASH_COMMAND_NAMES } from './builtin-commands';

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export interface SkillSlashCommands {
  readonly commands: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly commandMap: ReadonlyMap<string, string>;
}

export function buildAcpSkillSlashCommands(
  skills: readonly SkillSummary[],
  reservedNames: ReadonlySet<string> = ACP_BUILTIN_SLASH_COMMAND_NAMES,
): SkillSlashCommands {
  const commandMap = new Map<string, string>();
  const sorted = [...skills].toSorted(
    (a, b) =>
      (a.source === 'builtin' ? 0 : 1) - (b.source === 'builtin' ? 0 : 1) ||
      a.name.localeCompare(b.name),
  );
  const commands: Array<{ readonly name: string; readonly description: string }> = [];
  for (const skill of sorted) {
    if (!isUserActivatableSkillType(skill.type)) continue;
    const commandName =
      skill.source === 'builtin' || skill.isSubSkill === true
        ? skill.name
        : `skill:${skill.name}`;
    if (reservedNames.has(commandName)) continue;
    commandMap.set(commandName, skill.name);
    commands.push({ name: commandName, description: skill.description });
  }
  return { commands, commandMap };
}
