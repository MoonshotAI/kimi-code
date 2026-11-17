import {
  findBuiltInSlashCommand,
  resolveSlashCommandAvailability,
  type BuiltinSlashCommand,
  type BuiltinSlashCommandName,
} from './registry';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { parseSlashInput } from './parse';
import type { TUIState } from '../tui-state';
import type { InlineSkillActivation } from '../types';
import { extractInlineSkillActivations, findInlineSkillTokens } from '../utils/inline-skill-tokens';
import type {
  KimiSlashCommand,
  ParsedSlashInput,
  SlashCommandBusyReason,
  SlashCommandInvalidReason,
} from './types';

export type SlashCommandIntent =
  | { readonly kind: 'not-command' }
  | {
      readonly kind: 'builtin';
      readonly command: BuiltinSlashCommand;
      readonly name: BuiltinSlashCommandName;
      readonly args: string;
      readonly enqueue?: boolean;
    }
  | {
      readonly kind: 'skill';
      readonly commandName: string;
      readonly skillName: string;
      readonly args: string;
    }
  | {
      readonly kind: 'plugin-command';
      readonly commandName: string;
      readonly pluginId: string;
      readonly args: string;
    }
  | { readonly kind: 'message'; readonly input: string }
  | {
      readonly kind: 'blocked';
      readonly commandName: string;
      readonly reason: SlashCommandBusyReason;
    }
  | {
      readonly kind: 'invalid';
      readonly commandName: string;
      readonly reason: SlashCommandInvalidReason;
    };

export interface ResolveSlashCommandInput {
  readonly input: string;
  readonly skillCommandMap: ReadonlyMap<string, string>;
  readonly pluginCommandMap: ReadonlyMap<string, string>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly skillVariantPathForCommand?: (commandName: string, tokenStart: number) => string | undefined;
  readonly defaultSkillPathForCommand?: (commandName: string) => string | undefined;
}

export function resolveSlashCommandInput(options: ResolveSlashCommandInput): SlashCommandIntent {
  const parsed = parseSlashInput(options.input);
  if (parsed === null) return { kind: 'not-command' };

  const command = findBuiltInSlashCommand(parsed.name);
  if (
    command !== undefined &&
    isExperimentalFlagEnabled((command as KimiSlashCommand).experimentalFlag)
  ) {
    const busyReason = slashCommandBusyReason(options);
    if (
      busyReason !== undefined &&
      resolveSlashCommandAvailability(command, parsed.args) === 'idle-only'
    ) {
      if (command.name === 'compact' && busyReason === 'streaming' && !options.isCompacting) {
        return {
          kind: 'builtin',
          command,
          name: command.name,
          args: parsed.args,
          enqueue: true,
        };
      }
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: command.name === 'compact' && options.isCompacting ? 'compacting' : busyReason,
      };
    }
    return {
      kind: 'builtin',
      command,
      name: command.name,
      args: parsed.args,
    };
  }

  const exactSkillName = options.skillCommandMap.get(parsed.name) ?? options.skillCommandMap.get(parsed.name.toLowerCase());
  if (exactSkillName !== undefined) {
    return skillCommandIntent(parsed, exactSkillName);
  }

  if (options.pluginCommandMap.has(parsed.name)) {
    const busyReason = slashCommandBusyReason(options);
    if (busyReason !== undefined) {
      return {
        kind: 'blocked',
        commandName: parsed.name,
        reason: busyReason,
      };
    }
    const separator = parsed.name.indexOf(':');
    const pluginId = separator === -1 ? parsed.name : parsed.name.slice(0, separator);
    const commandName = separator === -1 ? '' : parsed.name.slice(separator + 1);
    return {
      kind: 'plugin-command',
      commandName,
      pluginId,
      args: parsed.args.trim(),
    };
  }

  const shorthandSkillName = options.skillCommandMap.get(`skill:${parsed.name}`) ??
    options.skillCommandMap.get(`skill:${parsed.name.toLowerCase()}`);
  if (shorthandSkillName !== undefined) {
    return skillCommandIntent(parsed, shorthandSkillName);
  }

  return {
    kind: 'message',
    input: options.input,
  };
}

export function resolveUserInput(options: ResolveSlashCommandInput): {
  readonly intent: SlashCommandIntent;
  readonly activations: readonly InlineSkillActivation[];
} {
  const intent = resolveSlashCommandInput(options);
  if (
    intent.kind !== 'skill' &&
    intent.kind !== 'message' &&
    intent.kind !== 'not-command' &&
    !(intent.kind === 'builtin' && intent.name === 'btw')
  ) {
    return { intent, activations: [] };
  }
  const text = options.input;
  const selectedActivations = extractInlineSkillActivations(text, options.skillCommandMap, {
    includeLeading: true,
    skillVariantPathForCommand: options.skillVariantPathForCommand,
    defaultSkillPathForCommand: options.defaultSkillPathForCommand,
  }).filter((activation) => intent.kind !== 'builtin' || activation.start !== 0);
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (name) => resolveSkillCommand(options.skillCommandMap, name) !== undefined,
    includeLeading: true,
  });
  const token = tokens[0];
  if (selectedActivations.length === 1 && tokens.length === 1 && token?.start === 0) {
    if (intent.kind !== 'skill') return { intent, activations: [] };
    return {
      intent,
      activations: [{
        skillName: selectedActivations[0]!.skillName,
        path: selectedActivations[0]!.path,
        start: selectedActivations[0]!.start,
        args: text.slice(token.end).trim(),
      }],
    };
  }
  return { intent, activations: selectedActivations };
}

export function resolveSkillCommand(
  skillCommandMap: ReadonlyMap<string, string>,
  commandName: string,
): string | undefined {
  const normalized = commandName.toLowerCase();
  return skillCommandMap.get(commandName) ?? skillCommandMap.get(`skill:${commandName}`) ??
    skillCommandMap.get(normalized) ?? skillCommandMap.get(`skill:${normalized}`);
}

export function skillVariantPathsForInput(
  text: string,
  activations: readonly InlineSkillActivation[],
  skillCommandMap: ReadonlyMap<string, string>,
): Array<{ commandName: string; path: string; start: number }> {
  const tokens = findInlineSkillTokens(text, {
    isKnownSkill: (commandName) => resolveSkillCommand(skillCommandMap, commandName) !== undefined,
    includeLeading: true,
  });
  const claimed = new Set<number>();
  const selected: Array<{ commandName: string; path: string; start: number }> = [];
  for (const activation of activations) {
    if (activation.path === undefined) continue;
    const occurrences = activation.occurrences ?? [{ commandName: undefined, start: activation.start }];
    for (const occurrence of occurrences) {
      const token = tokens.find((candidate) =>
        !claimed.has(candidate.start) &&
        resolveSkillCommand(skillCommandMap, candidate.commandName) === activation.skillName &&
        (occurrence.commandName === undefined || candidate.commandName === occurrence.commandName) &&
        (occurrence.start === undefined || candidate.start === occurrence.start)
      );
      if (token !== undefined) {
        claimed.add(token.start);
        const commandName = token.commandName.startsWith('skill:') ? token.commandName : `skill:${token.commandName}`;
        selected.push({ commandName, path: activation.path, start: token.start });
      }
    }
  }
  return selected;
}

function skillCommandIntent(parsed: ParsedSlashInput, skillName: string): SlashCommandIntent {
  return {
    kind: 'skill',
    commandName: parsed.name,
    skillName,
    args: parsed.args.trim(),
  };
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

export function canRestoreSubmittedInput(host: { state: TUIState }): boolean {
  return host.state.editor.getText().length === 0 && !host.state.editorReplacementMounted;
}
