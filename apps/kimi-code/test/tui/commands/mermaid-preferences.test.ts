import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyMermaidPreferenceChoice } from '#/tui/commands/config';
import { darkColors } from '#/tui/theme/colors';
import { getMarkdownMermaidMode, setMarkdownMermaidMode } from '#/tui/utils/markdown-options';

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

function makeHost(mermaid: 'off' | 'final') {
  return {
    state: {
      appState: {
        theme: 'auto' as const,
        editorCommand: null,
        notifications: { enabled: true, condition: 'unfocused' as const },
        upgrade: { autoInstall: true },
        markdown: { mermaid },
      },
      theme: { palette: darkColors },
      transcriptContainer: { invalidate: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    setAppState: vi.fn(),
    showStatus: vi.fn(),
  };
}

afterEach(() => {
  setMarkdownMermaidMode('final');
});

describe('mermaid preference commands', () => {
  it('saves off to tui.toml, mirrors appState, updates the live mode, and redraws the transcript', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: { mermaid: 'off' } }),
    );
    expect(host.setAppState).toHaveBeenCalledWith({ markdown: { mermaid: 'off' } });
    expect(getMarkdownMermaidMode()).toBe('off');
    expect(host.state.transcriptContainer.invalidate).toHaveBeenCalled();
    expect(host.state.ui.requestRender).toHaveBeenCalledWith(true);
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams disabled.');
  });

  it('re-enables diagrams from an off state', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('off');

    await applyMermaidPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: { mermaid: 'final' } }),
    );
    expect(getMarkdownMermaidMode()).toBe('final');
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams enabled.');
  });

  it('does not rewrite the config or redraw when the value is unchanged', async () => {
    mocks.saveTuiConfig.mockClear();
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, true);

    expect(mocks.saveTuiConfig).not.toHaveBeenCalled();
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.transcriptContainer.invalidate).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Mermaid diagrams already enabled.');
  });

  it('reports a save failure without touching appState or the live mode', async () => {
    mocks.saveTuiConfig.mockRejectedValueOnce(new Error('disk full'));
    const host = makeHost('final');

    await applyMermaidPreferenceChoice(host, false);

    expect(host.setAppState).not.toHaveBeenCalled();
    expect(getMarkdownMermaidMode()).toBe('final');
    expect(host.state.transcriptContainer.invalidate).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Failed to save mermaid diagram setting: disk full',
      'error',
    );
  });
});
