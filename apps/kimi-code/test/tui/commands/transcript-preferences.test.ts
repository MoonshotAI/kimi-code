import { describe, expect, it, vi } from 'vitest';

import { applyTranscriptConfigChoice } from '#/tui/commands/config';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import type { TranscriptConfig } from '#/tui/config';

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
  it('saves group values, updates appState, and records settings telemetry', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost({ groupTools: 'auto', groupThinking: true });
    const transcript: TranscriptConfig = { groupTools: 'explore', groupThinking: false };

    await applyTranscriptConfigChoice(host, transcript);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ transcript, tuiMode: 'fullscreen' }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ transcript });
    expect(host.state.transcriptContainer.setPresentationOptions).toHaveBeenCalledWith({
      fullscreen: true,
      groupTools: 'explore',
      groupThinking: false,
    });
    expect(host.track).toHaveBeenCalledWith('transcript_display_settings', {
      group_tools: 'explore',
      group_thinking: false,
      source: 'settings',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Transcript display settings updated.', 'success');
  });

  it('does not rewrite or track unchanged values', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost({ groupTools: 'off', groupThinking: false });

    await applyTranscriptConfigChoice(host, { groupTools: 'off', groupThinking: false });

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Transcript display settings unchanged.');
  });

  it('reports a save failure without touching appState or telemetry', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost({ groupTools: 'auto', groupThinking: true });

    await applyTranscriptConfigChoice(host, { groupTools: 'explore', groupThinking: true });

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save transcript display settings: disk full',
      'error',
    );
  });
});
