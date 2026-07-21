import type { ExperimentalFeatureState } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import {
  applyExperimentalFeatureChanges,
} from '#/tui/commands/config';
import {
  isExperimentalFlagEnabled,
  setExperimentalFeatures,
} from '#/tui/commands/experimental-flags';
import { darkColors } from '#/tui/theme/colors';

function feature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return {
    id: 'micro_compaction',
    title: 'Micro compaction',
    description: 'Trim older tool results.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
    defaultEnabled: true,
    enabled: true,
    source: 'default',
    ...overrides,
  };
}

function dualModelRoutingFeature(
  overrides: Partial<ExperimentalFeatureState> = {},
): ExperimentalFeatureState {
  return feature({
    id: 'dual-model-routing',
    title: 'Dual-model routing',
    description: 'Run subagents on a dedicated model.',
    surface: 'core',
    env: 'KIMI_CODE_EXPERIMENTAL_DUAL_MODEL_ROUTING',
    defaultEnabled: false,
    enabled: false,
    source: 'default',
    ...overrides,
  });
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
      getConfig: vi.fn(async () => ({ providers: {} })),
      getExperimentalFeatures: vi.fn(async () => [
        feature({ enabled: false, source: 'config', configValue: false }),
      ]),
    },
    session,
    refreshSlashCommandAutocomplete: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    setAppState: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      setConfig: ReturnType<typeof vi.fn>;
      getConfig: ReturnType<typeof vi.fn>;
      getExperimentalFeatures: ReturnType<typeof vi.fn>;
    };
    refreshSlashCommandAutocomplete: ReturnType<typeof vi.fn>;
    reloadCurrentSessionView: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    restoreEditor: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    setAppState: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
    session: typeof session;
  };
  return host;
}

/** Make a host whose session is undefined (the no-session path exercises the
 *  manual subagent-model sync in applyExperimentalFeatureChanges). */
function makeNoSessionHost() {
  const host = makeHost();
  return { ...host, session: undefined };
}

describe('experimental feature command handlers', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('persists config overrides, refreshes command flags, closes the panel, and reloads', async () => {
    const host = makeHost();

    await applyExperimentalFeatureChanges(host, [
      { id: 'micro_compaction', enabled: false },
    ]);

    expect(host.harness.setConfig).toHaveBeenCalledWith({
      experimental: { 'micro_compaction': false },
    });
    expect(host.harness.getExperimentalFeatures).toHaveBeenCalledOnce();
    expect(isExperimentalFlagEnabled('micro_compaction')).toBe(false);
    expect(host.refreshSlashCommandAutocomplete).toHaveBeenCalled();
    expect(host.restoreEditor).toHaveBeenCalled();
    expect(host.session.reloadSession).toHaveBeenCalledOnce();
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      host.session,
      'Experimental features updated. Session reloaded.',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
    expect(host.track).toHaveBeenCalledWith('experimental_features_apply', {
      changed: 1,
    });
    expect(host.showStatus).not.toHaveBeenCalledWith(
      'Experimental features updated.',
      darkColors.success,
    );
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
});

describe('applyExperimentalFeatureChanges dual-model-routing sync', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  it('populates subagentModel/subagentThinkingEffort from config when enabling (no session)', async () => {
    const host = makeNoSessionHost();
    host.harness.getExperimentalFeatures.mockResolvedValueOnce([
      dualModelRoutingFeature({ enabled: true, source: 'config', configValue: true }),
    ]);
    host.harness.getConfig.mockResolvedValueOnce({
      defaultSubagentModel: 'glm-5.2',
      defaultSubagentThinkingEffort: 'high',
    });

    await applyExperimentalFeatureChanges(host, [
      { id: 'dual-model-routing', enabled: true },
    ]);

    expect(host.setAppState).toHaveBeenCalledWith({
      subagentModel: 'glm-5.2',
      subagentThinkingEffort: 'high',
    });
  });

  it('clears subagentModel/subagentThinkingEffort when disabling (no session)', async () => {
    const host = makeNoSessionHost();
    // Seed the flag as enabled so the disabling change is observed.
    setExperimentalFeatures([{ id: 'dual-model-routing', enabled: true }]);
    host.harness.getExperimentalFeatures.mockResolvedValueOnce([
      dualModelRoutingFeature({ enabled: false, source: 'config', configValue: false }),
    ]);

    await applyExperimentalFeatureChanges(host, [
      { id: 'dual-model-routing', enabled: false },
    ]);

    expect(host.setAppState).toHaveBeenCalledWith({
      subagentModel: undefined,
      subagentThinkingEffort: undefined,
    });
  });

  it('skips the manual setAppState sync when a session is present (reload covers it)', async () => {
    const host = makeHost();
    host.harness.getExperimentalFeatures.mockResolvedValueOnce([
      dualModelRoutingFeature({ enabled: true, source: 'config', configValue: true }),
    ]);

    await applyExperimentalFeatureChanges(host, [
      { id: 'dual-model-routing', enabled: true },
    ]);

    // setAppState is never called with a subagentModel patch in the session
    // branch — reloadSession + reloadCurrentSessionView own that sync.
    const calls = host.setAppState.mock.calls as ReadonlyArray<
      ReadonlyArray<Record<string, unknown>>
    >;
    expect(
      calls.some(
        (call) =>
          call[0]?.['subagentModel'] !== undefined ||
          call[0]?.['subagentThinkingEffort'] !== undefined,
      ),
    ).toBe(false);
  });
});
