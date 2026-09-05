import type { ProtocolTrait } from '#human/llm/protocol/trait';

import type { ProtocolAdapterConfig } from './protocol';

export type { ProtocolEndpoint, ProtocolTrait } from '#human/llm/protocol/trait';

export interface TraitContext {
  readonly config: ProtocolAdapterConfig;
  readonly providerId?: string;
}

export interface ResolvedTrait {
  readonly trait: ProtocolTrait;
  readonly context: TraitContext;
}
