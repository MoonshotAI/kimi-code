import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCopyOnSelectChoice, applyTuiModeChoice } from '#/tui/commands/config';
import { TUI_MODE_SWITCH_BLOCKED_NOTICE } from '#/tui/constant/kimi-tui';
import type { TuiMode } from '#/tui/config';
import type { TuiModeSwitchResult } from '#/tui/tui-renderer';

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
  tuiMode: 'regular' | 'fullscreen' | undefined,
  runningMode: 'regular' | 'fullscreen' = 'regular',
  switchResult?: TuiModeSwitchResult,
) {
  const ui = { mode: runningMode };
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        tuiMode,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        transcript: { toolCallDensity: 'compact' as const, thinking: 'grouped' as const },
      },
      ui,
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    switchTuiMode: vi.fn((mode: TuiMode): TuiModeSwitchResult => {
      if (switchResult !== undefined) return switchResult;
      if (mode === ui.mode) return { status: 'unchanged', mode };
      const from = ui.mode;
      ui.mode = mode;
      return { status: 'switched', from, to: mode };
    }),
    track: vi.fn(),
  };
}

describe('tui mode preference commands', () => {
  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '');
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '');
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('TERMUX_VERSION', '');
    vi.stubEnv('TMUX', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('saves fullscreen to tui.toml, mirrors appState, tracks switch, and switches live without restart notice', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'fullscreen' });
    expect(host.track).toHaveBeenCalledWith('tui_mode_switch', { tui_mode: 'fullscreen' });
    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to fullscreen.', 'success');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('persists regular and switches live when moving away from a default fullscreen session', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'fullscreen');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'regular' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'regular' });
    expect(host.track).toHaveBeenCalledWith('tui_mode_switch', { tui_mode: 'regular' });
    expect(host.switchTuiMode).toHaveBeenCalledWith('regular');
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to regular.', 'success');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('saves config and shows the blocked notice when live switching is blocked', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular', { status: 'blocked', reason: 'active-overlay' });

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'fullscreen' });
    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to fullscreen.', 'success');
    expect(host.showNotice).toHaveBeenCalledWith(TUI_MODE_SWITCH_BLOCKED_NOTICE);
  });

  it('retries live switching without rewriting tui.toml when reselecting an already-saved mode that differs from runtime', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('fullscreen', 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.showStatus).toHaveBeenCalledWith('Switched TUI mode to fullscreen.', 'success');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('shows the blocked notice when retrying an already-saved mode is still blocked', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('fullscreen', 'regular', {
      status: 'blocked',
      reason: 'screen-takeover',
    });

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.switchTuiMode).toHaveBeenCalledWith('fullscreen');
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode already fullscreen.');
    expect(host.showNotice).toHaveBeenCalledWith(TUI_MODE_SWITCH_BLOCKED_NOTICE);
  });

  it('skips notices when switching config back to the running mode', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('fullscreen', 'regular');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'regular' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'regular' });
    expect(host.switchTuiMode).toHaveBeenCalledWith('regular');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('persists an explicit selection that matches the active runtime mode when tui_mode was unset', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'fullscreen');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'fullscreen' });
    expect(host.track).toHaveBeenCalledWith('tui_mode_switch', { tui_mode: 'fullscreen' });
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to fullscreen.', 'success');
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('does not rewrite the config when the selected mode already matches explicit appState.tuiMode', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('regular', 'regular');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode already regular.');
  });

  it('explains an active env override when reselecting an explicitly saved mode', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '1');
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('regular', 'fullscreen');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode already regular.');
    expect(host.showNotice).toHaveBeenCalledWith(
      'Saved to tui.toml; unset KIMI_CODE_TUI_FULL_SCREEN for it to take effect.',
    );
  });

  it('keeps tuiMode undefined when saving unrelated TUI preferences', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'fullscreen');

    await applyCopyOnSelectChoice(host as never, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ copyOnSelect: false, tuiMode: undefined }),
    );
  });

  it('reports a save failure without touching appState or switching mode', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Failed to save TUI mode: disk full', 'error');
  });

  it('explains when KIMI_CODE_TUI_FULL_SCREEN overrides the saved preference', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '0');
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Saved to tui.toml; unset KIMI_CODE_TUI_FULL_SCREEN for it to take effect.',
    );
  });

  it('explains when terminal auto-fallback suppresses a saved fullscreen preference', async () => {
    vi.stubEnv('TERM', 'dumb');
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.switchTuiMode).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledWith(
      'Saved to tui.toml; this terminal automatically falls back to regular mode unless KIMI_CODE_TUI_FULL_SCREEN=1 is set.',
    );
  });
});
