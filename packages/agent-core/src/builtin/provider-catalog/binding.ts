import { createToken, type ShallowRef } from '#/kernel/index';
import type { SessionRecord } from '#/app/session-space';
import type { RecordEvent } from '#/store/journal';
import type { Projection } from '#/store/store';
import type { BranchRef } from '#/store/tree';

import type { CatalogModelBinding, CatalogProviderInfo } from './types';

export const MODEL_BOUND = 'model.bound';

export interface ModelBindingState {
  readonly alias: string | null;
  readonly thinking: string | null;
}

export const modelBindingProjection: Projection<ModelBindingState, RecordEvent, BranchRef> = {
  initial: () => ({ alias: null, thinking: null }),
  reduce: (state, event) => {
    if (event.type !== MODEL_BOUND) return state;
    return {
      alias: (event['alias'] as string | null | undefined) ?? null,
      thinking: (event['thinking'] as string | null | undefined) ?? null,
    };
  },
};

export interface SessionModelDefaults {
  readonly defaultModel?: string;
  readonly defaultThinking?: string;
}

export const sessionModelDefaultsProjection: Projection<
  SessionModelDefaults,
  RecordEvent,
  BranchRef
> = {
  initial: () => ({}),
  reduce: (state, event) => {
    if (event.type !== 'session.meta_updated') return state;
    const metadata = (event['meta'] as SessionRecord | undefined)?.metadata;
    const read = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined;
    return {
      defaultModel: read(metadata?.['defaultModel']),
      defaultThinking: read(metadata?.['defaultThinking']),
    };
  },
};

export function matchCatalogBinding(
  alias: string,
  bindings: readonly CatalogModelBinding[],
  providerInfo: (providerId: string) => CatalogProviderInfo | undefined,
): CatalogModelBinding | undefined {
  return bindings.find((candidate) => {
    const scope = providerInfo(candidate.providerId)?.aliasScope ?? candidate.providerId;
    return `${scope}/${candidate.model.model}` === alias;
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
  readonly current: ShallowRef<ModelBindingState>;
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

export const AgentModelRef = createToken<AgentModelFace>('provider-catalog.agentModel');

export const SessionModelRef = createToken<SessionModelFace>('provider-catalog.sessionModel');

export const ModelDefaultsRef = createToken<ModelDefaultsFace>('provider-catalog.modelDefaults');
