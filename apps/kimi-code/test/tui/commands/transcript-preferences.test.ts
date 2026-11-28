import { Text, TuiAltScreen, type Component } from '@moonshot-ai/pi-tui';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  applyScrollSpeedChoice,
  applySelectionCopyModeChoice,
  applyTranscriptConfigChoice,
  showSettingsSelector,
} from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { SelectionCopyMode, TranscriptConfig, WheelScrollLines } from '#/tui/config';

import { VirtualTerminal } from '../../../../../packages/pi-tui/test/virtual-terminal';

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

function makeHost(transcript: TranscriptConfig) {
  const host = {
    state: {
      appState: {
        theme: 'auto',
        tuiMode: 'fullscreen',
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' },
        upgrade: { autoInstall: true },
        transcript,
      },
      transcriptContainer: { setPresentationOptions: vi.fn() },
      ui: { mode: 'fullscreen' },
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(host.state.appState, patch)),
    showStatus: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    setAppState: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('transcript preference commands', () => {
  it('saves both display values, updates appState, and records settings telemetry', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    const transcript: TranscriptConfig = { toolCallDensity: 'detailed', thinking: 'ungrouped' };

    await applyTranscriptConfigChoice(host, transcript);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ transcript, tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ transcript });
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledWith({
      fullscreen: true,
      toolCallDensity: 'detailed',
      thinking: 'ungrouped',
    });
    expect(host.track).toHaveBeenCalledWith('transcript_display_settings', {
      tool_call_density: 'detailed',
      thinking: 'ungrouped',
      source: 'settings',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Transcript display settings updated.', 'success');
  });

  it('does not rewrite or track unchanged values', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost({ toolCallDensity: 'ungrouped', thinking: 'ungrouped' });

    await applyTranscriptConfigChoice(host, { toolCallDensity: 'ungrouped', thinking: 'ungrouped' });

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Transcript display settings unchanged.');
  });

  it('reports a save failure without touching appState or telemetry', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });

    await applyTranscriptConfigChoice(host, { toolCallDensity: 'detailed', thinking: 'grouped' });

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save transcript display settings: disk full',
      'error',
    );
  });
});

describe('selection copy mode preference', () => {
  function makeSelectionCopyModeHost(mode: SelectionCopyMode | undefined) {
    const ui = new TuiAltScreen(new VirtualTerminal(40, 10), undefined, undefined, {
      copyOnSelect: mode !== 'off' && mode !== 'right-click',
      copyOnRightClick: mode === 'right-click',
    });
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    Object.assign(host.state, { ui });
    Object.assign(host.state.appState, { selectionCopyMode: mode });
    return { host, ui };
  }

  it('saves right-click mode, mirrors appState, and updates both live copy triggers', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host, ui } = makeSelectionCopyModeHost(undefined);

    await applySelectionCopyModeChoice(host, 'right-click');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionCopyMode: 'right-click',
        transcript: host.state.appState.transcript,
      }),
    );
    expect(host.state.appState.selectionCopyMode).toBe('right-click');
    expect(ui.getCopyOnSelect()).toBe(false);
    expect(ui.getCopyOnRightClick()).toBe(true);
    expect(host.showStatus).toHaveBeenCalledWith('Selection copy mode set to right-click.');
  });

  it('reports an unchanged choice without saving', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host, ui } = makeSelectionCopyModeHost('immediate');

    await applySelectionCopyModeChoice(host, 'immediate');

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(ui.getCopyOnRightClick()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith('Selection copy mode already immediate.');
  });

  it('keeps the live setting when tui.toml cannot be saved', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('read-only file system'));
    const { host, ui } = makeSelectionCopyModeHost('immediate');

    await applySelectionCopyModeChoice(host, 'off');

    expect(host.state.appState.selectionCopyMode).toBe('immediate');
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(ui.getCopyOnRightClick()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save selection copy setting: read-only file system',
      'error',
    );
  });
});

describe('scroll speed preference', () => {
  async function makeScrollSpeedHost(wheelScrollLines: WheelScrollLines | undefined) {
    const vt = new VirtualTerminal(40, 12);
    const ui = new TuiAltScreen(vt, undefined, undefined, {
      wheelScrollLines: wheelScrollLines ?? 'auto',
    });
    ui.addChild(
      new Text(Array.from({ length: 60 }, (_, index) => `line ${String(index + 1)}`).join('\n'), 0, 0),
    );
    ui.start();
    onTestFinished(() => {
      ui.stop();
    });
    await vt.waitForRender();

    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    Object.assign(host.state, { ui });
    Object.assign(host.state.appState, {
      mouse: { wheelScrollLines: wheelScrollLines ?? 'auto', altWheelAcceleration: true },
    });
    return { host, ui, vt };
  }

  async function measureSingleWheelUp(ui: TuiAltScreen, vt: VirtualTerminal): Promise<number> {
    const before = ui.viewportTop;
    vt.sendInput('\u001B[<64;1;1M');
    await vt.waitForRender();
    return before - ui.viewportTop;
  }

  it('saves a preset, mirrors appState, and changes live TuiAltScreen wheel step immediately', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host, ui, vt } = await makeScrollSpeedHost(undefined);

    await applyScrollSpeedChoice(host, 5);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        mouse: expect.objectContaining({ wheelScrollLines: 5 }),
        transcript: host.state.appState.transcript,
      }),
    );
    expect(host.state.appState.mouse?.wheelScrollLines).toBe(5);
    expect(host.showStatus).toHaveBeenCalledWith('Scroll speed set to 5 lines.', 'success');
    expect(await measureSingleWheelUp(ui, vt)).toBe(5);

    await applyScrollSpeedChoice(host, 1);

    expect(host.state.appState.mouse?.wheelScrollLines).toBe(1);
    expect(host.showStatus).toHaveBeenCalledWith('Scroll speed set to 1 line.', 'success');
    expect(await measureSingleWheelUp(ui, vt)).toBe(1);
  });

  it.each<readonly [WheelScrollLines | undefined, WheelScrollLines, string]>([
    [undefined, 'auto', 'Scroll speed already Auto.'],
    [7, 7, 'Scroll speed already 7 lines.'],
    [1, 1, 'Scroll speed already 1 line.'],
  ])(
    'reports an unchanged choice without saving (%j -> %j)',
    async (current, selected, expectedMessage) => {
      mocks.saveTuiConfig.mockReset();
      const { host } = await makeScrollSpeedHost(current);

      await applyScrollSpeedChoice(host, selected);

      expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
      expect(host.setAppState).not.toHaveBeenCalled();
      expect(host.showStatus).toHaveBeenCalledWith(expectedMessage);
    },
  );

  it('keeps appState and live wheel step untouched when tui.toml cannot be saved', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('read-only file system'));
    const { host, ui, vt } = await makeScrollSpeedHost(2);

    await applyScrollSpeedChoice(host, 10);

    expect(host.state.appState.mouse?.wheelScrollLines).toBe(2);
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(await measureSingleWheelUp(ui, vt)).toBe(2);
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save scroll speed setting: read-only file system',
      'error',
    );
  });

  it('preserves a custom wheelScrollLines value when saving an unrelated preference', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host } = await makeScrollSpeedHost(7);

    await applySelectionCopyModeChoice(host, 'off');

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        selectionCopyMode: 'off',
        mouse: expect.objectContaining({ wheelScrollLines: 7 }),
      }),
    );
  });

  it('opens Scroll speed from /settings and applies the chosen value live', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockResolvedValue(undefined);
    const { host, ui, vt } = await makeScrollSpeedHost(undefined);
    let mounted: (Component & { handleInput(data: string): void }) | undefined;
    Object.assign(host, {
      mountEditorReplacement: vi.fn((panel: Component & { handleInput(data: string): void }) => {
        mounted = panel;
      }),
      restoreEditor: vi.fn(),
    });

    showSettingsSelector(host);
    const settings = mounted!;
    for (let i = 0; i < 7; i++) settings.handleInput('\u001B[B');
    settings.handleInput('\r');

    const picker = mounted!;
    expect(picker).not.toBe(settings);
    for (let i = 0; i < 3; i++) picker.handleInput('\u001B[B');
    picker.handleInput('\r');

    await vi.waitFor(() => {
      expect(host.state.appState.mouse?.wheelScrollLines).toBe(3);
    });
    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ mouse: expect.objectContaining({ wheelScrollLines: 3 }) }),
    );
    expect(await measureSingleWheelUp(ui, vt)).toBe(3);
  });
});
