import { setKittyProtocolActive, type Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  applyFollowUpBehaviorChoice,
  applyTuiModeChoice,
  showSettingsSelector,
} from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { FollowUpBehaviorSelectorComponent } from '#/tui/components/dialogs/follow-up-behavior-selector';
import { renderTuiConfig, type FollowUpBehavior, type TuiConfig } from '#/tui/config';

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

const ANSI = /\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

function makeHost(followUpBehavior?: FollowUpBehavior) {
  const appState = {
    theme: 'auto' as const,
    tuiMode: 'regular' as const,
    followUpBehavior,
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' as const },
    upgrade: { autoInstall: true },
    transcript: { toolCallDensity: 'compact' as const, thinking: 'grouped' as const },
  };
  return {
    state: { appState, ui: { mode: 'regular' as const } },
    setAppState: vi.fn((patch: Partial<typeof appState>) => {
      Object.assign(appState, patch);
    }),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
  };
}

function savedConfig(): TuiConfig {
  expect(mocks.saveTuiConfig).toHaveBeenCalledTimes(1);
  return mocks.saveTuiConfig.mock.calls[0]![0] as TuiConfig;
}

describe('follow-up behavior preference', () => {
  it('writes a live line when queue is picked while the preference is unset', async () => {
    mocks.saveTuiConfig.mockReset();
    const host = makeHost();

    await applyFollowUpBehaviorChoice(host, 'queue');

    expect(renderTuiConfig(savedConfig())).toContain(
      '\nfollow_up_behavior = "queue" # "queue" | "steer"\n',
    );
    expect(host.state.appState.followUpBehavior).toBe('queue');
    expect(host.showStatus).toHaveBeenCalledWith('Follow-up behavior set to queue.', 'success');
  });

  it('saves steer over queue', async () => {
    mocks.saveTuiConfig.mockReset();
    const host = makeHost('queue');

    await applyFollowUpBehaviorChoice(host, 'steer');

    expect(savedConfig().followUpBehavior).toBe('steer');
    expect(host.state.appState.followUpBehavior).toBe('steer');
  });

  it('does not rewrite the config when the stored value is unchanged', async () => {
    mocks.saveTuiConfig.mockReset();
    const host = makeHost('steer');

    await applyFollowUpBehaviorChoice(host, 'steer');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Follow-up behavior already steer.');
  });

  it('reports a save failure without touching appState', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost();

    await applyFollowUpBehaviorChoice(host, 'steer');

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.appState.followUpBehavior).toBeUndefined();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save follow-up behavior: disk full',
      'error',
    );
  });

  it('survives a save of another preference', async () => {
    mocks.saveTuiConfig.mockReset();
    const host = makeHost('steer');

    await applyTuiModeChoice(host, 'fullscreen');

    expect(savedConfig()).toMatchObject({ tuiMode: 'fullscreen', followUpBehavior: 'steer' });
  });

  it('opens from /settings and saves the picked value', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockResolvedValue(undefined);
    let mounted: (Component & { handleInput(data: string): void }) | undefined;
    const host = {
      ...makeHost(),
      mountEditorReplacement: vi.fn((panel: Component & { handleInput(data: string): void }) => {
        mounted = panel;
      }),
      restoreEditor: vi.fn(),
    };

    showSettingsSelector(host as unknown as SlashCommandHost);
    const settings = mounted!;
    for (let i = 0; i < 20 && !strip(settings.render(100).join('\n')).includes('❯ Follow-up behavior'); i++) {
      settings.handleInput('\u001B[B');
    }
    setKittyProtocolActive(true);
    try {
      settings.handleInput('\r');
    } finally {
      setKittyProtocolActive(false);
    }

    const picker = mounted!;
    expect(picker).not.toBe(settings);
    const lines = picker.render(140).map(strip);
    expect(lines).toContain(' Follow-up behavior');
    expect(lines).toContain('  ❯ Queue ← current');
    expect(lines).toContain('    Steer');
    expect(lines.map((line) => line.trim())).toContain('Enter queues follow-ups until Kimi finishes. Ctrl-Enter steers one.');

    picker.handleInput('\u001B[B');
    picker.handleInput('\r');
    await vi.waitFor(() => {
      expect(host.state.appState.followUpBehavior).toBe('steer');
    });
    expect(savedConfig().followUpBehavior).toBe('steer');
  });

  it.each([
    [true, 'Enter queues follow-ups until Kimi finishes. Ctrl-Enter steers one.', 'Enter steers follow-ups into the current turn. Ctrl-Enter queues one.'],
    [false, 'Enter queues follow-ups until Kimi finishes.', 'Enter steers follow-ups into the current turn. Ctrl-Q queues one.'],
  ])('names only the keys this terminal reports (Ctrl-Enter recognized: %s)', (ctrlEnterRecognized, queue, steer) => {
    const picker = new FollowUpBehaviorSelectorComponent({
      currentValue: 'queue',
      ctrlEnterRecognized,
      onSelect: vi.fn(),
      onCancel: vi.fn(),
    });

    const lines = picker.render(140).map((line) => strip(line).trim());

    expect(lines).toContain(queue);
    expect(lines).toContain(steer);
  });
});
