import { TuiAltScreen } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { applySelectionCopyModeChoice, applyTranscriptConfigChoice } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { SelectionCopyMode, TranscriptConfig } from '#/tui/config';

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
