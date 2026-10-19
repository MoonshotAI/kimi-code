import { describe, expect, it, vi } from 'vitest';

import { applyTuiModeChoice } from '#/tui/commands/config';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

function makeHost(
  tuiMode: 'regular' | 'fullscreen',
  runningMode: 'regular' | 'fullscreen' = 'regular',
) {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        tuiMode,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
      },
      ui: { mode: runningMode },
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
  };
}

describe('tui mode preference commands', () => {
  it('saves fullscreen to tui.toml, mirrors appState, and notices the required restart', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'fullscreen' });
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to fullscreen.', 'success');
    expect(host.showNotice).toHaveBeenCalledWith(
      'TUI mode takes effect after restarting Kimi Code.',
    );
  });

  it('skips the restart notice when switching back to the running mode', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('fullscreen', 'regular');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'regular' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'regular' });
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('does not rewrite the config when the value is unchanged', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('regular');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode already regular.');
  });

  it('reports a save failure without touching appState', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost('regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Failed to save TUI mode: disk full', 'error');
  });
});
