import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommand,
  type BuiltinSlashCommandName,
} from './registry';
import { parseSlashInput } from './parse';
import type { SlashCommandBusyReason } from './types';

export type SlashCommandIntent =
  | { readonly kind: 'not-command' }
  | {
      readonly kind: 'builtin';
      readonly command: BuiltinSlashCommand;
      readonly name: BuiltinSlashCommandName;
      readonly args: string;
    }
  | {
      readonly kind: 'skill';
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | { readonly kind: 'message'; readonly input: string }
  | {
      readonly kind: 'blocked';
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    };

export interface ResolveSlashCommandInput {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
}

export function resolveSlashCommandInput(options: ResolveSlashCommandInput): SlashCommandIntent {
  const parsed = parseSlashInput(options.input);
  if (parsed === null) return { kind: 'not-command' };

  const command = findBuiltInSlashCommand(parsed.name);
  if (command !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (
      busyReason !== undefined &&
      resolveSlashCommandAvailability(command, parsed.args) === 'idle-only'
    ) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: 'builtin',
      command,
      name: command.name,
      args: parsed.args,
    };
  }

  const skillName = resolveSkillCommand(options.skillCommandMap, parsed.name);
  if (skillName !== undefined) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    return {
      kind: 'skill',
      commandName: parsed.name,
      skillName,
      args: parsed.args.trim(),
    };
  }

  return {
    kind: 'message',
    input: options.input,
  };
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`);
}

export function slashCommandBusyReason(
  options: Pick<ResolveSlashCommandInput, 'isStreaming' | 'isCompacting'>,
): SlashCommandBusyReason | undefined {
  if (options.isStreaming) return 'streaming';
  if (options.isCompacting) return 'compacting';
  return undefined;
}

export function slashBusyMessage(
  commandName: string,
  reason: SlashCommandBusyReason,
): string {
  if (reason === 'streaming') {
    return `Cannot /${commandName} while streaming — press Esc or Ctrl-C first.`;
  }
  return `Cannot /${commandName} while compacting — wait for compaction to finish first.`;
}
