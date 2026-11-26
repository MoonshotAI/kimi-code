import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { applyExperimentalFeatureChanges } from '#/tui/commands/config';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import { darkColors } from '#/tui/theme/colors';

function feature(overrides: Partial<ExperimentalFeatureState> = {}): ExperimentalFeatureState {
  const enabled = overrides.enabled ?? true;
  return {
    id: 'prompt_prediction',
    title: 'Prompt prediction',
    description: 'Predict the next prompt.',
    stage: 'experimental',
    effectTiming: 'immediate',
    env: 'KIMI_CODE_EXPERIMENTAL_PROMPT_PREDICTION',
    enabled,
    active: overrides.active ?? enabled,
    source: 'default',
    ...overrides,
  };
}

function makeHost() {
  const session = {
    id: 'ses-experiments',
    reloadSession: vi.fn(async () => ({})),
  };
  const host = {
    state: {
      theme: { palette: darkColors },
      ui: { requestRender: vi.fn() },
    },
    harness: {
      setConfig: vi.fn(async () => ({ providers: {} })),
      getExperimentalFeatures: vi.fn(async () => [
        feature({ enabled: false, active: false, source: 'config', configValue: false }),
      ]),
      getExperimentalBetaState: vi.fn(async () => ({
        enabled: false,
        source: 'default' as const,
        env: 'KIMI_CODE_EXPERIMENTAL_FLAG',
      })),
      reloadSession: vi.fn(async () => session),
    },
    session,
    refreshSlashCommandAutocomplete: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
    refreshWorkLocation: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      setConfig: ReturnType<typeof vi.fn>;
      getExperimentalFeatures: ReturnType<typeof vi.fn>;
      getExperimentalBetaState: ReturnType<typeof vi.fn>;
      reloadSession: ReturnType<typeof vi.fn>;
    };
    refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    refreshWorkLocation: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    session: typeof session;
  };
  return host;
}

describe('experimental feature command handlers', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('persists config overrides, refreshes command flags, closes the panel, and reloads immediate features', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [{ id: 'prompt_prediction', enabled: false }]);

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      experimental: { prompt_prediction: false },
    });
    expect(host.harness.getExperimentalFeatures).toHaveBeenCalledOnce();
    expect(isExperimentalFlagEnabled('prompt_prediction')).toBe(false);
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.harness.reloadSession).toHaveBeenCalledWith({ id: host.session.id });
    expect(host.session.reloadSession).not.toHaveBeenCalled();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      host.session,
      'Experimental features updated. Session reloaded.',
    );
    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
      flags: '',
    });
  });

  it.each([true, false])(
    'skips session reload for next-session features and notices when enabled: %s',
    async (enabled) => {
      const host = makeHost();
      host.harness.getExperimentalFeatures.mockResolvedValue([
        feature({
          id: 'notify_user',
          title: 'Updates',
          stage: 'beta',
          effectTiming: 'next-session',
          enabled,
          active: enabled,
        }),
      ]);
      await applyExperimentalFeatureChanges(host, [{ id: 'notify_user', enabled }]);
      expect(host.harness.setConfig).toHaveBeenCalledWith({
        experimental: { notify_user: enabled },
      });
      expect(isExperimentalFlagEnabled('notify_user')).toBe(enabled);
      expect(host.harness.reloadSession).not.toHaveBeenCalled();
      expect(host.showNotice.mock.calls).toEqual(
        enabled
          ? [['Start a new session to use Updates if this session was created with the feature disabled.']]
          : [],
      );
    },
  );

  it('excludes GA features from experimental_features_apply telemetry', async () => {
    const host = makeHost();
    host.harness.getExperimentalFeatures.mockResolvedValue([
      feature({ id: 'notify_user', stage: 'ga', enabled: true, active: true }),
      feature({ id: 'wait_for', stage: 'experimental', enabled: true, active: true }),
      feature({ id: 'prompt_prediction', stage: 'experimental', enabled: true, active: true }),
      feature({ id: 'tower', stage: 'experimental', enabled: false, active: false }),
    ]);

    await applyExperimentalFeatureChanges(host, [{ id: 'wait_for', enabled: true }]);

    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
      flags: 'prompt_prediction,wait_for',
    });
  });

  it('does not write config when there are no drafted changes', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, []);

    expect(host.harness.setConfig).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'No experimental feature changes to apply.',
      'textMuted',
    );
  });

  it('shows restart notice without reloading session when a restart-timed feature changes, and keeps active false until restart', async () => {
    const host = makeHost();
    host.harness.getExperimentalFeatures.mockResolvedValue([
      feature({
        id: 'tower',
        title: 'Tower mode',
        stage: 'experimental',
        effectTiming: 'restart',
        enabled: true,
        active: false,
      }),
    ]);

    await applyExperimentalFeatureChanges(host, [{ id: 'tower', enabled: true }]);

    expect(host.harness.reloadSession).not.toHaveBeenCalled();
    expect(isExperimentalFlagEnabled('tower')).toBe(false);
    expect(host.showNotice).toHaveBeenCalledWith(
      'Tower mode takes effect after restarting Kimi Code.',
    );

    host.showNotice.mockClear();
    host.harness.getExperimentalFeatures.mockResolvedValue([
      feature({
        id: 'tower',
        title: 'Tower mode',
        stage: 'experimental',
        effectTiming: 'restart',
        enabled: false,
        active: false,
      }),
    ]);

    await applyExperimentalFeatureChanges(host, [{ id: 'tower', enabled: false }]);

    expect(isExperimentalFlagEnabled('tower')).toBe(false);
    expect(host.showNotice).not.toHaveBeenCalled();
  });

  it('re-resolves the working directory when worktree changes directly or via the beta master switch', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [{ id: 'micro_compaction', enabled: false }]);
    expect(host.refreshWorkLocation).not.toHaveBeenCalled();

    await applyExperimentalFeatureChanges(host, [{ id: 'worktree', enabled: true }]);
    expect(host.refreshWorkLocation).toHaveBeenCalledOnce();

    host.refreshWorkLocation.mockClear();
    setExperimentalFeatures([
      feature({ id: 'worktree', stage: 'beta', enabled: false, active: false }),
    ]);
    host.harness.getExperimentalFeatures.mockResolvedValue([
      feature({ id: 'worktree', stage: 'beta', enabled: true, active: true, source: 'beta-config' }),
    ]);
    await applyExperimentalFeatureChanges(host, [{ id: 'beta', enabled: true }]);
    expect(host.refreshWorkLocation).toHaveBeenCalledOnce();
  });
});
