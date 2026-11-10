/**
 * Scenario: /provider post-add default-model selection, and the
 * `/provider refresh [providerId]` subcommand.
 * Responsibilities: the picked effort is gated for persistence by the model's
 * effective default, and a session-only pick is still applied to the runtime
 * after the config refresh (which only reactivates from persisted values);
 * refresh scopes to one provider when given, reports added/removed/failed,
 * and routes a retired default into the model-migration flow.
 * Wiring: real setDefaultModel / handleProviderCommand with the
 * harness/authFlow boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/provider.test.ts
 */
import type { ModelAlias, RefreshProviderModelsResponse } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleProviderCommand, setDefaultModel } from '#/tui/commands/provider';
import { promptApiKey } from '#/tui/commands/prompts';

function makeHost(
  options: {
    refreshReachedLiveSession?: boolean;
    activateReachedLiveSession?: boolean;
  } = {},
) {
  const appState = {
    availableModels: {
      // Declares no efforts; the Anthropic profile inference supplies
      // [low, medium, high, xhigh, max] with the default resolved to 'high'.
      opus: {
        provider: 'compatible',
        model: 'claude-opus-4-7',
        maxContextSize: 200_000,
      } as unknown as ModelAlias,
    },
    availableProviders: {
      compatible: { type: 'anthropic' },
    },
  };
  const host = {
    state: { appState },
    waitForSessionAssembly: vi.fn(async () => {}),
    harness: {
      setConfig: vi.fn(async () => ({})),
    },
    authFlow: {
      refreshConfigAfterLogin: vi.fn(async () => options.refreshReachedLiveSession === true),
      activateModelAfterLogin: vi.fn(async () => options.activateReachedLiveSession === true),
    },
    track: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: { setConfig: ReturnType<typeof vi.fn> };
    authFlow: {
      refreshConfigAfterLogin: ReturnType<typeof vi.fn>;
      activateModelAfterLogin: ReturnType<typeof vi.fn>;
    };
    waitForSessionAssembly: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return { host };
}

describe('promptApiKey', () => {
  it('releases auth blocked when the API key prompt is replaced', async () => {
    let replace: (() => void) | undefined;
    const release = vi.fn();
    const host = {
      beginAuthBlock: vi.fn(() => release),
      mountEditorReplacement: vi.fn(
        (
          _dialog: unknown,
          _onDisplaced: unknown,
          onReplaced: (() => void) | undefined,
        ) => {
          replace = onReplaced;
        },
      ),
      restoreEditor: vi.fn(),
    } as unknown as SlashCommandHost;

    const prompt = promptApiKey(host, 'Example provider');
    expect(replace).toBeDefined();
    replace!();

    await expect(prompt).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('holds auth blocked until the prompt resolves', async () => {
    const release = vi.fn();
    const host = {
      beginAuthBlock: vi.fn(() => release),
      mountEditorReplacement: vi.fn((dialog: { handleInput(data: string): void }) => {
        dialog.handleInput('YOUR_API_KEY');
        dialog.handleInput('\r');
      }),
      restoreEditor: vi.fn(),
    } as unknown as SlashCommandHost;

    const prompt = promptApiKey(host, 'Example provider');
    expect(host.beginAuthBlock).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    await expect(prompt).resolves.toBe('YOUR_API_KEY');
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('setDefaultModel', () => {
  it('applies an above-default pick to the runtime when the gate keeps it session-only', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    // The application must come after the refresh, or the persisted value
    // reactivated by refreshConfigAfterLogin would clobber the pick.
    expect(
      host.authFlow.activateModelAfterLogin.mock.invocationCallOrder[0]!,
    ).toBeGreaterThan(host.authFlow.refreshConfigAfterLogin.mock.invocationCallOrder[0]!);
    // Without a session the engine never sees the pick, so the TUI stays the
    // sole model_switch producer.
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('does not re-apply the effort when the pick persists', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true, effort: 'high' },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('does not re-apply a boolean on pick', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'on');

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      defaultModel: 'opus',
      thinking: { enabled: true },
    });
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when activation changed the bound alias', async () => {
    const { host } = makeHost({ refreshReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'high');

    // refreshConfigAfterLogin routed through session.setModel with a changed
    // alias, which the engine already tracks — a TUI-side event would
    // double-count the switch.
    expect(host.track).not.toHaveBeenCalled();
  });

  it('leaves model_switch to the engine when a lazy session came live mid-flow and rebounded', async () => {
    // Session-less at entry, but the first prompt's lazy creation completes
    // while setConfig / the refresh are pending, so the session-only re-apply
    // lands on the now-live session and actually switches its alias (engine
    // emits).
    const { host } = makeHost({ activateReachedLiveSession: true });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).not.toHaveBeenCalled();
  });

  it('emits model_switch when a v1-created session only rebinds the same alias', async () => {
    // v1 session-less + session-only effort: the refresh creates the session
    // with the picked model (creation emits nothing), then the re-apply
    // reaches that live session but its setModel is an alias no-op (no engine
    // event either) — the TUI must stay the producer for the pick.
    const { host } = makeHost({
      refreshReachedLiveSession: false,
      activateReachedLiveSession: false,
    });

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.activateModelAfterLogin).toHaveBeenCalledWith('opus', 'xhigh');
    expect(host.track).toHaveBeenCalledWith('model_switch', { model: 'opus' });
  });

  it('waits for an in-flight lazy creation before activating (v2)', async () => {
    const { host } = makeHost();

    await setDefaultModel(host, 'opus', 'high');

    expect(host.waitForSessionAssembly).toHaveBeenCalled();
    expect(
      host.waitForSessionAssembly.mock.invocationCallOrder[0]!,
    ).toBeLessThan(host.harness.setConfig.mock.invocationCallOrder[0]!);
  });

  it('skips the follow-up activation and forwards the picked effort when the gate owns the switch', async () => {
    const { host } = makeHost();
    host.authFlow.refreshConfigAfterLogin = vi.fn(async () => 'gated' as const);

    await setDefaultModel(host, 'opus', 'xhigh');

    expect(host.authFlow.refreshConfigAfterLogin).toHaveBeenCalledWith('xhigh');
    expect(host.authFlow.activateModelAfterLogin).not.toHaveBeenCalled();
    expect(host.track).not.toHaveBeenCalled();
  });
});

function makeRefreshHost(result: RefreshProviderModelsResponse | Error) {
  const spinner = { stop: vi.fn() };
  const host = {
    showProgressSpinner: vi.fn(() => spinner),
    showStatus: vi.fn(),
    showError: vi.fn(),
    authFlow: {
      refreshProviderModels: vi.fn(async () => {
        if (result instanceof Error) throw result;
        return result;
      }),
    },
    modelMigration: { retire: vi.fn(async () => {}) },
  } as unknown as SlashCommandHost & {
    showProgressSpinner: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    authFlow: { refreshProviderModels: ReturnType<typeof vi.fn> };
    modelMigration: { retire: ReturnType<typeof vi.fn> };
  };
  return { host, spinner };
}

describe('handleProviderCommand refresh', () => {
  it('refreshes every provider and reports added, removed, and failed', async () => {
    const retired = { from: 'kimi/old', to: 'kimi/new', from_display_name: 'Old Model' };
    const { host, spinner } = makeRefreshHost({
      changed: [{ provider_id: 'kimi', provider_name: 'Kimi Code', added: 2, removed: 1 }],
      unchanged: ['other'],
      failed: [{ provider: 'broken', reason: 'HTTP 500' }],
      retired_default: retired,
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.authFlow.refreshProviderModels).toHaveBeenCalledWith(undefined);
    expect(spinner.stop).toHaveBeenCalledWith({ ok: true, label: 'Refresh finished.' });
    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code: +2 / -1 models.', 'warning');
    expect(host.showStatus).toHaveBeenCalledWith(
      'Skipped refreshing broken: HTTP 500',
      'warning',
    );
    expect(host.modelMigration.retire).toHaveBeenCalledWith(retired);
  });

  it('scopes the refresh to one provider when a providerId is given', async () => {
    const { host } = makeRefreshHost({ changed: [], unchanged: ['custom'], failed: [] });

    await handleProviderCommand(host, 'refresh custom');

    expect(host.authFlow.refreshProviderModels).toHaveBeenCalledWith({
      providerId: 'custom',
    });
  });

  it('reports a plain status when nothing was removed', async () => {
    const { host } = makeRefreshHost({
      changed: [{ provider_id: 'kimi', provider_name: 'Kimi Code', added: 1, removed: 0 }],
      unchanged: [],
      failed: [],
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith('Kimi Code: +1 model.', undefined);
    expect(host.modelMigration.retire).not.toHaveBeenCalled();
  });

  it('reports when every provider is already up to date', async () => {
    const { host } = makeRefreshHost({ changed: [], unchanged: ['a', 'b'], failed: [] });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith(
      'No model changes (2 providers up to date).',
    );
  });

  it('surfaces a thrown refresh without routing a retirement', async () => {
    const { host, spinner } = makeRefreshHost(new Error('provider missing does not exist'));

    await handleProviderCommand(host, 'refresh missing');

    expect(spinner.stop).toHaveBeenCalledWith({ ok: false, label: 'Refresh failed.' });
    expect(host.showError).toHaveBeenCalledWith(
      'Failed to refresh models: provider missing does not exist',
    );
    expect(host.modelMigration.retire).not.toHaveBeenCalled();
  });

  it('rejects unknown subcommands with a usage line instead of refreshing', async () => {
    const { host, spinner } = makeRefreshHost({ changed: [], unchanged: [], failed: [] });

    await handleProviderCommand(host, 'refres');

    expect(host.showError).toHaveBeenCalledWith('Usage: /provider [refresh [providerId]]');
    expect(host.showProgressSpinner).not.toHaveBeenCalled();
    expect(host.authFlow.refreshProviderModels).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
  });

  it('reports metadata-only updates without the model counters', async () => {
    const { host } = makeRefreshHost({
      changed: [{ provider_id: 'custom', provider_name: 'Custom Registry', added: 0, removed: 0 }],
      unchanged: [],
      failed: [],
    });

    await handleProviderCommand(host, 'refresh');

    expect(host.showStatus).toHaveBeenCalledWith('Custom Registry: model metadata updated.');
  });

  it('rejects surplus arguments after the provider id instead of refreshing', async () => {
    const { host, spinner } = makeRefreshHost({ changed: [], unchanged: [], failed: [] });

    await handleProviderCommand(host, 'refresh custom unexpected');

    expect(host.showError).toHaveBeenCalledWith('Usage: /provider [refresh [providerId]]');
    expect(host.authFlow.refreshProviderModels).not.toHaveBeenCalled();
    expect(spinner.stop).not.toHaveBeenCalled();
  });
});
