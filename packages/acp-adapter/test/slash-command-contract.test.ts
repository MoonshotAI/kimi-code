import { describe, expect, it } from 'vitest';

import {
  ACP_BUILTIN_SLASH_COMMANDS,
  ACP_BUILTIN_SLASH_COMMAND_NAMES,
} from '../src/builtin-commands';
import {
  SLASH_COMMAND_REGISTRY,
  findSlashCommand,
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

  it('keeps TUI-only workspace commands on the tui surface', () => {
    const tuiNames = slashCommandNamesForSurface('tui');
    expect(tuiNames.has('add-dir')).toBe(true);
    expect(tuiNames.has('web')).toBe(true);

    const acpNames = slashCommandNamesForSurface('acp');
    expect(acpNames.has('add-dir')).toBe(false);
    expect(acpNames.has('web')).toBe(false);
  });

  it('preserves argument hints on the shared descriptor', () => {
    const addDir = findSlashCommand('add-dir');
    expect(addDir?.argumentHint).toBe('[list] | <path>');

    // Sanity: every descriptor stays structurally valid.
    for (const command of SLASH_COMMAND_REGISTRY) {
      expect(command.surfaces.length).toBeGreaterThan(0);
    }
  });
});
