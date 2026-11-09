import { TuiAltScreen } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { applyCopyOnSelectChoice, applyTranscriptConfigChoice } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptConfig } from '#/tui/config';

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

describe('copy on select preference', () => {
  function makeCopyOnSelectHost(copyOnSelect: boolean | undefined) {
    const ui = new TuiAltScreen(new VirtualTerminal(40, 10), undefined, undefined, {
      copyOnSelect,
    });
    const host = makeHost({ toolCallDensity: 'compact', thinking: 'grouped' });
    Object.assign(host.state, { ui });
    Object.assign(host.state.appState, { copyOnSelect });
    return { host, ui };
  }

  it('saves the choice to tui.toml, mirrors appState, and applies it to the live fullscreen renderer', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host, ui } = makeCopyOnSelectHost(undefined);

    await applyCopyOnSelectChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ copyOnSelect: false, transcript: host.state.appState.transcript }),
    );
    expect(host.state.appState.copyOnSelect).toBe(false);
    expect(ui.getCopyOnSelect()).toBe(false);
    expect(host.showStatus).toHaveBeenCalledWith('Copy on select disabled.');
  });

  it('reports an unchanged choice without saving', async () => {
    mocks.saveTuiConfig.mockReset();
    const { host, ui } = makeCopyOnSelectHost(true);

    await applyCopyOnSelectChoice(host, true);

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(host.showStatus).toHaveBeenCalledWith('Copy on select already enabled.');
  });

  it('keeps the live setting when tui.toml cannot be saved', async () => {
    mocks.saveTuiConfig.mockReset();
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('read-only file system'));
    const { host, ui } = makeCopyOnSelectHost(true);

    await applyCopyOnSelectChoice(host, false);

    expect(host.state.appState.copyOnSelect).toBe(true);
    expect(ui.getCopyOnSelect()).toBe(true);
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save copy on select setting: read-only file system',
      'error',
    );
  });
});
