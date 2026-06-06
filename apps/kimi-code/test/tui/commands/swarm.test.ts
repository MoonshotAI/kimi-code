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

interface TestComponent {
  render(width: number): string[];
}

function makeHost(
  overrides: {
    model?: string;
    hasSession?: boolean;
    permissionMode?: 'manual' | 'auto' | 'yolo';
    swarmMode?: boolean;
  } = {},
) {
  const session = {
    setPermission: vi.fn(async () => {}),
    setSwarmMode: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: overrides.model ?? 'kimi-model',
        permissionMode: overrides.permissionMode ?? 'auto',
        swarmMode: overrides.swarmMode ?? false,
      },
      theme: { colors: getColorPalette('dark') },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    sendNormalUserInput: vi.fn(),
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

function markerAddChild(host: SlashCommandHost): ReturnType<typeof vi.fn> {
  return host.state.transcriptContainer.addChild as ReturnType<typeof vi.fn>;
}

function expectSwarmMarker(host: SlashCommandHost, active: boolean): void {
  const components = markerAddChild(host).mock.calls.map(([component]) => component as TestComponent);
  const text = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(text).toContain(active ? 'Swarm activated' : 'Swarm deactivated');
}

describe('handleSwarmCommand', () => {
  it('sends the swarm prompt as a normal prompt after enabling swarm mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expectSwarmMarker(host, true);
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('sends the swarm prompt without re-entering swarm mode when already on', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', swarmMode: true });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expectSwarmMarker(host, true);
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('turns swarm mode on without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '' });

    await handleSwarmCommand(host, 'on');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expectSwarmMarker(host, true);
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode on when called without args while swarm mode is off', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: false });

    await handleSwarmCommand(host, '');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expectSwarmMarker(host, true);
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when swarm mode is already on', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, 'on');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ swarmMode: true });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Swarm mode is already on.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode off without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, 'off');

    expect(session.setSwarmMode).toHaveBeenCalledWith(false, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: false });
    expectSwarmMarker(host, false);
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode off when called without args while swarm mode is on', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, '');

    expect(session.setSwarmMode).toHaveBeenCalledWith(false, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: false });
    expectSwarmMarker(host, false);
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not call the session when swarm mode is already off', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: false });

    await handleSwarmCommand(host, 'off');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalledWith({ swarmMode: false });
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Swarm mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before starting a swarm task in Manual mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expectSwarmMarker(host, true);
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    const markerOrder = markerAddChild(host).mock.invocationCallOrder[0];
    const promptOrder = (host.mountEditorReplacement as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(markerOrder).toBeDefined();
    expect(promptOrder).toBeDefined();
    expect(markerOrder!).toBeLessThan(promptOrder!);
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    expect(text).toContain('Return to the input box with your swarm command');
  });

  it('defaults to Auto when confirming a Manual-mode swarm start', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSwarmMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expectSwarmMarker(host, true);
    expect(markerAddChild(host)).toHaveBeenCalledTimes(1);
  });

  it('can start a Manual-mode swarm task without changing permission', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSwarmMode).toHaveBeenCalledTimes(1);
    expectSwarmMarker(host, true);
    expect(markerAddChild(host)).toHaveBeenCalledTimes(1);
  });

  it('can switch to YOLO when starting a Manual-mode swarm task', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).toHaveBeenCalledWith('yolo');
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSwarmMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'yolo' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expectSwarmMarker(host, true);
    expect(markerAddChild(host)).toHaveBeenCalledTimes(1);
  });

  it('returns the command to the input box when a Manual-mode swarm start is cancelled', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/swarm Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Swarm task not started.');
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expectSwarmMarker(host, true);
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not start when permission update fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.setPermission.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to set permission mode'),
      );
    });
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expectSwarmMarker(host, true);
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not show the Manual-mode prompt when enabling swarm mode fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.setSwarmMode.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable swarm mode'),
    );
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send a prompt when enabling swarm mode fails', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });
    session.setSwarmMode.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable swarm mode'),
    );
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});
