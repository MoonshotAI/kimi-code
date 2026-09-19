import type { LlmModel, ModelCapability } from '#/llm/model';
import type { LlmErrorClassifier } from '#/llm/requester/requester';

import type { ProviderConnection } from './connection';
import type { ProtocolHandle } from './protocol';

export type ProtocolName = string;

export interface TraitContext {
  readonly model: LlmModel;
}

export interface ProtocolRequesterOptions<TTrait> {
  readonly connection?: ProviderConnection;
  readonly trait?: TTrait;
  readonly classifyError?: LlmErrorClassifier;
}

export interface ProtocolBase<TTrait = unknown> {
  capability?(modelName: string): ModelCapability | undefined;
  bind(options?: ProtocolRequesterOptions<TTrait>): ProtocolHandle<any, any, any>;
}
