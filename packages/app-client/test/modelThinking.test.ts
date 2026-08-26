import { computed, nextTick, reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel, AppSession, KimiWebApi, ThinkingLevel } from '@moonshot-ai/app-core/api';
import {
  useModelProviderState,
  type UseModelProviderStateDeps,
} from '../src/client/useModelProviderState';
import { modelsStore } from '../src/stores/models';
import type { ExtendedState } from '../src/client/types';
import {
  ackThinkingPending,
  commitLevel,
  defaultThinkingLevelFor,
  effectiveThinkingLevel,
  effortLabel,
  foldDaemonThinkingLevel,
  isThinkingOn,
  levelDeclaredBy,
  markThinkingPending,
  modelThinkingAvailability,
  segmentsFor,
  thinkingLevelForModelSwitch,
  thinkingLevelFromConfig,
  thinkingLevelToConfig,
} from '@moonshot-ai/app-core/lib';
import type { ModelThinkingInfo } from '@moonshot-ai/app-core/lib';

// The api is injected; stub the endpoints the model/provider module calls.
const apiMock = {
  updateSession: vi.fn(),
  listModels: vi.fn(),
  setConfig: vi.fn(),
  activateSkill: vi.fn(),
};
const api = apiMock as unknown as KimiWebApi;

function model(partial: ModelThinkingInfo): ModelThinkingInfo {
  return partial;
}

describe('modelThinking', () => {
  describe('modelThinkingAvailability', () => {
    it('defaults to toggle when model is unknown', () => {
      expect(modelThinkingAvailability(undefined)).toBe('toggle');
    });

    it('detects always_thinking capability', () => {
      expect(modelThinkingAvailability(model({ capabilities: ['always_thinking'] }))).toBe('always-on');
    });

    it('detects thinking capability', () => {
      expect(modelThinkingAvailability(model({ capabilities: ['thinking'] }))).toBe('toggle');
    });

    it('detects adaptive thinking', () => {
      expect(modelThinkingAvailability(model({ adaptiveThinking: true }))).toBe('toggle');
    });

    it('marks models without thinking support as unsupported', () => {
      expect(modelThinkingAvailability(model({ capabilities: ['vision'] }))).toBe('unsupported');
    });
  });

  describe('foldDaemonThinkingLevel + pending marks', () => {
    function state() {
      return {
        thinkingBySession: {} as Record<string, ThinkingLevel>,
        pendingThinkingBySession: {} as Record<string, number>,
      };
    }

    it('applies the daemon level when no pick is pending', () => {
      const s = state();
      foldDaemonThinkingLevel(s, 's1', 'high');
      expect(s.thinkingBySession['s1']).toBe('high');
    });

    it('drops every report while a pick is pending, even a matching echo', () => {
      const s = state();
      s.thinkingBySession['s1'] = 'max';
      markThinkingPending(s, 's1');
      foldDaemonThinkingLevel(s, 's1', 'high');
      foldDaemonThinkingLevel(s, 's1', 'max');
      expect(s.thinkingBySession['s1']).toBe('max');
      expect(s.pendingThinkingBySession['s1']).toBeDefined();
    });

    it('acks only the completion of the latest write, then resumes folding', () => {
      const s = state();
      s.thinkingBySession['s1'] = 'max';
      const stale = markThinkingPending(s, 's1');
      const latest = markThinkingPending(s, 's1');
      // A completion for the superseded write must not clear the shield.
      expect(ackThinkingPending(s, 's1', stale)).toBe(false);
      expect(s.pendingThinkingBySession['s1']).toBe(latest);
      foldDaemonThinkingLevel(s, 's1', 'low');
      expect(s.thinkingBySession['s1']).toBe('max');
      expect(ackThinkingPending(s, 's1', latest)).toBe(true);
      foldDaemonThinkingLevel(s, 's1', 'low');
      expect(s.thinkingBySession['s1']).toBe('low');
    });
  });

  describe('defaultThinkingLevelFor', () => {
    it('returns off for unsupported models', () => {
      expect(defaultThinkingLevelFor(model({ capabilities: [] }))).toBe('off');
    });

    it('returns the declared default effort for effort models', () => {
      expect(defaultThinkingLevelFor(model({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' }))).toBe('high');
    });

    it('falls back to the middle effort when no default is declared', () => {
      expect(defaultThinkingLevelFor(model({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'] }))).toBe('high');
      expect(defaultThinkingLevelFor(model({ capabilities: ['thinking'], supportEfforts: ['low', 'high'] }))).toBe('high');
    });

    it('returns on for boolean thinking models', () => {
      expect(defaultThinkingLevelFor(model({ capabilities: ['thinking'] }))).toBe('on');
    });
  });

  describe('segmentsFor', () => {
    it('shows off/on for boolean toggle models', () => {
      expect(segmentsFor(model({ capabilities: ['thinking'] }))).toEqual(['on', 'off']);
    });

    it('shows only on for always-on models', () => {
      expect(segmentsFor(model({ capabilities: ['always_thinking'] }))).toEqual(['on']);
    });

    it('shows only off for unsupported models', () => {
      expect(segmentsFor(model({ capabilities: [] }))).toEqual(['off']);
    });

    it('prefixes off to effort lists for toggle effort models', () => {
      expect(segmentsFor(model({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'] }))).toEqual(['off', 'low', 'high', 'max']);
    });

    it('omits off for always-on effort models', () => {
      expect(segmentsFor(model({ capabilities: ['always_thinking'], supportEfforts: ['low', 'high'] }))).toEqual(['low', 'high']);
    });
  });

  const effortModel = model({ capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max'], defaultEffort: 'high' });
  const booleanModel = model({ capabilities: ['thinking'] });
  const alwaysOnModel = model({ capabilities: ['always_thinking'] });
  const maxOnlyModel = model({ capabilities: ['always_thinking'], supportEfforts: ['max'], defaultEffort: 'max' });
  const unsupportedModel = model({ capabilities: [] });

  describe('thinkingLevelForModelSwitch', () => {
    it('pre-selects the target model default effort on a switch', () => {
      expect(thinkingLevelForModelSwitch(effortModel, 'off', true)).toBe('high');
      expect(thinkingLevelForModelSwitch(effortModel, 'max', true)).toBe('high');
      expect(thinkingLevelForModelSwitch(effortModel, undefined, true)).toBe('high');
    });

    it('keeps the current level when re-selecting the same model', () => {
      expect(thinkingLevelForModelSwitch(effortModel, 'off', false)).toBe('off');
      expect(thinkingLevelForModelSwitch(effortModel, 'max', false)).toBe('max');
      expect(thinkingLevelForModelSwitch(effortModel, undefined, false)).toBeUndefined();
    });

    it('pre-selects on for boolean and always-on models on a switch', () => {
      expect(thinkingLevelForModelSwitch(booleanModel, 'off', true)).toBe('on');
      expect(thinkingLevelForModelSwitch(alwaysOnModel, 'off', true)).toBe('on');
    });

    it('pre-selects off for unsupported models on a switch', () => {
      expect(thinkingLevelForModelSwitch(unsupportedModel, 'high', true)).toBe('off');
    });

    it('keeps the current level when the target model is unknown', () => {
      expect(thinkingLevelForModelSwitch(undefined, 'max', true)).toBe('max');
      expect(thinkingLevelForModelSwitch(undefined, undefined, true)).toBeUndefined();
    });

    it('prefers the daemon-wide config default over the catalog default on a switch', () => {
      expect(
        thinkingLevelForModelSwitch(effortModel, 'off', true, { enabled: true, effort: 'low' }),
      ).toBe('low');
    });

    it('falls back to the catalog default when the target model does not declare the config level', () => {
      expect(
        thinkingLevelForModelSwitch(booleanModel, 'off', true, { enabled: true, effort: 'low' }),
      ).toBe('on');
    });
  });

  describe('effectiveThinkingLevel', () => {
    it('returns the stored level when set', () => {
      expect(effectiveThinkingLevel(effortModel, 'max')).toBe('max');
      expect(effectiveThinkingLevel(effortModel, 'off')).toBe('off');
    });

    it('falls back to the model default when there is no preference', () => {
      expect(effectiveThinkingLevel(effortModel, undefined)).toBe('high');
      expect(effectiveThinkingLevel(booleanModel, undefined)).toBe('on');
      expect(effectiveThinkingLevel(unsupportedModel, undefined)).toBe('off');
    });
  });

  describe('effortLabel', () => {
    it('capitalizes effort names', () => {
      expect(effortLabel('off')).toBe('Off');
      expect(effortLabel('high')).toBe('High');
      expect(effortLabel('max')).toBe('Max');
    });

    it('returns empty string as-is', () => {
      expect(effortLabel('')).toBe('');
    });
  });

  describe('isThinkingOn', () => {
    it('returns false for off only', () => {
      expect(isThinkingOn('off')).toBe(false);
      expect(isThinkingOn('on')).toBe(true);
      expect(isThinkingOn('high')).toBe(true);
    });
  });

  describe('levelDeclaredBy', () => {
    it('accepts levels selectable for the model', () => {
      expect(levelDeclaredBy(effortModel, 'low')).toBe(true);
      expect(levelDeclaredBy(effortModel, 'off')).toBe(true);
      expect(levelDeclaredBy(booleanModel, 'on')).toBe(true);
      expect(levelDeclaredBy(alwaysOnModel, 'on')).toBe(true);
    });

    it('rejects levels the model does not declare', () => {
      expect(levelDeclaredBy(booleanModel, 'low')).toBe(false);
      expect(levelDeclaredBy(alwaysOnModel, 'off')).toBe(false);
      expect(levelDeclaredBy(maxOnlyModel, 'low')).toBe(false);
      expect(levelDeclaredBy(unsupportedModel, 'max')).toBe(false);
    });
  });

  describe('commitLevel', () => {
    it('keeps off', () => {
      expect(commitLevel(effortModel, 'off')).toBe('off');
    });

    it('resolves on to the model default', () => {
      expect(commitLevel(effortModel, 'on')).toBe('high');
    });

    it('passes concrete efforts through', () => {
      expect(commitLevel(effortModel, 'max')).toBe('max');
    });
  });

  describe('thinkingLevelToConfig', () => {
    it('disables thinking for off', () => {
      expect(thinkingLevelToConfig('off')).toEqual({ enabled: false });
    });

    it('records only enabled for boolean on', () => {
      expect(thinkingLevelToConfig('on')).toEqual({ enabled: true });
    });

    it('persists levels below the model top tier as the global default', () => {
      expect(thinkingLevelToConfig('low', ['low', 'high', 'max'])).toEqual({
        enabled: true,
        effort: 'low',
      });
      expect(thinkingLevelToConfig('high', ['low', 'high', 'max'])).toEqual({
        enabled: true,
        effort: 'high',
      });
    });

    it('records only enabled for the model top tier', () => {
      expect(thinkingLevelToConfig('max', ['low', 'high', 'max'])).toEqual({ enabled: true });
      expect(thinkingLevelToConfig('max', ['max'])).toEqual({ enabled: true });
    });

    it('persists concrete levels as-is when the model levels are unknown', () => {
      expect(thinkingLevelToConfig('max')).toEqual({ enabled: true, effort: 'max' });
      expect(thinkingLevelToConfig('ultra')).toEqual({ enabled: true, effort: 'ultra' });
    });
  });

  describe('thinkingLevelFromConfig', () => {
    it('returns undefined for a missing or malformed section', () => {
      expect(thinkingLevelFromConfig(undefined, effortModel)).toBeUndefined();
      expect(thinkingLevelFromConfig(null, effortModel)).toBeUndefined();
      expect(thinkingLevelFromConfig('nonsense', effortModel)).toBeUndefined();
    });

    it('resolves off only when the model can actually be turned off', () => {
      expect(thinkingLevelFromConfig({ enabled: false }, effortModel)).toBe('off');
      // always-on models never declare off — a stale enabled:false from a
      // different model must not blank out the control.
      expect(thinkingLevelFromConfig({ enabled: false }, alwaysOnModel)).toBeUndefined();
    });

    it('never falls through to a leftover effort once enabled is false', () => {
      // enabled:false is terminal even when the model can't honor "off": a
      // stale effort from a PREVIOUS model that this always-on model happens
      // to also declare must not resurface just because the disable itself
      // couldn't apply.
      expect(thinkingLevelFromConfig({ enabled: false, effort: 'max' }, maxOnlyModel)).toBeUndefined();
    });

    it('resolves a stored effort only when the model still declares it', () => {
      expect(thinkingLevelFromConfig({ enabled: true, effort: 'low' }, effortModel)).toBe('low');
      // A foreign effort left over from a different model is ignored, not
      // force-applied.
      expect(thinkingLevelFromConfig({ enabled: true, effort: 'ultra' }, effortModel)).toBeUndefined();
      expect(thinkingLevelFromConfig({ effort: 'low' }, booleanModel)).toBeUndefined();
    });

    it('returns undefined when enabled is true with no effort — caller falls back to the model default', () => {
      expect(thinkingLevelFromConfig({ enabled: true }, effortModel)).toBeUndefined();
    });
  });
});

describe('useModelProviderState thinking on model selection', () => {
  const effortAppModel: AppModel = {
    id: 'provider/effort-model',
    provider: 'provider',
    model: 'effort-model',
    maxContextSize: 128_000,
    capabilities: ['thinking'],
    supportEfforts: ['low', 'high', 'max'],
    defaultEffort: 'high',
  };
  const booleanAppModel: AppModel = {
    id: 'provider/boolean-model',
    provider: 'provider',
    model: 'boolean-model',
    maxContextSize: 128_000,
    capabilities: ['thinking'],
  };
  const maxOnlyAppModel: AppModel = {
    id: 'provider/max-model',
    provider: 'provider',
    model: 'max-model',
    maxContextSize: 128_000,
    capabilities: ['always_thinking'],
    supportEfforts: ['max'],
    defaultEffort: 'max',
  };

  const persistSessionProfileMock = vi.fn();

  beforeEach(() => {
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    apiMock.listModels.mockReset();
    apiMock.listModels.mockResolvedValue([effortAppModel, booleanAppModel, maxOnlyAppModel]);
    apiMock.setConfig.mockReset();
    apiMock.setConfig.mockResolvedValue({});
    apiMock.activateSkill.mockReset();
    apiMock.activateSkill.mockResolvedValue({});
    persistSessionProfileMock.mockReset();
    persistSessionProfileMock.mockResolvedValue(true);
  });

  function createState(options: {
    activeSession?: Pick<AppSession, 'id' | 'model'>;
    defaultModel: string;
    /** GET /config's `thinking` section — omit to mirror "config not loaded /
     *  no daemon-wide preference set". */
    configThinking?: { enabled?: boolean; effort?: string };
  }): ExtendedState {
    return {
      activeSessionId: options.activeSession?.id ?? null,
      sessions: options.activeSession ? [options.activeSession] : [],
      thinking: 'off',
      thinkingBySession: {},
      pendingThinkingBySession: {},
      planModeBySession: {},
      planArmedBySession: {},
      pendingPlanBySession: {},
      goalModeBySession: {},
      goalBySession: {},
      defaultModel: options.defaultModel,
      inFlightBySession: {},
      optimisticMessagesBySession: {},
      // The real ExtendedState always carries a permission mode; the skill
      // activation pre-write reads it for the retry payload.
      permission: 'auto',
      config: options.configThinking ? { thinking: options.configThinking } : null,
    } as ExtendedState;
  }

  function createModelProvider(state: ExtendedState, depOverrides: Partial<UseModelProviderStateDeps> = {}) {
    const deps: UseModelProviderStateDeps = {
      api,
      beginLocalTurn: () => 0,
      settleLocalTurn: vi.fn(),
      pushOperationFailure: vi.fn(),
      refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
      persistSessionProfile: persistSessionProfileMock,
      savePlanModeToStorage: vi.fn(),
      activity: computed(() => 'idle'),
      updateSession: (id, update) => {
        state.sessions = state.sessions.map((session) =>
          session.id === id ? update(session) : session,
        );
      },
      loadConfig: vi.fn().mockResolvedValue(undefined),
      checkAuth: vi.fn().mockResolvedValue(undefined),
      ...depOverrides,
    };
    const provider = useModelProviderState(state, deps);
    // Models state lives in the shared store now (P10) — seed it there, and
    // reset the other slices so tests stay isolated.
    const store = modelsStore();
    store.setModels([effortAppModel, booleanAppModel, maxOnlyAppModel]);
    store.setDraftModel(null);
    store.setProviders([]);
    return provider;
  }

  it('keeps thinking off when re-selecting the default model in a new-session draft', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('off');
  });

  it('keeps thinking off when re-selecting an explicit new-session draft model', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    // Switch the draft to the effort model (catalog default applies), then
    // explicitly turn thinking off — re-selecting the same model must keep it.
    await provider.setModel(effortAppModel.id);
    provider.setThinking('off');
    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('off');
  });

  it('keeps thinking off when an active session inherits the selected default model', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: '' },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('off');
    expect(apiMock.updateSession).toHaveBeenCalledWith('session-1', {
      model: effortAppModel.id,
      thinking: undefined,
    });
  });

  it('enables the default effort when switching from a different model', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('high');
  });

  it('prefers the daemon-wide config default over the catalog default when switching the draft model', async () => {
    // A new-session draft (no active session) has no session-scoped daemon
    // call to persist through — setModel's own thinkingLevelForModelSwitch
    // must apply the config fallback itself, not just thinkingLevelForSession.
    const state = createState({
      defaultModel: booleanAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('low');
  });

  it('uses the target model catalog default, not the config default, when switching models in an active session', async () => {
    // config.thinking is the NEW-SESSION default — an existing, already-
    // running session switching models is a different action and must keep
    // resetting to the target model's own catalog default, same as before
    // the config fallback existed.
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('high');
  });

  it('applies the resolved level to the session profile before activating a skill', async () => {
    // Skill activation carries no thinking — the daemon runs at the session
    // profile effort. The resolved level must be persisted there first, or the
    // skill runs at a stale profile effort the UI no longer shows.
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith({ thinking: 'high', swarmMode: false, permissionMode: 'auto' }, 'session-1');
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, []);
    // The profile write precedes the activation, mirroring the new-session path.
    const persistOrder = persistSessionProfileMock.mock.invocationCallOrder[0]!;
    const activateOrder = apiMock.activateSkill.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(activateOrder);
  });

  it('skips the thinking profile write when the caller already persisted it', async () => {
    // The new-session skill path awaits a profile patch that already carries
    // the level — a second write here would only add a transient-failure veto.
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets', undefined, undefined, undefined, { skipThinkingPersist: true });

    expect(persistSessionProfileMock).not.toHaveBeenCalled();
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, []);
  });

  it('does not activate the skill when the thinking profile update fails', async () => {
    // persistSessionProfile resolves false after surfacing the failure itself:
    // activating would run the skill at the stale profile effort, so it must
    // not happen — and activateSkill must not report a second, synthetic error.
    persistSessionProfileMock.mockResolvedValue(false);
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(apiMock.activateSkill).not.toHaveBeenCalled();
    expect(state.inFlightBySession['session-1']).toBe(false);
  });

  it('cashes an armed plan intent through the activation persist and consumes it', async () => {
    // The activation's pre-write is the cashing point for an armed plan intent
    // (no composer send happens): planMode:true rides the same profile patch,
    // and a successful persist consumes the intent + mirrors the fact.
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    state.planArmedBySession = { 'session-1': true };
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: true }),
      'session-1',
    );
    expect(state.planArmedBySession['session-1']).toBe(false);
    expect(state.planModeBySession['session-1']).toBe(true);
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, []);
  });

  it('resolves an empty session model through the default model before activating a skill', async () => {
    // The daemon's profile echo can leave session.model '' — the same fallback
    // the prompt/BTW/steer paths apply must hold here too, or the profile gets
    // the raw active level instead of the target session model's default.
    const state = createState({
      activeSession: { id: 'session-1', model: '' },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith({ thinking: 'high', swarmMode: false, permissionMode: 'auto' }, 'session-1');
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, []);
  });

  it('pins the catalog default in memory when no thinking preference exists', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    state.thinking = undefined;
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('high');
  });

  it('re-resolves the config default once config lands after loadModels() during boot', async () => {
    // load()'s boot sequence always finishes loadModels() before loadConfig()
    // starts (see useWorkspaceState.load()) — the first resolution here is
    // necessarily config-blind. The watcher's own rawState.config source
    // picks the default up as soon as it lands, no special-cased call needed.
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);

    await provider.loadModels();
    expect(state.thinking).toBe('high'); // config not "loaded" yet — catalog default

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();

    expect(state.thinking).toBe('low');
  });

  it('applies the daemon-wide config default for a session with no level of its own', async () => {
    // A genuinely new session (no thinkingBySession entry yet) must honor
    // config.thinking — this is the value the Settings picker itself shows,
    // and until this fallback existed the client silently ignored it in favor
    // of the catalog default.
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('low');
  });

  it('ignores a config default the active model does not declare', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('on');
  });

  it('prefers the session own level over the config default', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    state.thinkingBySession = { 'session-1': 'max' };
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('max');
  });

  it('drops a session level the active model does not declare', async () => {
    // A level the session ran with must not leak onto a model that cannot run
    // it — resolution falls back to the model default.
    const state = createState({
      activeSession: { id: 'session-1', model: maxOnlyAppModel.id },
      defaultModel: maxOnlyAppModel.id,
    });
    state.thinkingBySession = { 'session-1': 'low' };
    state.thinking = 'low';
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('max');
  });

  it('re-resolves the level when the active session switches to another model', async () => {
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: maxOnlyAppModel.id },
        defaultModel: maxOnlyAppModel.id,
      }),
    ) as ExtendedState;
    state.sessions = [
      { id: 'session-1', model: maxOnlyAppModel.id },
      { id: 'session-2', model: effortAppModel.id },
    ] as AppSession[];
    state.thinking = 'max';
    createModelProvider(state);

    state.activeSessionId = 'session-2';
    await nextTick();
    // No session level of its own yet — the catalog default applies.
    expect(state.thinking).toBe('high');

    // Switching back resolves the max-only model's own level again.
    state.activeSessionId = 'session-1';
    await nextTick();
    expect(state.thinking).toBe('max');
  });

  it('restores the session own daemon level when switching sessions on the same model', async () => {
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: effortAppModel.id },
        defaultModel: effortAppModel.id,
      }),
    ) as ExtendedState;
    state.sessions = [
      { id: 'session-1', model: effortAppModel.id },
      { id: 'session-2', model: effortAppModel.id },
    ] as AppSession[];
    // session-2 ran at max (folded from /status); the current view shows
    // high — the session's own level must win.
    state.thinkingBySession = { 'session-2': 'max' };
    state.thinking = 'high';
    createModelProvider(state);

    state.activeSessionId = 'session-2';
    await nextTick();
    expect(state.thinking).toBe('max');
  });

  it('re-resolves the active session when its daemon level arrives after the switch', async () => {
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: effortAppModel.id },
        defaultModel: effortAppModel.id,
      }),
    ) as ExtendedState;
    state.sessions = [
      { id: 'session-1', model: effortAppModel.id },
      { id: 'session-2', model: effortAppModel.id },
    ] as AppSession[];
    state.thinking = 'high';
    createModelProvider(state);

    // Before the /status fold lands, the catalog default is shown.
    state.activeSessionId = 'session-2';
    await nextTick();
    expect(state.thinking).toBe('high');

    // The fold (refreshSessionStatus / WS) updates the active session's entry.
    state.thinkingBySession = { 'session-2': 'max' };
    await nextTick();
    expect(state.thinking).toBe('max');
  });

  it('falls back to the model default when the session level is not declared by the model', async () => {
    const lowHighAppModel: AppModel = {
      id: 'provider/low-high-model',
      provider: 'provider',
      model: 'low-high-model',
      maxContextSize: 128_000,
      capabilities: ['thinking'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: lowHighAppModel.id },
        defaultModel: lowHighAppModel.id,
      }),
    ) as ExtendedState;
    state.sessions = [
      { id: 'session-1', model: lowHighAppModel.id },
      { id: 'session-2', model: lowHighAppModel.id },
    ] as AppSession[];
    state.thinkingBySession = { 'session-2': 'max' };
    // Constructing the provider registers the re-resolution watcher; the models
    // themselves live in the shared store (P10).
    createModelProvider(state);
    modelsStore().setModels([...modelsStore().models, lowHighAppModel]);

    state.activeSessionId = 'session-2';
    await nextTick();
    expect(state.thinking).toBe('high');
  });

  it('mirrors an explicit setThinking pick into the session own entry', () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    provider.setThinking('max');

    expect(state.thinkingBySession['session-1']).toBe('max');
  });

  it('keeps an explicit new-session-draft pick when config reloads', async () => {
    // A no-session draft has nowhere to record an explicit pick besides
    // rawState.thinking itself (thinkingBySession is keyed by session id) —
    // draftThinkingExplicit is what lets the config watch source stay safe:
    // it must not blindly recompute and overwrite an explicit pick just
    // because config reloaded, related or not.
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('off');
    expect(state.thinking).toBe('off');

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();

    expect(state.thinking).toBe('off');
  });

  it('updates an INHERITED new-session-draft level when the Settings default changes', async () => {
    // The counterpart to the test above: a draft the user has NOT explicitly
    // touched must keep tracking config.thinking live — e.g. the user sits on
    // an empty composer, opens Settings, and changes the default — so its
    // first prompt uses whatever the default currently is, not whatever it
    // happened to be when the draft was first shown.
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);
    await provider.loadModels();
    expect(state.thinking).toBe('high'); // catalog default, nothing explicit yet

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();
    expect(state.thinking).toBe('low');

    // A second, different Settings change keeps landing too.
    state.config = { thinking: { enabled: false } } as ExtendedState['config'];
    await nextTick();
    expect(state.thinking).toBe('off');
  });

  it('clears an explicit draft pick after visiting an existing session and back', async () => {
    // draftThinkingExplicit is scoped to the CURRENT draft only. Without
    // resetting it on landing on a real session, browsing into an existing
    // session (which overwrites rawState.thinking with THAT session's level)
    // and back to a fresh draft would let the visited session's level
    // masquerade as an explicit pick for the new draft, and get seeded into
    // whatever session is created from it.
    const state = reactive(
      createState({ defaultModel: effortAppModel.id }),
    ) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('max');
    expect(state.thinking).toBe('max');
    expect(state.draftThinkingExplicit).toBe(true);

    // The user opens an existing session running a different model/level.
    state.sessions = [{ id: 'session-1', model: booleanAppModel.id } as AppSession];
    state.thinkingBySession = { 'session-1': 'on' };
    state.activeSessionId = 'session-1';
    await nextTick();
    expect(state.thinking).toBe('on');
    expect(state.draftThinkingExplicit).toBe(false);

    // Back to a fresh draft: the visited session's level must not stick
    // around as if it were an explicit pick for this new draft.
    state.activeSessionId = null;
    await nextTick();
    expect(state.thinking).toBe('high'); // effortAppModel's own catalog default
    expect(state.draftThinkingExplicit).toBe(false);
  });

  it('re-resolves an explicit draft pick when the underlying model changes passively', async () => {
    // The draft's effective model can change with no setModel() call at all —
    // Settings changing the default model, or a catalog refresh. An explicit
    // pick that no longer applies to the new model (here: 'low' is not a
    // segment of a boolean model) must not stay frozen just because it was
    // once explicit; it should re-resolve fresh, same as an actual switch.
    const state = reactive(
      createState({ defaultModel: effortAppModel.id }),
    ) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('low');
    expect(state.thinking).toBe('low');
    expect(state.draftThinkingExplicit).toBe(true);

    state.defaultModel = booleanAppModel.id; // e.g. Settings' own default-model change
    await nextTick();

    expect(state.thinking).toBe('on'); // booleanAppModel's own catalog default
    expect(state.draftThinkingExplicit).toBe(false);
  });

  it('keeps protecting an explicit draft pick the new model still declares', async () => {
    // Counterpart to the test above: if the new model happens to declare the
    // same level, the explicit pick is still meaningful and must survive.
    const lowHighAppModel: AppModel = {
      id: 'provider/low-high-model',
      provider: 'provider',
      model: 'low-high-model',
      maxContextSize: 128_000,
      capabilities: ['thinking'],
      supportEfforts: ['low', 'high'],
      defaultEffort: 'high',
    };
    const state = reactive(
      createState({ defaultModel: effortAppModel.id }),
    ) as ExtendedState;
    const provider = createModelProvider(state);
    modelsStore().setModels([...modelsStore().models, lowHighAppModel]);

    provider.setThinking('low');
    expect(state.draftThinkingExplicit).toBe(true);

    state.defaultModel = lowHighAppModel.id; // also declares 'low'
    await nextTick();

    expect(state.thinking).toBe('low');
    expect(state.draftThinkingExplicit).toBe(true);
  });

  it('does not write the global thinking config for the loadModels default pin', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    state.thinking = undefined;
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('keeps a setThinking pick session-scoped — no global config write', () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    provider.setThinking('max');

    // The pick goes to the session profile only — the daemon-wide [thinking]
    // config is never touched, matching the TUI's session-only path.
    expect(apiMock.setConfig).not.toHaveBeenCalled();
    expect(persistSessionProfileMock).toHaveBeenCalledWith({ thinking: 'max' });
  });

  it('does not write the global thinking config on a model switch', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('does not write the global thinking config when re-selecting the current model', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('does not write the global thinking config when the session switch fails', async () => {
    apiMock.updateSession.mockRejectedValue(new Error('daemon unreachable'));
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    const switched = await provider.setModel(effortAppModel.id);

    expect(switched).toBe(false);
    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('drops the pending mark when a model switch rolls back', async () => {
    // The rolled-back value's earlier write may already have settled — its
    // token must not be resurrected, or every later daemon fold is dropped.
    apiMock.updateSession.mockRejectedValue(new Error('daemon unreachable'));
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);
    provider.setThinking('low');

    const switched = await provider.setModel(effortAppModel.id);

    expect(switched).toBe(false);
    expect(state.thinking).toBe('low');
    expect(state.pendingThinkingBySession['session-1']).toBeUndefined();
  });

  it('keeps a newer pending pick when an older model switch rolls back', async () => {
    let rejectSwitch!: (err: Error) => void;
    apiMock.updateSession.mockReturnValueOnce(
      new Promise((_, rej) => {
        rejectSwitch = rej;
      }),
    );
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    const switching = provider.setModel(effortAppModel.id);
    // A newer pick lands while the switch is in flight — its own token.
    provider.setThinking('low');
    rejectSwitch(new Error('down'));
    await switching;

    expect(state.pendingThinkingBySession['session-1']).toBeDefined();
  });

  it('waits for the status fold when the session level has not landed', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    const refreshSessionStatus = vi.fn(async () => {
      state.thinkingBySession = { 'session-1': 'max' };
    });
    const provider = createModelProvider(state, { refreshSessionStatus });

    const level = await provider.resolveThinkingForPrompt('session-1', effortAppModel.id);

    expect(refreshSessionStatus).toHaveBeenCalledWith('session-1');
    expect(level).toBe('max');
  });

  it('does not refetch status when the session level is already known', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    state.thinkingBySession = { 'session-1': 'max' };
    const refreshSessionStatus = vi.fn(async () => undefined);
    const provider = createModelProvider(state, { refreshSessionStatus });

    const level = await provider.resolveThinkingForPrompt('session-1', effortAppModel.id);

    expect(refreshSessionStatus).not.toHaveBeenCalled();
    expect(level).toBe('max');
  });
});
