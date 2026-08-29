// Slash-command detection for ACP `session/prompt`.
//
// ACP only intercepts commands the host can answer directly: skills plus the
// small ACP-owned built-in command set. Other slash inputs classify as
// `unknown` and are answered locally with an "Unknown ACP command" notice
// (see `AcpSession.driveUnknownCommand`) — they never reach the model as
// prompt text. Non-slash input classifies as `passthrough` and does.

import { isUserActivatableSkillType, type SkillSummary } from '@moonshot-ai/agent-core-v2';

import {
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
  type AcpBuiltinSlashCommandName,
} from './builtin-commands';

export interface ParsedSlashInput {
  readonly name: string;
  readonly args: string;
}

export type SlashIntent =
  | { readonly kind: 'skill'; readonly skillName: string; readonly args: string }
  | { readonly kind: 'builtin'; readonly name: AcpBuiltinSlashCommandName; readonly args: string }
  | { readonly kind: 'unknown'; readonly name: string; readonly args: string }
  | { readonly kind: 'passthrough' };

export function parseSlashInput(input: string): ParsedSlashInput | null {
  if (!input.startsWith('/')) return null;
  const trimmed = input.slice(1).trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  if (name.includes('/')) return null;
  return { name, args };
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function detectSlashIntent(
  text: string,
  skillCommandMap: ReadonlyMap<string, string>,
  builtinCommandNames: ReadonlySet<string> = ACP_BUILTIN_SLASH_COMMAND_NAMES,
): SlashIntent {
  const parsed = parseSlashInput(text);
  if (parsed === null) return { kind: 'passthrough' };
  const skillName = resolveSkillCommand(skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    return { kind: 'skill', skillName, args: parsed.args };
  }
  if (builtinCommandNames.has(parsed.name)) {
    return { kind: 'builtin', name: parsed.name as AcpBuiltinSlashCommandName, args: parsed.args };
  }
  return { kind: 'unknown', name: parsed.name, args: parsed.args };
}

export interface SkillSlashCommands {
  readonly commands: ReadonlyArray<{ readonly name: string; readonly description: string }>;
  readonly commandMap: ReadonlyMap<string, string>;
}

/**
 * Project the session skill summaries into slash commands. Mirrors the TUI's
 * `buildSkillSlashCommands` (apps/kimi-code/src/tui/commands/skills.ts):
 * user-activatable skills only, builtin-source skills and sub-skills get the
 * bare name, everything else the `skill:` prefix, builtin-source group first.
 * One ACP-specific deviation: a skill whose command name collides with an ACP
 * builtin is dropped — the locally-executed builtin must always win (the
 * intent check consults the skill map first).
 */
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
