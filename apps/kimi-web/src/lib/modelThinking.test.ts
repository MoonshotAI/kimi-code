import { computed } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppModel, AppSession } from '../api/types';
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
  modelThinkingAvailability,
  segmentsFor,
  thinkingLevelForModelSwitch,
} from './modelThinking';
import type { ModelThinkingInfo } from './modelThinking';

const apiMock = vi.hoisted(() => ({
  updateSession: vi.fn(),
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

  beforeEach(() => {
    apiMock.updateSession.mockReset();
    apiMock.updateSession.mockResolvedValue({});
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
    } as ExtendedState;
  }

  function createModelProvider(state: ExtendedState) {
    const deps: UseModelProviderStateDeps = {
      pushOperationFailure: vi.fn(),
      refreshSessionStatus: vi.fn().mockResolvedValue(undefined),
      persistSessionProfile: vi.fn().mockResolvedValue(undefined),
      activity: computed(() => 'idle'),
      inFlightPromptSessions: new Set(),
      saveThinkingToStorage: vi.fn(),
      updateSession: (id, update) => {
        state.sessions = state.sessions.map((session) =>
          session.id === id ? update(session) : session,
        );
      },
      updateSessionMessages: vi.fn(),
    };
    const provider = useModelProviderState(state, deps);
    provider.models.value = [effortAppModel, booleanAppModel];
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
});
