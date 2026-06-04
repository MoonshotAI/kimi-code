import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { handleAddDirCommand, handleDirsCommand, handleRemoveDirCommand } from '#/tui/commands/session';
import { ChoicePickerComponent } from '#/tui/components/dialogs/choice-picker';
import { darkColors } from '#/tui/theme/colors';

function makeHost(overrides: object = {}): SlashCommandHost {
  const appState = {
    workDir: resolve('/workspace'),
    additionalWorkspaceDirs: [resolve('/extra')],
  };
  return {
    state: {
      appState,
      theme: { colors: darkColors },
    },
    session: {
      addDirectory: vi.fn(async (path: string) => ({ path, added: true })),
      removeDirectory: vi.fn(async (path: string) => ({ path, removed: true })),
    },
    showNotice: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    addWorkspaceDirectory: vi.fn(),
    removeWorkspaceDirectory: vi.fn(),
    ...overrides,
  } as unknown as SlashCommandHost;
}

describe('session directory slash commands', () => {
  it('shows the current session directories', () => {
    const host = makeHost();

    handleDirsCommand(host);

    expect(host.mountEditorReplacement).toHaveBeenCalledWith(expect.any(ChoicePickerComponent));
    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0] as ChoicePickerComponent;
    const output = picker.render(120).join('\n');
    expect(output).toContain('Primary workspace');
    expect(output).toContain('Extra 1');
    expect(output).toContain(resolve('/extra'));
  });

  it('closes /dirs after selecting a directory', () => {
    const host = makeHost();

    handleDirsCommand(host);
    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0] as ChoicePickerComponent;
    picker.handleInput('\r');

    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(`Directory: ${resolve('/workspace')}`);
  });

  it('opens a searchable picker when /add-dir has no argument', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'kimi-add-dir-picker-'));
    await mkdir(join(workDir, 'shared'));
    const host = makeHost({
      state: {
        appState: { workDir, additionalWorkspaceDirs: [] },
        theme: { colors: darkColors },
      },
    });

    await handleAddDirCommand(host, '');

    expect(host.mountEditorReplacement).toHaveBeenCalledWith(expect.any(ChoicePickerComponent));
  });

  it('removes the selected directory from the /remove-dir picker', async () => {
    const extra = resolve('/extra');
    const host = makeHost({
      state: {
        appState: { workDir: resolve('/workspace'), additionalWorkspaceDirs: [extra] },
        theme: { colors: darkColors },
      },
    });

    await handleRemoveDirCommand(host, '');
    const picker = vi.mocked(host.mountEditorReplacement).mock.calls[0]?.[0] as ChoicePickerComponent;
    picker.handleInput('\r');
    await Promise.resolve();

    expect(host.session!.removeDirectory).toHaveBeenCalledWith(extra);
    expect(host.removeWorkspaceDirectory).toHaveBeenCalledWith(extra);
  });
});
