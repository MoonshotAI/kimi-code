import type { AvailableCommand } from '@agentclientprotocol/sdk';

/**
 * ACP-owned built-in slash commands. Recognized by slash detection (see
 * `./slash`) but not yet advertised in `available_commands_update` — in a
 * later phase they will be advertised and executed locally by the host rather
 * than forwarded to the model.
 */
export const ACP_BUILTIN_SLASH_COMMANDS = [
  {
    name: 'compact',
    description: 'Compact the conversation context',
    input: { hint: '<optional custom summarization instructions>' },
  },
  {
    name: 'status',
    description: 'Show current session status',
  },
  {
    name: 'usage',
    description: 'Show session token usage',
  },
  {
    name: 'mcp',
    description: 'Show MCP server status',
  },
  {
    name: 'tasks',
    description: 'List background tasks',
  },
  {
    name: 'help',
    description: 'Show available ACP commands',
  },
] as const satisfies readonly AvailableCommand[];

export type AcpBuiltinSlashCommandName = (typeof ACP_BUILTIN_SLASH_COMMANDS)[number]['name'];

export const ACP_BUILTIN_SLASH_COMMAND_NAMES = new Set<string>(
  ACP_BUILTIN_SLASH_COMMANDS.map((command) => command.name),
);

export function isAcpBuiltinSlashCommand(name: string): name is AcpBuiltinSlashCommandName {
  return ACP_BUILTIN_SLASH_COMMAND_NAMES.has(name);
}
