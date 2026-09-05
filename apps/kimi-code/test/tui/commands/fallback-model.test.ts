/**
 * Scenario: /fallback-model and /fallback-model-secondary command behavior in the TUI.
 * Mirrors the squeeze-model test: picker filtering, persistence of `[fallback_model]`
 * `model` and `secondary_model`, plus enabling the `fallback-model` experiment flag.
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import {
  handleFallbackModelCommand,
  handleFallbackModelSecondaryCommand,
} from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly title?: string;
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: { alias: string }) => void;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly fallbackModel?: { model?: string; secondaryModel?: string };
}) {
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        fallbackModel: options?.fallbackModel,
      })),
      setConfig: vi.fn(async () => ({})),
    },
    setAppState: vi.fn((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleFallbackModelCommand', () => {
  it('opens the picker filtered to user models, with the configured model as current', async () => {
    const { host } = makeHost({ fallbackModel: { model: 'cheap' } });

    await handleFallbackModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('fallback model');
    expect(opts.thinkingControl).toBe(false);
  });

  it('persists the model pointer and enables the experiment flag', async () => {
    const { host } = makeHost();

    await handleFallbackModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      fallbackModel: { model: 'k2' },
      experimental: { 'fallback-model': true },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('pre-selects a valid alias argument and rejects an unknown one', async () => {
    const { host } = makeHost();

    await handleFallbackModelCommand(host, 'cheap');
    expect(mountedPicker(host).selectedValue).toBe('cheap');

    await handleFallbackModelCommand(host, 'nope');
    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleFallbackModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});

describe('handleFallbackModelSecondaryCommand', () => {
  it('shows the configured secondary fallback model as current', async () => {
    const { host } = makeHost({ fallbackModel: { secondaryModel: 'cheap' } });

    await handleFallbackModelSecondaryCommand(host, '');

    const opts = mountedPicker(host);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('secondary fallback model');
  });

  it('persists the secondary_model pointer and enables the experiment flag', async () => {
    const { host } = makeHost();

    await handleFallbackModelSecondaryCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'cheap' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      fallbackModel: { secondaryModel: 'cheap' },
      experimental: { 'fallback-model': true },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });
});
