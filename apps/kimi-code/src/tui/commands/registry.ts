import type { AutocompleteItem } from '@earendil-works/pi-tui';
import {
  getSlashCommandsForSurface,
  type SlashCommandDescriptor,
  type SlashCommandName,
} from '@moonshot-ai/acp-adapter';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import type { KimiSlashCommand, SlashCommandAvailability } from './types';

/** Subcommands offered when autocompleting `/goal <…>`. */
const GOAL_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'status', description: 'Show the current goal' },
  { value: 'pause', description: 'Pause the active goal' },
  { value: 'resume', description: 'Resume a paused goal' },
  { value: 'cancel', description: 'Cancel and remove the current goal' },
  { value: 'replace', description: 'Replace the current goal with a new objective' },
  { value: 'next', description: 'Queue an upcoming goal' },
];

const GOAL_NEXT_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'manage', description: 'Manage upcoming goals' },
];

const SWARM_ARG_COMPLETIONS: readonly ArgCompletionSpec[] = [
  { value: 'on', description: 'Turn swarm mode on' },
  { value: 'off', description: 'Turn swarm mode off' },
];

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(GOAL_NEXT_ARG_COMPLETIONS, nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(GOAL_ARG_COMPLETIONS, argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(SWARM_ARG_COMPLETIONS, argumentPrefix);
}

type TuiSlashCommandExtension = Pick<KimiSlashCommand, 'availability' | 'completeArgs' | 'experimentalFlag'>;

const TUI_SLASH_COMMAND_EXTENSIONS: Partial<Record<SlashCommandName, TuiSlashCommandExtension>> = {
  plan: {
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  swarm: {
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  goal: {
    // No argumentHint: the menu description stays as short as every other
    // command's. The subcommands (status/pause/resume/cancel/replace) surface in
    // the argument autocomplete list once the user types `/goal ` (see
    // completeArgs), so they don't need to be spelled out inline.
    completeArgs: goalArgumentCompletions,
    // status / pause / cancel are always available; creation, replacement, and
    // resume start (or restart) a turn and so are idle-only.
    availability: (args) => {
      const trimmed = args.trim();
      if (trimmed === 'next' || trimmed.startsWith('next ')) return 'always';
      return trimmed === '' || trimmed === 'status' || trimmed === 'pause' || trimmed === 'cancel'
        ? 'always'
        : 'idle-only';
    },
  },
};

function toKimiSlashCommand(command: SlashCommandDescriptor): KimiSlashCommand<SlashCommandName> {
  const extension = TUI_SLASH_COMMAND_EXTENSIONS[command.name as SlashCommandName];
  return {
    name: command.name as SlashCommandName,
    aliases: command.aliases ?? [],
    description: command.description,
    priority: command.priority,
    availability: extension?.availability ?? command.availability,
    ...(extension?.completeArgs ? { completeArgs: extension.completeArgs } : {}),
    ...(extension?.experimentalFlag ? { experimentalFlag: extension.experimentalFlag } : {}),
  };
}

export const BUILTIN_SLASH_COMMANDS: readonly KimiSlashCommand<SlashCommandName>[] = getSlashCommandsForSurface('tui').map((command) =>
  toKimiSlashCommand(command),
);

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly KimiSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

export function resolveSlashCommandAvailability(
  command: KimiSlashCommand,
  args: string,
): SlashCommandAvailability {
  const availability = command.availability ?? 'idle-only';
  return typeof availability === 'function' ? availability(args) : availability;
}

export function sortSlashCommands(commands: readonly KimiSlashCommand[]): KimiSlashCommand[] {
  return [...commands].toSorted(
    (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name),
  );
}
