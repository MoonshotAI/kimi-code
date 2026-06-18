import type { AutocompleteItem } from '@earendil-works/pi-tui';

import { i18n } from '#/tui/i18n';

import { completeLeadingArg, type ArgCompletionSpec } from './complete-args';
import type { KimiSlashCommand, SlashCommandAvailability } from './types';

/**
 * Subcommand argument-completion specs, built at call time so descriptions
 * follow the active locale. `value` is an identifier and stays untranslated;
 * only `description` is localized via `commands.args.*`.
 */
function goalArgCompletions(): ArgCompletionSpec[] {
  return ['status', 'pause', 'resume', 'cancel', 'replace', 'next'].map((value) => ({
    value,
    description: i18n.t(`commands.args.goal.${value}`),
  }));
}

function goalNextArgCompletions(): ArgCompletionSpec[] {
  return [{ value: 'manage', description: i18n.t('commands.args.goal.manage') }];
}

function swarmArgCompletions(): ArgCompletionSpec[] {
  return ['on', 'off'].map((value) => ({
    value,
    description: i18n.t(`commands.args.swarm.${value}`),
  }));
}

/** Argument autocompletion for the `/goal` command (subcommands). */
export function goalArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const nextMatch = argumentPrefix.match(/^next\s+(\S*)$/i);
  if (nextMatch !== null) {
    return (
      completeLeadingArg(goalNextArgCompletions(), nextMatch[1] ?? '')?.map((item) => ({
        ...item,
        value: `next ${item.value}`,
      })) ?? null
    );
  }
  return completeLeadingArg(goalArgCompletions(), argumentPrefix);
}

/** Argument autocompletion for the `/swarm` command (subcommands). */
export function swarmArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  return completeLeadingArg(swarmArgCompletions(), argumentPrefix);
}

export const BUILTIN_SLASH_COMMANDS = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description: 'Toggle auto-approve mode',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Toggle auto permission mode',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'permission',
    aliases: [],
    description: 'Select permission mode',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: 'Open TUI settings',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Toggle plan mode',
    priority: 100,
    availability: (args) => (args.trim().toLowerCase() === 'clear' ? 'idle-only' : 'always'),
  },
  {
    name: 'swarm',
    aliases: [],
    description: 'Toggle swarm mode or run one task in swarm mode',
    priority: 100,
    completeArgs: swarmArgumentCompletions,
    availability: 'idle-only',
  },
  {
    name: 'model',
    aliases: [],
    description: 'Switch LLM model',
    priority: 100,
    availability: 'always',
  },
  {
    name: 'provider',
    aliases: ['providers'],
    description: 'Manage AI providers (add / delete / refresh)',
    priority: 95,
    availability: 'always',
  },
  {
    name: 'btw',
    aliases: [],
    description: 'Ask a forked side agent a question',
    priority: 90,
    availability: 'always',
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and shortcuts',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Start a fresh session in the current workspace',
    priority: 80,
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'Browse and resume sessions',
    priority: 80,
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'Browse background tasks',
    priority: 80,
    availability: 'always',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'Show MCP server status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'plugins',
    aliases: [],
    description: 'Manage plugins',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    description: 'Manage experimental features',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload',
    aliases: [],
    description: 'Reload session and apply config.toml settings plus tui.toml UI preferences',
    priority: 60,
    availability: 'idle-only',
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: 'Reload only tui.toml UI preferences',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Compact the conversation context',
    priority: 80,
  },
  {
    name: 'goal',
    aliases: [],
    description: 'Start or manage an autonomous goal',
    priority: 80,
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
  {
    name: 'init',
    aliases: [],
    description: 'Analyze the codebase and generate AGENTS.md',
  },
  {
    name: 'fork',
    aliases: [],
    description: 'Fork the current session',
    priority: 80,
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'Set or show session title',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'usage',
    aliases: [],
    description: 'Show session tokens + context window + plan quotas',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'status',
    aliases: [],
    description: 'Show current session and runtime status',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'feedback',
    aliases: [],
    description: 'Send feedback to make Kimi Code better',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'undo',
    aliases: [],
    description: 'Withdraw the last prompt from the transcript',
    priority: 80,
    availability: 'idle-only',
  },
  {
    name: 'editor',
    aliases: [],
    description: 'Set the external editor for Ctrl-G',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'theme',
    aliases: [],
    description: 'Set the terminal UI theme',
    priority: 60,
    availability: 'always',
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'Log out of a configured provider',
    priority: 40,
  },
  {
    name: 'login',
    aliases: [],
    description: 'Select a platform and authenticate',
    priority: 40,
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'Export current session as a Markdown file',
    priority: 40,
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'Export current session as a debug ZIP archive',
    priority: 40,
  },
  {
    name: 'web',
    aliases: [],
    description: 'Open the current session in the Web UI and exit the terminal',
    priority: 40,
    availability: 'always',
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the application',
    priority: 20,
  },
  {
    name: 'version',
    aliases: [],
    description: 'Show version information',
    priority: 20,
    availability: 'always',
  },
] as const satisfies readonly KimiSlashCommand[];

export type BuiltinSlashCommand = (typeof BUILTIN_SLASH_COMMANDS)[number];
export type BuiltinSlashCommandName = BuiltinSlashCommand['name'];

export function findBuiltInSlashCommand(commandName: string): BuiltinSlashCommand | undefined {
  const commands = BUILTIN_SLASH_COMMANDS as readonly KimiSlashCommand<BuiltinSlashCommandName>[];
  return commands.find(
    (command) => command.name === commandName || command.aliases.includes(commandName),
  ) as BuiltinSlashCommand | undefined;
}

/**
 * Builtin commands with their `description` resolved for the active locale.
 *
 * The static `description` strings on `BUILTIN_SLASH_COMMANDS` are the English
 * source of truth; display surfaces (autocomplete + the `/help` panel) call
 * this so the description follows `i18n.setLocale(...)` at render time, exactly
 * as components call `i18n.t(...)`. Command names / aliases are identifiers and
 * are never translated. Skill-provided commands keep their own descriptions —
 * only the framework's own builtins are localized here.
 */
export function localizedBuiltinSlashCommands(): readonly KimiSlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.map((command) => ({
    ...command,
    description: i18n.t(`commands.descriptions.${command.name}`),
  }));
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
