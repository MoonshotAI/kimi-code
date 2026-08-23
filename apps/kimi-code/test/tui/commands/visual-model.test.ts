/**
 * Scenario: /visual-model command behavior in the interactive TUI.
 * Responsibilities: persistence of the engine-contract pointer `[visual_model] model`
 * plus enabling the `visual-model` experiment flag, and the legacy default_model
 * read-back (an older TUI wrote the wrong field).
 * Wiring: real command with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/visual-model.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleVisualModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
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
  readonly visualModel?: { defaultModel?: string; model?: string };
}) {
  const appState = {
    availableModels: {
      k2: model('k2'),
      vision: model('vision'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: { appState, transcriptEntries: [] },
    authFlow: { refreshOAuthProviderModels: vi.fn(async () => undefined) },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        visualModel: options?.visualModel,
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

describe('handleVisualModelCommand', () => {
  it('shows the configured model as current', async () => {
    const { host } = makeHost({ visualModel: { model: 'vision' } });

    await handleVisualModelCommand(host, '');

    expect(mountedPicker(host).currentValue).toBe('vision');
  });

  it('falls back to the legacy default_model when showing the current value', async () => {
    const { host } = makeHost({ visualModel: { defaultModel: 'vision' } });

    await handleVisualModelCommand(host, '');

    expect(mountedPicker(host).currentValue).toBe('vision');
  });

  it('persists the engine-contract model pointer and enables the experiment flag', async () => {
    const { host } = makeHost();

    await handleVisualModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'vision' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      visualModel: { model: 'vision' },
      experimental: { 'visual-model': true },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });
});
