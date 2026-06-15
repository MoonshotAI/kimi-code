export type SlashCommandSurface = 'tui' | 'acp';

export type SlashCommandAvailability = 'always' | 'idle-only';

export interface SlashCommandInputHint {
  readonly hint: string;
}

export interface SlashCommandDescriptor {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly group?: string;
  readonly priority?: number;
  readonly argumentHint?: string;
  readonly input?: SlashCommandInputHint;
  readonly availability?: SlashCommandAvailability;
  readonly surfaces: readonly SlashCommandSurface[];
}

export const SLASH_COMMAND_REGISTRY = [
  {
    name: 'yolo',
    aliases: ['yes'],
    description: 'Toggle auto-approve mode',
    priority: 100,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'auto',
    aliases: [],
    description: 'Toggle auto permission mode',
    priority: 100,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'permission',
    aliases: [],
    description: 'Select permission mode',
    priority: 100,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'settings',
    aliases: ['config'],
    description: 'Open TUI settings',
    priority: 100,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'plan',
    aliases: [],
    description: 'Toggle plan mode',
    priority: 100,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'swarm',
    aliases: [],
    description: 'Toggle swarm mode or run one task in swarm mode',
    priority: 100,
    availability: 'idle-only',
    surfaces: ['tui'],
  },
  {
    name: 'model',
    aliases: [],
    description: 'Switch LLM model',
    priority: 100,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'provider',
    aliases: ['providers'],
    description: 'Manage AI providers (add / delete / refresh)',
    priority: 95,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'btw',
    aliases: [],
    description: 'Ask a forked side agent a question',
    priority: 90,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show available commands and shortcuts',
    priority: 80,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Start a fresh session in the current workspace',
    priority: 80,
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'Browse and resume sessions',
    priority: 80,
    surfaces: ['tui'],
  },
  {
    name: 'tasks',
    aliases: ['task'],
    description: 'Browse background tasks',
    priority: 80,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'Show MCP server status',
    priority: 60,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'plugins',
    aliases: [],
    description: 'Manage plugins',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'experiments',
    aliases: ['experimental'],
    description: 'Manage experimental features',
    priority: 60,
    availability: 'idle-only',
    surfaces: ['tui'],
  },
  {
    name: 'reload',
    aliases: [],
    description: 'Reload session and apply config.toml settings plus tui.toml UI preferences',
    priority: 60,
    availability: 'idle-only',
    surfaces: ['tui'],
  },
  {
    name: 'reload-tui',
    aliases: [],
    description: 'Reload only tui.toml UI preferences',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Compact the conversation context',
    priority: 80,
    input: { hint: '<optional custom summarization instructions>' },
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'goal',
    aliases: [],
    description: 'Start or manage an autonomous goal',
    priority: 80,
    surfaces: ['tui'],
  },
  {
    name: 'init',
    aliases: [],
    description: 'Analyze the codebase and generate AGENTS.md',
    surfaces: ['tui'],
  },
  {
    name: 'fork',
    aliases: [],
    description: 'Fork the current session',
    priority: 80,
    surfaces: ['tui'],
  },
  {
    name: 'title',
    aliases: ['rename'],
    description: 'Set or show session title',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'usage',
    aliases: [],
    description: 'Show session tokens + context window + plan quotas',
    priority: 60,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'status',
    aliases: [],
    description: 'Show current session and runtime status',
    priority: 60,
    availability: 'always',
    surfaces: ['tui', 'acp'],
  },
  {
    name: 'feedback',
    aliases: [],
    description: 'Send feedback to make Kimi Code better',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'undo',
    aliases: [],
    description: 'Withdraw the last prompt from the transcript',
    priority: 80,
    availability: 'idle-only',
    surfaces: ['tui'],
  },
  {
    name: 'editor',
    aliases: [],
    description: 'Set the external editor for Ctrl-G',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'theme',
    aliases: [],
    description: 'Set the terminal UI theme',
    priority: 60,
    availability: 'always',
    surfaces: ['tui'],
  },
  {
    name: 'logout',
    aliases: ['disconnect'],
    description: 'Log out of a configured provider',
    priority: 40,
    surfaces: ['tui'],
  },
  {
    name: 'login',
    aliases: [],
    description: 'Select a platform and authenticate',
    priority: 40,
    surfaces: ['tui'],
  },
  {
    name: 'export-md',
    aliases: ['export'],
    description: 'Export current session as a Markdown file',
    priority: 40,
    surfaces: ['tui'],
  },
  {
    name: 'export-debug-zip',
    aliases: [],
    description: 'Export current session as a debug ZIP archive',
    priority: 40,
    surfaces: ['tui'],
  },
  {
    name: 'exit',
    aliases: ['quit', 'q'],
    description: 'Exit the application',
    priority: 20,
    surfaces: ['tui'],
  },
  {
    name: 'version',
    aliases: [],
    description: 'Show version information',
    priority: 20,
    availability: 'always',
    surfaces: ['tui'],
  },
] as const satisfies readonly SlashCommandDescriptor[];

export type SlashCommandName = (typeof SLASH_COMMAND_REGISTRY)[number]['name'];
export type SlashCommandAlias = (typeof SLASH_COMMAND_REGISTRY)[number]['aliases'];
export type SlashCommandNameOrAlias = SlashCommandName | SlashCommandAlias[number];

export function getSlashCommandsForSurface(surface: SlashCommandSurface): readonly SlashCommandDescriptor[] {
  return SLASH_COMMAND_REGISTRY.filter((command) => (command.surfaces as readonly SlashCommandSurface[]).includes(surface));
}

export function findSlashCommand(commandName: string): SlashCommandDescriptor | undefined {
  return SLASH_COMMAND_REGISTRY.find(
    (command) => command.name === commandName || (command.aliases as readonly string[] | undefined)?.includes(commandName),
  );
}

export function slashCommandNamesForSurface(surface: SlashCommandSurface): Set<string> {
  const names = new Set<string>();
  for (const command of getSlashCommandsForSurface(surface)) {
    names.add(command.name);
    for (const alias of command.aliases ?? []) {
      names.add(alias);
    }
  }
  return names;
}

export function toAcpAvailableCommand(command: SlashCommandDescriptor): {
  name: string;
  description: string;
  input?: { hint: string };
} {
  return {
    name: command.name,
    description: command.description,
    ...(command.input ? { input: { hint: command.input.hint } } : {}),
  };
}
