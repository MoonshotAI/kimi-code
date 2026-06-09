import type { AvailableCommand } from '@agentclientprotocol/sdk';

import {
  getSlashCommandsForSurface,
  slashCommandNamesForSurface,
  toAcpAvailableCommand,
} from './slash-command-registry.js';

export const ACP_BUILTIN_SLASH_COMMANDS = getSlashCommandsForSurface('acp').map((command) =>
  toAcpAvailableCommand(command),
) as readonly AvailableCommand[];

export type AcpBuiltinSlashCommandName = string;

export const ACP_BUILTIN_SLASH_COMMAND_NAMES = slashCommandNamesForSurface('acp');

export function isAcpBuiltinSlashCommand(name: string): name is AcpBuiltinSlashCommandName {
  return ACP_BUILTIN_SLASH_COMMAND_NAMES.has(name);
}
