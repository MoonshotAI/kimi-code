/**
 * Scenario: /secondary_model command behavior in the interactive TUI.
 * Responsibilities: picker filtering, persistence, live apply, and effective-model state refresh.
 * Wiring: real command and selector with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/secondary-model.test.ts
 */
import type { ModelAlias, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleSecondaryModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly currentThinkingEffort: string;
  readonly title?: string;
  readonly onSelect: (selection: { alias: string; thinking: ThinkingEffort }) => void;
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
  readonly withSession?: boolean;
  readonly secondaryModel?: { model: string; defaultEffort?: string };
  readonly persistedModels?: Record<string, ModelAlias>;
  /** The secondary model the reloaded config carries — env overlays win. */
  readonly effectiveSecondary?: { model: string; defaultEffort?: string };
}) {
  const session = options?.withSession === false
    ? undefined
    : { applyPersistedSecondaryModel: vi.fn(async () => {}) };
  const appState = {
    availableModels: {
      k2: model('k2'),
      cheap: model('cheap'),
      // The synthesized derived entry must never be selectable.
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
        secondaryModel: options?.secondaryModel,
      })),
      setConfig: vi.fn(async () => ({
        providers: {},
        models: options?.persistedModels,
        secondaryModel: options?.effectiveSecondary,
      })),
    },
    session,
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
  return { host, session };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleSecondaryModelCommand', () => {
  it('opens the picker filtered to user models, with the configured recipe as current', async () => {
    const { host } = makeHost({ secondaryModel: { model: 'cheap', defaultEffort: 'high' } });

    await handleSecondaryModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'cheap']);
    expect(opts.currentValue).toBe('cheap');
    expect(opts.currentThinkingEffort).toBe('high');
    expect(opts.title).toContain('secondary model');
  });

  it('persists first, then live-applies the selection to the session', async () => {
    const { host, session } = makeHost();

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'high' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { model: 'k2', defaultEffort: 'high' },
    });
    expect(session!.applyPersistedSecondaryModel).toHaveBeenCalledWith();
    expect(host.harness.setConfig.mock.invocationCallOrder[0]).toBeLessThan(
      session!.applyPersistedSecondaryModel.mock.invocationCallOrder[0]!,
    );
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('refreshes the effective model map after a live secondary-model switch', async () => {
    const { host } = makeHost({
      persistedModels: {
        k2: model('k2'),
        cheap: model('cheap'),
        '__secondary__': model('k2'),
      },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'high' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.state.appState.availableModels['__secondary__']?.displayName).toBe('k2');
  });

  it('warns with the env-overridden effective binding instead of the picked model', async () => {
    // KIMI_SECONDARY_MODEL / KIMI_SECONDARY_EFFORT win over the persisted
    // recipe: the reloaded config carries the overlaid values, and the status
    // message must name them rather than echo the pick.
    const { host } = makeHost({
      effectiveSecondary: { model: 'cheap', defaultEffort: 'low' },
    });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'high' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    const [message, color] = host.showStatus.mock.calls[0]!;
    expect(message).toContain('KIMI_SECONDARY_MODEL=cheap');
    expect(message).toContain('KIMI_SECONDARY_EFFORT=low');
    expect(color).toBe('warning');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('keeps the current effective model map when live apply fails', async () => {
    const { host, session } = makeHost({
      persistedModels: {
        k2: model('k2'),
        cheap: model('cheap'),
        '__secondary__': model('k2'),
      },
    });
    session!.applyPersistedSecondaryModel.mockRejectedValueOnce(new Error('apply failed'));

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'high' });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.state.appState.availableModels['__secondary__']?.displayName).toBe('cheap');
  });

  it('persists only when there is no session', async () => {
    const { host } = makeHost({ withSession: false });

    await handleSecondaryModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'k2', thinking: 'off' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      secondaryModel: { model: 'k2', defaultEffort: 'off' },
    });
    expect(host.showStatus.mock.calls[0]![0]).toContain('new sessions');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('rejects the synthesized derived alias as an argument', async () => {
    const { host } = makeHost();

    await handleSecondaryModelCommand(host, '__secondary__');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: __secondary__');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleSecondaryModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });
});
