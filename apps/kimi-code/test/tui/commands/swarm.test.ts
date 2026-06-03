import { describe, expect, it, vi } from 'vitest';

import { handleSwarmCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { getColorPalette } from '#/tui/theme/colors';

const ENTER = '\r';
const ESCAPE = '\u001B';
const DOWN = '\u001B[B';

function stripAnsi(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
  } = {},
) {
  const session = {
    setPermission: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-model',
        permissionMode: overrides.permissionMode ?? 'auto',
      },
      theme: { colors: getColorPalette('dark') },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendSwarmUserInput: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

interface TestPicker {
  handleInput(data: string): void;
  render(width: number): string[];
}

function mountedPicker(host: SlashCommandHost): TestPicker {
  const mock = host.mountEditorReplacement as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0]?.[0] as TestPicker;
}

describe('handleSwarmCommand', () => {
  it('sends the swarm prompt directly outside Manual mode', () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    handleSwarmCommand(host, 'Ship feature X');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendSwarmUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('asks before starting a swarm task in Manual mode', () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    handleSwarmCommand(host, 'Ship feature X');

    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendSwarmUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    expect(text).toContain('Return to the input box with your swarm command');
  });

  it('defaults to Auto when confirming a Manual-mode swarm start', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendSwarmUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
  });

  it('can start a Manual-mode swarm task without changing permission', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendSwarmUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).not.toHaveBeenCalled();
  });

  it('can switch to YOLO when starting a Manual-mode swarm task', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendSwarmUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
  });

  it('returns the command to the input box when a Manual-mode swarm start is cancelled', () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/swarm Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Swarm task not started.');
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendSwarmUserInput).not.toHaveBeenCalled();
  });

  it('does not start when permission update fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.setPermission.mockRejectedValueOnce(new Error('denied'));

    handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set permission mode'),
      );
    });
    expect(host.sendSwarmUserInput).not.toHaveBeenCalled();
  });
});
