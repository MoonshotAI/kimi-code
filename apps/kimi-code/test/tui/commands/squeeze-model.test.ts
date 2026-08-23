/**
 * Scenario: /squeeze-model and /squeeze-model-secondary command behavior in the TUI.
 * Responsibilities: picker filtering, persistence of `[compaction_model] model` (and
 * `secondary_model` for the secondary command) plus
 * enabling the `compaction-model` experiment flag, and error paths.
 * Wiring: real command and selector with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/squeeze-model.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import {
  handleSqueezeModelCommand,
  handleSqueezeModelSecondaryCommand,
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
  readonly compactionModel?: {
    defaultModel?: string;
    model?: string;
    secondaryModel?: string;
  };
}) {
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
      // The v1 secondary-model derived entry must never be selectable here.
      '__secondary__': model('cheap'),
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
        compactionModel: options?.compactionModel,
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

describe('handleSqueezeModelCommand', () => {
  it('opens the picker filtered to user models, with the configured model as current', async () => {
    const { host } = makeHost({ compactionModel: { model: 'cheap' } });

    await handleSqueezeModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('squeeze model');
    expect(opts.thinkingControl).toBe(false);
  });

  it('falls back to the legacy default_model key when no model is set', async () => {
    const { host } = makeHost({ compactionModel: { defaultModel: 'k2' } });

    await handleSqueezeModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(opts.currentValue).toBe('k2');
  });

  it('persists the engine-contract model pointer and enables the experiment flag', async () => {
    const { host } = makeHost();

    await handleSqueezeModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      compactionModel: { model: 'k2' },
      experimental: { 'compaction-model': true },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('pre-selects a valid alias argument instead of erroring', async () => {
    const { host } = makeHost();

    await handleSqueezeModelCommand(host, 'cheap');

    const opts = mountedPicker(host);
    expect(opts.selectedValue).toBe('cheap');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleSqueezeModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleSqueezeModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleSqueezeModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});


describe('handleSqueezeModelSecondaryCommand', () => {
  it('shows the configured secondary squeeze model as current', async () => {
    const { host } = makeHost({ compactionModel: { secondaryModel: 'cheap' } });

    await handleSqueezeModelSecondaryCommand(host, '');

    const opts = mountedPicker(host);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.title).toContain('secondary squeeze model');
  });

  it('shows an empty current value when no secondary squeeze model is set', async () => {
    const { host } = makeHost({ compactionModel: { model: 'k2' } });

    await handleSqueezeModelSecondaryCommand(host, '');

    expect(mountedPicker(host).currentValue).toBe('');
  });

  it('persists the secondary_model pointer and enables the experiment flag', async () => {
    const { host } = makeHost();

    await handleSqueezeModelSecondaryCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'cheap' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      compactionModel: { secondaryModel: 'cheap' },
      experimental: { 'compaction-model': true },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('pre-selects a valid alias argument and rejects an unknown one', async () => {
    const { host } = makeHost();

    await handleSqueezeModelSecondaryCommand(host, 'cheap');
    expect(mountedPicker(host).selectedValue).toBe('cheap');

    await handleSqueezeModelSecondaryCommand(host, 'nope');
    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleSqueezeModelSecondaryCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2' });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
