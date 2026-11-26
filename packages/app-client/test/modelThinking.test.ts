import { browserReferenceNode, composerSchema, createComposerSnapshot } from '@moonshot-ai/app-composer/model';
import type { BrowserCapture } from '@moonshot-ai/app-core/browser-reference';
import { computed, nextTick, reactive, watch } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError, type AppModel, type AppSession, type KimiWebApi, type ThinkingLevel } from '@moonshot-ai/app-core/api';
import {
  useModelProviderState,
  type UseModelProviderStateDeps,
} from '../src/client/useModelProviderState';
import { modelsStore } from '../src/stores/models';
import { permissionsStore } from '../src/stores/permissions';
import { promptStore } from '../src/stores/prompt';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';
import { useConfirmDialog } from '../src/composables/useConfirmDialog';
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

const apiMock = {
  updateSession: vi.fn(),
  listModels: vi.fn(),
  listProviders: vi.fn(),
  refreshProvider: vi.fn(),
  refreshAllProviders: vi.fn(),
  addProvider: vi.fn(),
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  importCatalogProvider: vi.fn(),
  importCustomRegistry: vi.fn(),
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

    it('persists concrete levels as the global default', () => {
      expect(thinkingLevelToConfig('low')).toEqual({ enabled: true, effort: 'low' });
      expect(thinkingLevelToConfig('high')).toEqual({ enabled: true, effort: 'high' });
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
      expect(thinkingLevelFromConfig({ enabled: false }, alwaysOnModel)).toBeUndefined();
    });

    it('never falls through to a leftover effort once enabled is false', () => {
      expect(thinkingLevelFromConfig({ enabled: false, effort: 'max' }, maxOnlyModel)).toBeUndefined();
    });

    it('resolves a stored effort only when the model still declares it', () => {
      expect(thinkingLevelFromConfig({ enabled: true, effort: 'low' }, effortModel)).toBe('low');
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
    modelsStore().$patch({ recentModelIds: [] });
    permissionsStore().$reset();
    permissionsStore().pickInSession('session-1', 'auto');
    const prompt = promptStore();
    prompt.queuedBySession = {};
    prompt.inFlightBySession = {};
    prompt.optimisticMessagesBySession = {};
    prompt.forgetPromptState('session-1');
  });

  function createState(options: {
    activeSession?: Pick<AppSession, 'id' | 'model'>;
    defaultModel: string;
    configThinking?: { enabled?: boolean; effort?: string };
  }): ExtendedState {
    modelsStore().setDefaultModel(options.defaultModel);
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
      config: options.configThinking ? { thinking: options.configThinking } : null,
    } as ExtendedState;
  }

  function createModelProvider(state: ExtendedState, depOverrides: Partial<UseModelProviderStateDeps> = {}) {
    const deps: UseModelProviderStateDeps = {
      api,
      pushOperationFailure: vi.fn(),
      persistSessionProfile: persistSessionProfileMock,
      whenSessionProfileSettled: vi.fn(async () => true),
      savePlanModeToStorage: vi.fn(),
      saveTowerModeToStorage: vi.fn(),
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
    expect(persistSessionProfileMock).toHaveBeenCalledWith(
      { model: effortAppModel.id, thinking: undefined },
      'session-1',
    );
  });

  it('enables the default effort when switching from a different model', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('high');
  });

  it('prefers the daemon-wide config default over the catalog default when switching the draft model', async () => {
    const state = createState({
      defaultModel: booleanAppModel.id,
      configThinking: { enabled: true, effort: 'low' },
    });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(state.thinking).toBe('low');
  });

  it('switches only the model in an active session and shows the level the new model keeps', async () => {
    const lowDefaultAppModel: AppModel = {
      ...effortAppModel,
      id: 'provider/low-default-model',
      model: 'low-default-model',
      defaultEffort: 'low',
    };
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: effortAppModel.id },
        defaultModel: effortAppModel.id,
        configThinking: { enabled: true, effort: 'high' },
      }),
    ) as ExtendedState;
    state.thinkingBySession = { 'session-1': 'max' };
    const provider = createModelProvider(state);
    modelsStore().setModels([...modelsStore().models, lowDefaultAppModel]);

    await provider.setModel(lowDefaultAppModel.id);
    await nextTick();

    expect(persistSessionProfileMock).toHaveBeenCalledWith(
      { model: lowDefaultAppModel.id, thinking: undefined },
      'session-1',
    );
    expect(state.thinkingBySession['session-1']).toBe('max');
    expect(state.thinking).toBe('max');
  });

  it('falls back to the new model default for display when the session level is not supported', async () => {
    const state = reactive(
      createState({
        activeSession: { id: 'session-1', model: effortAppModel.id },
        defaultModel: effortAppModel.id,
      }),
    ) as ExtendedState;
    state.thinkingBySession = { 'session-1': 'low' };
    const provider = createModelProvider(state);

    await provider.setModel(maxOnlyAppModel.id);
    await nextTick();

    expect(persistSessionProfileMock).toHaveBeenCalledWith(
      { model: maxOnlyAppModel.id, thinking: undefined },
      'session-1',
    );
    expect(state.thinking).toBe('max');
  });

  it('sends a thinking level with a background session model switch only when the user chose one', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.setSessionModel('session-1', effortAppModel.id);
    await provider.setSessionModel('session-1', maxOnlyAppModel.id, 'max');

    expect(persistSessionProfileMock.mock.calls).toEqual([
      [{ model: effortAppModel.id, thinking: undefined }, 'session-1'],
      [{ model: maxOnlyAppModel.id, thinking: 'max' }, 'session-1'],
    ]);
  });

  it('records the selected model before the previous model after a successful draft switch', async () => {
    const state = createState({ defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);

    await provider.setModel(effortAppModel.id);

    expect(provider.recentModelIds.value).toEqual([effortAppModel.id, booleanAppModel.id]);
  });

  it('records a successful model selection for a specified session', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    await provider.setSessionModel('session-1', effortAppModel.id);

    expect(provider.recentModelIds.value).toEqual([effortAppModel.id, booleanAppModel.id]);
  });

  it('reports a network-failed skill as unsuccessful so the caller restores its draft', async () => {
    const state = createState({ activeSession: { id: 'session-1', model: effortAppModel.id }, defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);
    apiMock.activateSkill.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await provider.activateSkill('example-skill', 'recover this')).toBe(false);
    expect(apiMock.activateSkill).toHaveBeenCalledOnce();
    expect(promptStore().optimisticMessagesBySession['session-1']).toBeUndefined();
    expect(promptStore().inFlightBySession['session-1']).toBe(false);
  });

  it.each([
    ['confirmed', true, 2, 1],
    ['cancelled', false, 1, 0],
  ] as const)('handles an occupied skill activation when the dialog is %s', async (_label, confirmed, callCount, bubbleCount) => {
    const state = createState({ activeSession: { id: 'session-1', model: effortAppModel.id }, defaultModel: booleanAppModel.id });
    sessionsStore().setActiveSessionId('session-1');
    const provider = createModelProvider(state);
    apiMock.activateSkill.mockRejectedValueOnce(new DaemonApiError({ code: 40931, msg: 'session occupied', requestId: 'occupied' }));
    warningsStore().resetWarnings();

    const pending = provider.activateSkill('example-skill', 'retry this');
    await vi.waitFor(() => expect(useConfirmDialog().current.value).not.toBeNull());
    expect(promptStore().optimisticMessagesBySession['session-1']).toHaveLength(1);
    const renderedBubbleCounts: number[] = [];
    const stopBubble = watch(
      () => (promptStore().optimisticMessagesBySession['session-1'] ?? []).length,
      (count) => { renderedBubbleCounts.push(count); },
      { flush: 'sync' },
    );
    useConfirmDialog().settle(confirmed);

    expect(await pending).toBe(confirmed);
    stopBubble();
    expect(renderedBubbleCounts).toEqual(confirmed ? [] : [0]);
    expect(apiMock.activateSkill).toHaveBeenCalledTimes(callCount);
    expect(promptStore().optimisticMessagesBySession['session-1'] ?? []).toHaveLength(bubbleCount);
    expect(warningsStore().warnings).toHaveLength(0);
    if (confirmed) expect(apiMock.activateSkill.mock.calls[1]).toEqual(apiMock.activateSkill.mock.calls[0]);
  });

  it('strips attachment links from skill arguments without changing optimistic content or media', async () => {
    const state = createState({ activeSession: { id: 'session-1', model: effortAppModel.id }, defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);
    const args = 'Compare [Image 1](kimi-code-composer://attachments/m1) and [Image 2](kimi-code-composer://attachments/m2)';
    const input = [
      { clientId: 'm1', kind: 'image' as const, fileId: 'image-a', name: 'first.png' },
      { clientId: 'm2', kind: 'image' as const, fileId: 'image-b', sessionId: 'session-1', name: 'second.png' },
    ];
    const media = [
      { type: 'image', source: { kind: 'file', fileId: 'image-a' }, name: 'first.png' },
      { type: 'image', source: { kind: 'sessionMedia', fileId: 'image-b' }, name: 'second.png' },
    ];

    await expect(provider.activateSkill('example-skill', args, input)).resolves.toBe(true);

    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'example-skill', 'Compare Image 1 and Image 2', media, {
      skillPath: undefined,
      promptId: expect.stringMatching(/^msg_[0-9a-f]{32}$/),
    });
    const optimistic = promptStore().optimisticMessagesBySession['session-1']?.at(-1);
    expect(optimistic?.metadata?.['kimiWeb.promptId']).toBe(apiMock.activateSkill.mock.calls[0]?.[4]?.promptId);
    expect(optimistic?.content).toEqual([{ type: 'text', text: `/example-skill ${args}` }, ...media]);
    expect(optimistic?.metadata?.['origin']).toMatchObject({ skillArgs: 'Compare Image 1 and Image 2' });
  });

  it('preserves annotation metadata and image association for a single skill activation', async () => {
    const state = createState({ activeSession: { id: 'session-1', model: effortAppModel.id }, defaultModel: booleanAppModel.id });
    const provider = createModelProvider(state);
    const capture: BrowserCapture = {
      version: 1, id: 'capture', ordinal: 1, label: 'Save', capturedAt: '2026-09-07T00:00:00.000Z', page: { url: 'https://example.test', title: 'Example' },
      target: { kind: 'element', tagName: 'button', bounds: { x: 10, y: 10, width: 50, height: 20 } },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoomFactor: 1, devicePixelRatio: 1 },
      screenshot: { attachmentId: 'shot', crop: { x: 10, y: 10, width: 50, height: 20 }, pixelWidth: 50, pixelHeight: 20 },
    };
    const doc = composerSchema.node('doc', null, [composerSchema.node('paragraph', null, [
      composerSchema.text('Use '),
      composerSchema.nodeFromJSON({ type: 'attachment', attrs: { attId: 'm1', name: 'Image 1', kind: 'image' } }),
      composerSchema.text(' with '),
      browserReferenceNode({ refId: 'ref-example', label: 'Save' }),
    ])]);
    const snapshot = createComposerSnapshot(doc, [
      { attId: 'm1', key: 'image-a', kind: 'image', name: 'Image 1', fileId: 'image-a', uploading: false, refCount: 1 },
      { attId: 'shot', key: 'blob:shot', kind: 'image', name: 'shot.png', purpose: 'browser-screenshot', fileId: 'shot-file', uploading: false, refCount: 0 },
    ], ['m1', 'shot'], { references: [{ id: 'ref-example', captureId: capture.id, comment: 'Rename it' }], captures: [capture] });
    const pending = provider.activateSkill('example-skill', 'Use [Image 1](kimi-code-composer://attachments/m1) with [Save](kimi-code-composer://browser-references/ref-example)', [{ clientId: 'm1', kind: 'image', fileId: 'image-a', name: 'first.png' }, { clientId: 'shot', kind: 'image', fileId: 'shot-file' }], undefined, { snapshot });
    snapshot.browserReferences![0]!.comment = 'later mutation';
    await expect(pending).resolves.toBe(true);
    const [sid, skill, args, attachments, options] = apiMock.activateSkill.mock.calls[0]!;
    expect([sid, skill, args]).toEqual(['session-1', 'example-skill', 'Use Image 1 with <browser_ref id="ref-example">Save</browser_ref>']);
    expect(promptStore().optimisticMessagesBySession['session-1']?.at(-1)?.metadata?.['origin']).toMatchObject({ skillArgs: args });
    expect(options.metadata.kimi_code_composer.browserReferences[0].comment).toBe('Rename it');
    expect(options.metadata.kimi_code_composer.attachments).toHaveLength(2);
    expect(options).not.toHaveProperty('content');
    expect(attachments[0].text).toContain('<browser_capture id="capture"');
    expect(attachments.slice(1)).toEqual([
      { type: 'image', source: { kind: 'file', fileId: 'image-a' }, name: 'first.png' },
      { type: 'text', text: 'Browser screenshot image_ref=browser-shot-capture\nThis identifier labels the following image; it is not a file path. Inspect the attached image, or use the real media path supplied with it.' },
      { type: 'image', source: { kind: 'file', fileId: 'shot-file' } },
    ]);
    apiMock.activateSkill.mockClear();
    await expect(provider.activateSkill('example-skill', '', [], undefined, { snapshot })).resolves.toBe(false);
    expect(apiMock.activateSkill).not.toHaveBeenCalled();
  });

  it('waits for pending profile writes before activating a skill', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    let settle!: (ok: boolean) => void;
    const whenSessionProfileSettled = vi.fn(
      () => new Promise<boolean>((resolve) => { settle = resolve; }),
    );
    const provider = createModelProvider(state, { whenSessionProfileSettled });

    const activating = provider.activateSkill('gen-changesets');
    await vi.waitFor(() => expect(whenSessionProfileSettled).toHaveBeenCalledWith('session-1'));
    expect(apiMock.activateSkill).not.toHaveBeenCalled();

    settle(true);
    await expect(activating).resolves.toBe(true);
    expect(persistSessionProfileMock).not.toHaveBeenCalled();
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, [], {
      skillPath: undefined,
      promptId: expect.stringMatching(/^msg_/),
    });
  });

  it('does not activate the skill when a pending profile write fails', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state, { whenSessionProfileSettled: vi.fn(async () => false) });

    await provider.activateSkill('gen-changesets');

    expect(apiMock.activateSkill).not.toHaveBeenCalled();
    expect(promptStore().inFlightBySession['session-1']).toBe(false);
  });

  it('cashes an armed plan intent through the activation persist and consumes it', async () => {
    const state = createState({
      activeSession: { id: 'session-1', model: effortAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    state.planArmedBySession = { 'session-1': true };
    const provider = createModelProvider(state);

    await provider.activateSkill('gen-changesets');

    expect(persistSessionProfileMock).toHaveBeenCalledWith(
      expect.objectContaining({ planMode: true, towerMode: false }),
      'session-1',
    );
    expect(state.planArmedBySession['session-1']).toBe(false);
    expect(state.planModeBySession['session-1']).toBe(true);
    expect(state.towerModeBySession?.['session-1']).toBe(false);
    expect(apiMock.activateSkill).toHaveBeenCalledWith('session-1', 'gen-changesets', undefined, [], {
      skillPath: undefined,
      promptId: expect.stringMatching(/^msg_/),
    });
  });

  it('pins the catalog default in memory when no thinking preference exists', async () => {
    const state = createState({ defaultModel: effortAppModel.id });
    state.thinking = undefined;
    const provider = createModelProvider(state);

    await provider.loadModels();

    expect(state.thinking).toBe('high');
  });

  it('re-resolves the config default once config lands after loadModels() during boot', async () => {
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);

    await provider.loadModels();
    expect(state.thinking).toBe('high');

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();

    expect(state.thinking).toBe('low');
  });

  it('applies the daemon-wide config default for a session with no level of its own', async () => {
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
    expect(state.thinking).toBe('high');

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

    state.activeSessionId = 'session-2';
    await nextTick();
    expect(state.thinking).toBe('high');

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
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('off');
    expect(state.thinking).toBe('off');

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();

    expect(state.thinking).toBe('off');
  });

  it('updates an INHERITED new-session-draft level when the Settings default changes', async () => {
    const state = reactive(createState({ defaultModel: effortAppModel.id })) as ExtendedState;
    const provider = createModelProvider(state);
    await provider.loadModels();
    expect(state.thinking).toBe('high');

    state.config = { thinking: { enabled: true, effort: 'low' } } as ExtendedState['config'];
    await nextTick();
    expect(state.thinking).toBe('low');

    state.config = { thinking: { enabled: false } } as ExtendedState['config'];
    await nextTick();
    expect(state.thinking).toBe('off');
  });

  it('clears an explicit draft pick after visiting an existing session and back', async () => {
    const state = reactive(
      createState({ defaultModel: effortAppModel.id }),
    ) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('max');
    expect(state.thinking).toBe('max');
    expect(state.draftThinkingExplicit).toBe(true);

    state.sessions = [{ id: 'session-1', model: booleanAppModel.id } as AppSession];
    state.thinkingBySession = { 'session-1': 'on' };
    state.activeSessionId = 'session-1';
    await nextTick();
    expect(state.thinking).toBe('on');
    expect(state.draftThinkingExplicit).toBe(false);

    state.activeSessionId = null;
    await nextTick();
    expect(state.thinking).toBe('high');
    expect(state.draftThinkingExplicit).toBe(false);
  });

  it('re-resolves an explicit draft pick when the underlying model changes passively', async () => {
    const state = reactive(
      createState({ defaultModel: effortAppModel.id }),
    ) as ExtendedState;
    const provider = createModelProvider(state);

    provider.setThinking('low');
    expect(state.thinking).toBe('low');
    expect(state.draftThinkingExplicit).toBe(true);

    modelsStore().setDefaultModel(booleanAppModel.id);
    await nextTick();

    expect(state.thinking).toBe('on');
    expect(state.draftThinkingExplicit).toBe(false);
  });

  it('keeps protecting an explicit draft pick the new model still declares', async () => {
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

    modelsStore().setDefaultModel(lowHighAppModel.id);
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
    persistSessionProfileMock.mockResolvedValue(false);
    const state = createState({
      activeSession: { id: 'session-1', model: booleanAppModel.id },
      defaultModel: booleanAppModel.id,
    });
    const provider = createModelProvider(state);

    const switched = await provider.setModel(effortAppModel.id);

    expect(switched).toBe(false);
    expect(apiMock.setConfig).not.toHaveBeenCalled();
    expect(provider.recentModelIds.value).toEqual([]);
  });
});

describe('useModelProviderState provider refresh failures', () => {
  beforeEach(() => {
    apiMock.listProviders.mockReset();
    apiMock.listProviders.mockResolvedValue([]);
    apiMock.listModels.mockReset();
    apiMock.listModels.mockResolvedValue([]);
    apiMock.refreshProvider.mockReset();
    apiMock.refreshAllProviders.mockReset();
  });

  function createRefreshHarness() {
    const state = {
      activeSessionId: null,
      sessions: [],
      thinking: 'off',
      thinkingBySession: {},
      pendingThinkingBySession: {},
      planModeBySession: {},
      planArmedBySession: {},
      pendingPlanBySession: {},
      goalModeBySession: {},
      goalBySession: {},
      config: null,
    } as unknown as ExtendedState;
    const pushOperationFailure = vi.fn();
    const provider = useModelProviderState(state, {
      api,
      pushOperationFailure,
      refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
      persistSessionProfile: vi.fn().mockResolvedValue(true),
      whenSessionProfileSettled: vi.fn(async () => true),
      savePlanModeToStorage: vi.fn(),
      saveTowerModeToStorage: vi.fn(),
      activity: computed(() => 'idle'),
      updateSession: vi.fn(),
      loadConfig: vi.fn().mockResolvedValue(undefined),
      checkAuth: vi.fn().mockResolvedValue(undefined),
    });
    return { provider, pushOperationFailure };
  }

  function refreshResult(failed: Array<{ provider: string; reason: string }>, unchanged: string[] = []) {
    return { changed: [], unchanged, failed };
  }

  it('surfaces the provider display name and the failure reason', async () => {
    apiMock.refreshAllProviders.mockResolvedValue(
      refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }], ['managed:kimi-code']),
    );
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(1);
    expect(pushOperationFailure).toHaveBeenCalledWith('refreshAllProviders', 'API key expired', {
      title: 'warnings.providerRefreshFailedTitle',
      message: 'warnings.providerRefreshFailedMessage',
    });
    expect(pushOperationFailure.mock.calls[0]?.[1]).toBe('API key expired');
  });

  it('does not repeat an identical failure on the next refresh', async () => {
    apiMock.refreshAllProviders.mockResolvedValue(
      refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }]),
    );
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();
    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(1);
  });

  it('notifies again when the failure reason changes', async () => {
    apiMock.refreshAllProviders
      .mockResolvedValueOnce(refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }]))
      .mockResolvedValueOnce(refreshResult([{ provider: 'kimi-code', reason: 'network unreachable' }]));
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();
    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(2);
  });

  it('notifies again after the provider recovers and fails anew', async () => {
    apiMock.refreshAllProviders
      .mockResolvedValueOnce(refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }]))
      .mockResolvedValueOnce(refreshResult([], ['kimi-code']))
      .mockResolvedValueOnce(refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }]));
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();
    await provider.refreshAllProviders();
    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(2);
  });

  it('a single-provider refresh only clears the signature of that provider', async () => {
    apiMock.refreshAllProviders.mockResolvedValue(
      refreshResult([
        { provider: 'kimi-code', reason: 'API key expired' },
        { provider: 'free-tokens', reason: 'HTTP 500' },
      ]),
    );
    apiMock.refreshProvider.mockResolvedValue(refreshResult([], ['kimi-code']));
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();
    await provider.refreshProvider('kimi-code');
    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(3);
    expect(pushOperationFailure.mock.calls[2]?.[2]).toMatchObject({
      message: 'warnings.providerRefreshFailedMessage',
    });
  });

  it('notifies again after any provider config change, even with an identical failure', async () => {
    apiMock.refreshAllProviders.mockResolvedValue(
      refreshResult([{ provider: 'kimi-code', reason: 'API key expired' }]),
    );
    apiMock.addProvider.mockResolvedValue({});
    apiMock.updateProvider.mockResolvedValue({});
    apiMock.deleteProvider.mockResolvedValue({ deleted: 'kimi-code' });
    apiMock.importCatalogProvider.mockResolvedValue({ provider: {}, modelsImported: 0 });
    apiMock.importCustomRegistry.mockResolvedValue({ providers: [], modelsImported: 0 });
    const { provider, pushOperationFailure } = createRefreshHarness();

    await provider.refreshAllProviders();
    await provider.refreshAllProviders();
    expect(pushOperationFailure).toHaveBeenCalledTimes(1);

    await provider.updateProvider('kimi-code', { type: 'kimi', models: [] });
    await provider.refreshAllProviders();
    await provider.deleteProvider('kimi-code');
    await provider.refreshAllProviders();
    await provider.addProvider({ type: 'kimi' });
    await provider.refreshAllProviders();
    await provider.importCatalogProvider({ catalogId: 'kimi-code' });
    await provider.refreshAllProviders();
    await provider.importCustomRegistry({ url: 'https://example.test/api.json' });
    await provider.refreshAllProviders();

    expect(pushOperationFailure).toHaveBeenCalledTimes(6);
  });
});
