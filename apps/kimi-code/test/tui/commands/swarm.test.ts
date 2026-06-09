import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleSwarmCommand, handleUltraModeCommand } from '#/tui/commands/index';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { currentTheme } from '#/tui/theme';

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
    swarmModeEntry?: 'manual' | 'task' | 'ultra' | 'ultra_task';
    swarmModeRestoreEntry?: 'manual' | 'ultra';
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
      swarmModeEntry: overrides.swarmModeEntry,
      swarmModeRestoreEntry: overrides.swarmModeRestoreEntry,
      theme: currentTheme,
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

function expectSwarmMarker(host: SlashCommandHost, text: string): void {
  const components = markerAddChild(host).mock.calls.map(([component]) => component as TestComponent);
  const rendered = stripAnsi(components.at(-1)?.render(80).join('\n') ?? '');
  expect(rendered).toContain(text);
}

describe('handleSwarmCommand', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('sends the swarm prompt as a normal prompt after enabling swarm mode', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('sends the swarm prompt without re-entering swarm mode when already on', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto', swarmMode: true });

    await handleSwarmCommand(host, 'Ship feature X');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('turns swarm mode on without sending a prompt', async () => {
    const { host, session } = makeHost({ model: '' });

    await handleSwarmCommand(host, 'on');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('asks before turning swarm mode on in Manual mode', async () => {
    const { host, session } = makeHost({ model: '', permissionMode: 'manual' });

    await handleSwarmCommand(host, 'on');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'manual');
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSwarmMode).toHaveBeenCalledTimes(1);
    expect(host.setAppState).toHaveBeenCalledWith({ permissionMode: 'auto' });
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode on when called without args while swarm mode is off', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: false });

    await handleSwarmCommand(host, '');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: true });
    expect(host.state.swarmModeEntry).toBe('manual');
    expectSwarmMarker(host, 'Swarm activated');
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
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm deactivated');
    expect(host.showStatus).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('turns swarm mode off when called without args while swarm mode is on', async () => {
    const { host, session } = makeHost({ model: '', swarmMode: true });

    await handleSwarmCommand(host, '');

    expect(session.setSwarmMode).toHaveBeenCalledWith(false, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ swarmMode: false });
    expect(host.state.swarmModeEntry).toBeUndefined();
    expectSwarmMarker(host, 'Swarm deactivated');
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

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    const text = stripAnsi(mountedPicker(host).render(80).join('\n'));
    expect(text).toContain('Manual mode can block swarm work');
    expect(text).not.toContain('Switch to YOLO and start');
    expect(text).not.toContain('Do not start');
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
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
  });

  it('can start a Manual-mode swarm task without changing permission', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    const picker = mountedPicker(host);
    picker.handleInput(DOWN);
    picker.handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
    });
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(session.setSwarmMode).toHaveBeenCalledTimes(1);
    expect(host.state.swarmModeEntry).toBe('task');
    expectSwarmMarker(host, 'Swarm activated');
  });

  it('returns the command to the input box when a Manual-mode swarm start is cancelled', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ESCAPE);

    expect(host.restoreInputText).toHaveBeenCalledWith('/swarm Ship feature X');
    expect(host.showStatus).toHaveBeenCalledWith('Swarm task not started.');
    expect(session.setPermission).not.toHaveBeenCalled();
    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
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
    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not send from Manual mode when enabling swarm mode fails after confirmation', async () => {
    const { host, session } = makeHost({ permissionMode: 'manual' });
    session.setSwarmMode.mockRejectedValueOnce(new Error('denied'));

    await handleSwarmCommand(host, 'Ship feature X');
    mountedPicker(host).handleInput(ENTER);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to enable swarm mode'),
      );
    });
    expect(session.setPermission).toHaveBeenCalledWith('auto');
    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'task');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
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

  it('rejects /swarm ultra when the Ultra swarm experiment is disabled', async () => {
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleSwarmCommand(host, 'ultra Ship feature X');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('Ultra swarm is experimental'));
    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('starts an Ultra swarm task through /swarm ultra', async () => {
    setExperimentalFeatures([{ id: 'ultra_swarm', enabled: true }]);
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleSwarmCommand(host, 'ultra Ship feature X');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'ultra_task');
    expect(host.state.swarmModeEntry).toBe('ultra_task');
    expectSwarmMarker(host, 'Ultra swarm activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('starts an Ultra swarm task through /ultramode', async () => {
    setExperimentalFeatures([{ id: 'ultra_swarm', enabled: true }]);
    const { host, session } = makeHost({ permissionMode: 'auto' });

    await handleUltraModeCommand(host, 'Ship feature X');

    expect(session.setSwarmMode).toHaveBeenCalledWith(true, 'ultra_task');
    expect(host.state.swarmModeEntry).toBe('ultra_task');
    expectSwarmMarker(host, 'Ultra swarm activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('records persistent swarm restoration after a one-shot Ultra task', async () => {
    setExperimentalFeatures([{ id: 'ultra_swarm', enabled: true }]);
    const { host, session } = makeHost({
      permissionMode: 'auto',
      swarmMode: true,
      swarmModeEntry: 'manual',
    });

    await handleUltraModeCommand(host, 'Ship feature X');

    expect(session.setSwarmMode).toHaveBeenNthCalledWith(1, false, 'manual');
    expect(session.setSwarmMode).toHaveBeenNthCalledWith(2, true, 'ultra_task');
    expect(host.state.swarmModeEntry).toBe('ultra_task');
    expect(host.state.swarmModeRestoreEntry).toBe('manual');
    expectSwarmMarker(host, 'Ultra swarm activated');
    expect(host.sendNormalUserInput).toHaveBeenCalledWith('Ship feature X');
  });

  it('switches an active regular swarm session to persistent Ultra swarm mode', async () => {
    setExperimentalFeatures([{ id: 'ultra_swarm', enabled: true }]);
    const { host, session } = makeHost({
      permissionMode: 'auto',
      swarmMode: true,
      swarmModeEntry: 'manual',
    });

    await handleUltraModeCommand(host, 'on');

    expect(session.setSwarmMode).toHaveBeenNthCalledWith(1, false, 'manual');
    expect(session.setSwarmMode).toHaveBeenNthCalledWith(2, true, 'ultra');
    expect(host.state.swarmModeEntry).toBe('ultra');
    expect(host.state.swarmModeRestoreEntry).toBeUndefined();
    expectSwarmMarker(host, 'Ultra swarm activated');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });

  it('does not disable regular swarm mode when /ultramode off is used while Ultra is already off', async () => {
    setExperimentalFeatures([{ id: 'ultra_swarm', enabled: true }]);
    const { host, session } = makeHost({
      permissionMode: 'auto',
      swarmMode: true,
      swarmModeEntry: 'manual',
    });

    await handleUltraModeCommand(host, 'off');

    expect(session.setSwarmMode).not.toHaveBeenCalled();
    expect(host.state.appState.swarmMode).toBe(true);
    expect(host.state.swarmModeEntry).toBe('manual');
    expect(markerAddChild(host)).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Ultra swarm mode is already off.');
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
  });
});
