import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyCopyOnSelectChoice, applyFollowUpBehaviorChoice, applyTuiModeChoice } from '#/tui/commands/config';
import { FollowUpBehaviorSelectorComponent, SettingsSelectorComponent } from '#/tui/components/dialogs/settings-selector';

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
  followUpBehavior?: 'queue' | 'steer',
) {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        tuiMode,
        followUpBehavior,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        transcript: { toolCallDensity: 'compact' as const, thinking: 'grouped' as const },
      },
      ui: { mode: runningMode },
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
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

  it('saves fullscreen to tui.toml, mirrors appState, tracks switch, and notices the required restart', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'fullscreen' });
    expect(host.track).toHaveBeenCalledWith('tui_mode_switch', { tui_mode: 'fullscreen' });
    expect(host.showStatus).toHaveBeenCalledWith('TUI mode set to fullscreen.', 'success');
    expect(host.showNotice).toHaveBeenCalledWith(
      'TUI mode takes effect after restarting Kimi Code.',
    );
  });

  it('persists regular when switching away from a default fullscreen session', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'fullscreen');

    await applyTuiModeChoice(host, 'regular');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'regular' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ tuiMode: 'regular' });
    expect(host.track).toHaveBeenCalledWith('tui_mode_switch', { tui_mode: 'regular' });
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
      expect.objectContaining({
        copyOnSelect: false,
        tuiMode: undefined,
        followUpBehavior: undefined,
      }),
    );
  });

  it('reports a save failure without touching appState', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Failed to save TUI mode: disk full', 'error');
  });

  it('explains when KIMI_CODE_TUI_FULL_SCREEN overrides the saved preference instead of promising a restart', async () => {
    vi.stubEnv('KIMI_CODE_TUI_FULL_SCREEN', '0');
    mocks.saveTuiConfig.mockClear();
    const host = makeHost(undefined, 'regular');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ tuiMode: 'fullscreen' }),
    );
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
    expect(host.showNotice).toHaveBeenCalledWith(
      'Saved to tui.toml; this terminal automatically falls back to regular mode unless KIMI_CODE_TUI_FULL_SCREEN=1 is set.',
    );
  });
});

describe('follow-up behavior preference commands', () => {
  beforeEach(() => {
    mocks.saveTuiConfig.mockReset();
  });

  it('saves steer from an unset preference and mirrors appState', async () => {
    const host = makeHost(undefined);

    await applyFollowUpBehaviorChoice(host as never, 'steer');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ followUpBehavior: 'steer' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ followUpBehavior: 'steer' });
    expect(host.track).toHaveBeenCalledWith('follow_up_behavior_switch', {
      follow_up_behavior: 'steer',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Follow-up behavior set to steer.', 'success');
  });

  it('persists an explicit queue selection when the preference was unset', async () => {
    const host = makeHost(undefined);

    await applyFollowUpBehaviorChoice(host as never, 'queue');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ followUpBehavior: 'queue' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ followUpBehavior: 'queue' });
    expect(host.track).toHaveBeenCalledWith('follow_up_behavior_switch', {
      follow_up_behavior: 'queue',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Follow-up behavior set to queue.', 'success');
  });

  it('does not rewrite an explicitly saved value when it is selected again', async () => {
    const host = makeHost(undefined, 'regular', 'queue');

    await applyFollowUpBehaviorChoice(host as never, 'queue');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Follow-up behavior already queue.');
  });

  it('reports a save failure without touching appState', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost(undefined);

    await applyFollowUpBehaviorChoice(host as never, 'steer');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save follow-up behavior: disk full',
      'error',
    );
  });

  it('offers the setting in both layouts and selects steer with the keyboard', () => {
    for (const fullscreen of [false, true]) {
      const settings = new SettingsSelectorComponent({
        fullscreen,
        onSelect: vi.fn(),
        onCancel: vi.fn(),
      });
      expect(settings.render(120).join('\n')).toContain('Follow-up behavior');
    }
    const onSelect = vi.fn();
    const picker = new FollowUpBehaviorSelectorComponent({
      onSelect,
      onCancel: vi.fn(),
    });

    expect(picker.selectedValue()).toBe('queue');
    picker.handleInput('\u001B[B');
    picker.handleInput('\r');

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('steer');
  });
});
