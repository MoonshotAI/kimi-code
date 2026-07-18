import { computed, nextTick, reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel, AppSession, ThinkingLevel } from '../api/types';
import {
  useModelProviderState,
  type UseModelProviderStateDeps,
} from '../composables/client/useModelProviderState';
import type { ExtendedState } from '../composables/useKimiWebClient';
import {
  commitLevel,
  defaultThinkingLevelFor,
  effectiveThinkingLevel,
  effortLabel,
  isThinkingOn,
  levelDeclaredBy,
  modelThinkingAvailability,
  segmentsFor,
  thinkingLevelForModelSwitch,
  thinkingLevelToConfig,
} from './modelThinking';
import type { ModelThinkingInfo } from './modelThinking';

const apiMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
  listModels: vi.fn(),
  setConfig: vi.fn(),
  activateSkill: vi.fn(),
}));

vi.mock('../api', () => ({
  getKimiWebApi: () => apiMock,
}));

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

    it('restores the stored pick when the target model declares it', () => {
      expect(thinkingLevelForModelSwitch(effortModel, 'off', true, 'max')).toBe('max');
      expect(thinkingLevelForModelSwitch(effortModel, 'high', true, 'off')).toBe('off');
    });

    it('falls back to the target default when the stored pick is not declared', () => {
      expect(thinkingLevelForModelSwitch(maxOnlyModel, 'low', true, 'low')).toBe('max');
      expect(thinkingLevelForModelSwitch(booleanModel, 'off', true, 'low')).toBe('on');
    });

    it('ignores the stored pick when re-selecting the current model', () => {
      expect(thinkingLevelForModelSwitch(effortModel, 'off', false, 'max')).toBe('off');
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

    it('records concrete efforts as the global default', () => {
      expect(thinkingLevelToConfig('max')).toEqual({ enabled: true, effort: 'max' });
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

  // Per-model thinking storage, wired into the deps the same way the facade
  // wires localStorage: tests seed storedThinkingLevels and assert writes via
  // saveThinkingToStorageMock.
  const saveThinkingToStorageMock = vi.fn();
  const persistSessionProfileMock = vi.fn();
  let storedThinkingLevels: Record<string, ThinkingLevel>;
  let legacyThinkingPick: ThinkingLevel | undefined;

  beforeEach(() => {
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
    apiMock.listModels.mockReset();
    apiMock.listModels.mockResolvedValue([effortAppModel, booleanAppModel, maxOnlyAppModel]);
    apiMock.setConfig.mockReset();
    apiMock.setConfig.mockResolvedValue({});
    apiMock.activateSkill.mockReset();
    apiMock.activateSkill.mockResolvedValue({});
    saveThinkingToStorageMock.mockReset();
    persistSessionProfileMock.mockReset();
    persistSessionProfileMock.mockResolvedValue(true);
    storedThinkingLevels = {};
    legacyThinkingPick = undefined;
  });

  function createState(options: {
    activeSession?: Pick<AppSession, 'id' | 'model'>;
    defaultModel: string;
  }): ExtendedState {
    return {
      activeSessionId: options.activeSession?.id ?? null,
      sessions: options.activeSession ? [options.activeSession] : [],
      thinking: 'off',
      defaultModel: options.defaultModel,
      inFlightBySession: {},
    } as ExtendedState;
  }

  function createModelProvider(state: ExtendedState) {
    const deps: UseModelProviderStateDeps = {
      pushOperationFailure: vi.fn(),
      refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
      persistSessionProfile: persistSessionProfileMock,
      activity: computed(() => 'idle'),
      loadThinkingForModel: (modelId) => storedThinkingLevels[modelId] ?? legacyThinkingPick,
      saveThinkingToStorage: saveThinkingToStorageMock,
      updateSession: (id, update) => {
        state.sessions = state.sessions.map((session) =>
          session.id === id ? update(session) : session,
        );
      },
      updateSessionMessages: vi.fn(),
    };
    const provider = useModelProviderState(state, deps);
    provider.models.value = [effortAppModel, booleanAppModel, maxOnlyAppModel];
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
    // In the app the draft pick and its 'off' level both went through setModel,
    // so storage already holds the model's pick when it is re-selected.
    storedThinkingLevels = { [effortAppModel.id]: 'off' };
    const provider = createModelProvider(state);
    provider.draftModel.value = effortAppModel.id;

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

  it('does not persist a derived default on model switch — storage stays pick-only', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    // The in-memory level follows the switch (catalog default 'high')...
    expect(state.thinking).toBe('high');
    // ...but nothing is written to storage: a level the user never explicitly
    // picked must not masquerade as a stored choice (it would override a future
    // catalog default change). Only setThinking writes.
    expect(saveThinkingToStorageMock).not.toHaveBeenCalled();
  });

  it('does not persist the rolled-back level when a switch fails', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    apiMock.updateSession.mockRejectedValueOnce(new Error('daemon unreachable'));
    const provider = createModelProvider(state);

    const switched = await provider.setModel(effortAppModel.id);

    expect(switched).toBe(false);
    expect(saveThinkingToStorageMock).not.toHaveBeenCalled();
  });

  it('applies the resolved level to the session profile before activating a skill', async () => {
    // Skill activation carries no thinking — the daemon runs at the session
    // profile effort. The restored per-model level must be persisted there
    // first, or the skill runs at a stale profile effort the UI no longer shows.
    storedThinkingLevels = { [effortAppModel.id]: 'low' };
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith({ thinking: 'low' }, 'session-1');
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined);
    // The profile write precedes the activation, mirroring the new-session path.
    const persistOrder = persistSessionProfileMock.mock.invocationCallOrder[0]!;
    const activateOrder = apiMock.activateSkill.mock.invocationCallOrder[0]!;
    expect(persistOrder).toBeLessThan(activateOrder);
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

  it('resolves an empty session model through the default model before activating a skill', async () => {
    // The daemon's profile echo can leave session.model '' — the same fallback
    // the prompt/BTW/steer paths apply must hold here too, or the profile gets
    // the raw active level instead of the target session model's pick.
    storedThinkingLevels = { [effortAppModel.id]: 'low' };
    const state = createState({
      activeSession: { id: 'session-1', model: '' },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith({ thinking: 'low' }, 'session-1');
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined);
  });

  it('treats a legacy pre-map pick as a fallback only for models that declare it', async () => {
    // Upgrade migration: the facade serves the old global pick for models
    // without their own entry; validation keeps it off models that can't run it.
    legacyThinkingPick = 'low';

    const effortState = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    const effortProvider = createModelProvider(effortState);
    await effortProvider.loadModels();
    expect(effortState.thinking).toBe('low');

    const maxOnlyState = createState({
      activeSession: { id: 'session-1', model: maxOnlyAppModel.id },
      defaultModel: maxOnlyAppModel.id,
    });
    const maxOnlyProvider = createModelProvider(maxOnlyState);
    await maxOnlyProvider.loadModels();
    expect(maxOnlyState.thinking).toBe('max');
  });

  it('lets a per-model entry win over the legacy pre-map pick', async () => {
    legacyThinkingPick = 'low';
    storedThinkingLevels = { [effortAppModel.id]: 'high' };
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: effortAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('high');
  });

  it('pins the catalog default in memory when no thinking preference exists', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    state.thinking = undefined;
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('high');
  });

  it('keeps a stored preference when loading models', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    storedThinkingLevels = { [effortAppModel.id]: 'max' };
    state.thinking = 'max';
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('max');
  });

  it('drops a stored level the active model does not declare', async () => {
    // The reported bug: a 'low' picked for another model must not leak onto a
    // max-only always-on model — resolution falls back to the model default.
    const state = createState({ defaultModel: maxOnlyAppModel.id });
    storedThinkingLevels = { [maxOnlyAppModel.id]: 'low' };
    state.thinking = 'low';
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('max');
  });

  it('restores the target model stored pick on a switch', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    storedThinkingLevels = { [effortAppModel.id]: 'max' };
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('max');
    expect(apiMock.setConfig).toHaveBeenCalledWith({ thinking: { enabled: true, effort: 'max' } });
  });

  it('persists the thinking pick under the current model id', () => {
    const state = createState({ defaultModel: effortAppModel.id });
    const provider = createModelProvider(state);

    provider.setThinking('max');

    expect(saveThinkingToStorageMock).toHaveBeenCalledWith(effortAppModel.id, 'max');
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
    storedThinkingLevels = { [effortAppModel.id]: 'low' };
    createModelProvider(state);

    state.activeSessionId = 'session-2';
    await nextTick();
    expect(state.thinking).toBe('low');

    // Switching back resolves the max-only model's own level again.
    state.activeSessionId = 'session-1';
    await nextTick();
    expect(state.thinking).toBe('max');
  });

  it('does not write the global thinking config for the loadModels default pin', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    state.thinking = undefined;
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(apiMock.setConfig).not.toHaveBeenCalled();
  });

  it('persists the thinking pick as the global default on setThinking', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    const provider = createModelProvider(state);

    provider.setThinking('max');

    expect(apiMock.setConfig).toHaveBeenCalledWith({ thinking: { enabled: true, effort: 'max' } });
  });

  it('persists the thinking pick as the global default on a model switch', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(apiMock.setConfig).toHaveBeenCalledWith({ thinking: { enabled: true, effort: 'high' } });
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
});
