/**
 * Scenario: /model switching on the session-less v2 path (lazy session creation),
 * where the TUI still has no session — right after `/login` or a fresh startup.
 * Responsibilities: the footer's context cap follows the picked model for both the
 * persisted and the session-only switch, since no `agent.status.updated` arrives
 * to carry it.
 * Wiring: real picker, real `performModelSwitch`, and the real `AuthFlowController`
 * with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/model-switch.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { showModelPicker } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import { AuthFlowController } from '#/tui/controllers/auth-flow';

const K2_CONTEXT = 262_144; // 256k
const K3_CONTEXT = 1_048_576; // 1M

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly onSelect: (selection: { alias: string; thinking: string }) => void;
  readonly onSessionOnlySelect: (selection: { alias: string; thinking: string }) => void;
}

function model(name: string, maxContextSize: number): ModelAlias {
  return {
    provider: 'kimi-for-coding',
    model: name,
    maxContextSize,
    displayName: name,
  } as unknown as ModelAlias;
}

function makeHost() {
  const appState = {
    model: 'kimi-for-coding/k2.7',
    thinkingEffort: 'off',
    contextTokens: 0,
    contextUsage: 0,
    // Hydrated at startup / after login from the default model (k2.7 = 256k).
    maxContextTokens: K2_CONTEXT,
    streamingPhase: 'idle',
    planMode: false,
    workDir: '/tmp/work',
    additionalDirs: [] as string[],
    availableModels: {
      'kimi-for-coding/k2.7': model('k2.7', K2_CONTEXT),
      'kimi-for-coding/k3': model('k3', K3_CONTEXT),
    } as Record<string, ModelAlias>,
    availableProviders: {},
  };
  const host = {
    state: { appState, transcriptEntries: [] },
    session: undefined,
    // v2 engine: the session is created lazily on the first message.
    engineV2: true,
    options: { startup: {} },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        models: appState.availableModels,
        defaultModel: 'kimi-for-coding/k2.7',
      })),
      setConfig: vi.fn(async () => ({})),
    },
    setAppState: vi.fn((patch: Record<string, unknown>) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    waitForLazyCreation: vi.fn(async () => undefined),
    hydrateLazyConfigDefaults: vi.fn(async () => undefined),
  } as unknown as SlashCommandHost & {
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  // The real controller: /model on the session-less path goes through
  // AuthFlowController.activateModelAfterLogin.
  (host as unknown as { authFlow: AuthFlowController }).authFlow = new AuthFlowController(
    host as never,
  );
  return { host, appState };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('/model switch on the session-less v2 path', () => {
  it('updates the footer context cap to the picked model', async () => {
    const { host, appState } = makeHost();

    showModelPicker(host);
    mountedPicker(host).onSelect({ alias: 'kimi-for-coding/k3', thinking: 'off' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.showError).not.toHaveBeenCalled();
    expect(appState.model).toBe('kimi-for-coding/k3');
    expect(appState.maxContextTokens).toBe(K3_CONTEXT);
  });

  it('updates the footer context cap for a session-only switch too', async () => {
    const { host, appState } = makeHost();

    showModelPicker(host);
    mountedPicker(host).onSessionOnlySelect({ alias: 'kimi-for-coding/k3', thinking: 'off' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(appState.maxContextTokens).toBe(K3_CONTEXT);
  });
});
