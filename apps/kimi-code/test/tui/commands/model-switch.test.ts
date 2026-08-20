/**
 * Scenario: /model switching on a session retained across a provider logout.
 * Responsibilities: the switch must restore the context counters that logout
 * zeroed (footer + cache-expiry hint read them), alongside the model itself.
 * Wiring: real command and selector with the SDK/session boundary stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/model-switch.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly onSelect: (selection: { alias: string; thinking: 'off' }) => void;
  readonly onSessionOnlySelect: (selection: { alias: string; thinking: 'off' }) => void;
}

function model(name: string): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost() {
  const appState = {
    availableModels: {
      k2: model('k2'),
      g1: model('g1'),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    // Post-logout state: the model display and the context counters were
    // cleared while the session was retained.
    model: '',
    thinkingEffort: 'off' as const,
    contextTokens: 0,
    maxContextTokens: 0,
    contextUsage: 0,
    streamingPhase: 'idle' as const,
    transcriptEntries: [],
  };
  const session = {
    id: 'ses-1',
    setModel: vi.fn(async () => {}),
    setThinking: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({
      model: 'g1',
      thinkingEffort: 'off',
      permission: 'manual',
      planMode: false,
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    })),
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    session,
    engineV2: true,
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({})),
    },
    setAppState: vi.fn((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return { host, session, appState };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleModelCommand', () => {
  it('restores the context counters zeroed by a provider logout', async () => {
    const { host, session, appState } = makeHost();

    await handleModelCommand(host, '');
    mountedPicker(host).onSessionOnlySelect({ alias: 'g1', thinking: 'off' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(session.setModel).toHaveBeenCalledWith('g1');
    expect(appState).toMatchObject({
      model: 'g1',
      thinkingEffort: 'off',
      contextTokens: 10,
      maxContextTokens: 100,
      contextUsage: 0.1,
    });
    expect(host.showError).not.toHaveBeenCalled();
  });
});
