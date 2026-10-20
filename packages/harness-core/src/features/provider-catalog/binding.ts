import { createFacadeToken, type ComputedRef } from '@moonshot-ai/agent-core/kernel/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

import type { CatalogModelBinding } from './types';

export const MODEL_BOUND = 'model.bound';

export interface ModelBoundEvent extends FeatureEvent {
  readonly type: typeof MODEL_BOUND;
  readonly alias: string | null;
  readonly thinking: string | null;
}

export interface ModelBindingState {
  readonly alias: string | null;
  readonly thinking: string | null;
}

export const modelBindingProjection: Projection<ModelBindingState, ModelBoundEvent> = {
  initial: () => ({ alias: null, thinking: null }),
  reduce: (state, entry) => {
    if (entry.event.type !== MODEL_BOUND) return state;
    return { alias: entry.event.alias, thinking: entry.event.thinking };
  },
};

export const SESSION_MODEL_DEFAULTS = 'session.model_defaults';

export interface SessionModelDefaultsEvent extends FeatureEvent {
  readonly type: typeof SESSION_MODEL_DEFAULTS;
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
}

export interface SessionModelDefaults {
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
}

export const sessionModelDefaultsProjection: Projection<
  SessionModelDefaults,
  SessionModelDefaultsEvent
> = {
  initial: () => ({}),
  reduce: (state, entry) => {
    if (entry.event.type !== SESSION_MODEL_DEFAULTS) return state;
    return {
      defaultModel: entry.event.defaultModel ?? state.defaultModel,
      defaultThinking: entry.event.defaultThinking ?? state.defaultThinking,
    };
  },
};

export function matchCatalogBinding(
  alias: string,
  bindings: readonly CatalogModelBinding[],
): CatalogModelBinding | undefined {
  return bindings.find((candidate) => {
    if (candidate.alias === alias) return true;
    if (candidate.configKey === alias) return true;
    return candidate.model.aliases?.includes(alias) ?? false;
  });
}

export type ModelCatalogErrorCode =
  | 'model.unknown_alias'
  | 'model.invalid_thinking'
  | 'config.unavailable';

export class ModelCatalogError extends Error {
  readonly code: ModelCatalogErrorCode;

  constructor(code: ModelCatalogErrorCode, message: string) {
    super(message);
    this.name = 'ModelCatalogError';
    this.code = code;
  }
}

export interface AgentModelFace {
  readonly current: ComputedRef<ModelBindingState>;
  setModel(alias: string): Promise<void>;
  setThinking(effort: string): Promise<void>;
}

export interface SessionModelFace {
  setModel(alias: string): Promise<void>;
  setThinking(effort: string): Promise<void>;
}

export interface ModelDefaultsFace {
  setDefaultModel(alias: string): Promise<void>;
  setDefaultThinking(effort: string): Promise<void>;
}

export const AgentModelRef = createFacadeToken<AgentModelFace>('provider-catalog.agentModel');

export const SessionModelRef = createFacadeToken<SessionModelFace>('provider-catalog.sessionModel');

export const ModelDefaultsRef = createFacadeToken<ModelDefaultsFace>('provider-catalog.modelDefaults');
