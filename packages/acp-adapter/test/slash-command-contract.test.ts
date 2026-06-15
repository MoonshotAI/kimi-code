import { describe, expect, it } from 'vitest';

import {
  ACP_BUILTIN_SLASH_COMMANDS,
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
} from '../src/builtin-commands';
import {
  getSlashCommandsForSurface,
  slashCommandNamesForSurface,
  toAcpAvailableCommand,
} from '../src/slash-command-registry';

describe('ACP slash command contract', () => {
  it('derives advertised ACP commands from the shared slash registry', () => {
    expect(ACP_BUILTIN_SLASH_COMMANDS).toEqual(
      getSlashCommandsForSurface('acp').map((command) => toAcpAvailableCommand(command)),
    );
  });

  it('routes both ACP command names and aliases from the shared registry', () => {
    expect(ACP_BUILTIN_SLASH_COMMAND_NAMES).toEqual(slashCommandNamesForSurface('acp'));
    expect(ACP_BUILTIN_SLASH_COMMAND_NAMES.has('compact')).toBe(true);
    expect(ACP_BUILTIN_SLASH_COMMAND_NAMES.has('new')).toBe(true);
    expect(ACP_BUILTIN_SLASH_COMMAND_NAMES.has('clear')).toBe(true);
    expect(ACP_BUILTIN_SLASH_COMMAND_NAMES.has('yolo')).toBe(true);
  });
});
