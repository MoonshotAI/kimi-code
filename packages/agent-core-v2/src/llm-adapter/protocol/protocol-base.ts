import type { ProtocolBase } from '#human/llm/protocol/base';
import type { ProtocolTrait } from '#human/llm/protocol/trait';
import { anthropicBase } from '#human/llm/requester/bases/anthropic/requester';
import { googleGenAIBase } from '#human/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';

import type { Protocol, ProtocolAdapterConfig } from './protocol';

export type ProtocolBaseId = Protocol;

export interface ProtocolBaseDefinition {
  readonly id: ProtocolBaseId;
  readonly base: ProtocolBase;
}

export interface TraitContext {
  readonly config: ProtocolAdapterConfig;
  readonly providerId?: string;
}

export interface ResolvedTrait {
  readonly trait: ProtocolTrait;
  readonly context: TraitContext;
}

export interface ResolvedAdapterIdentity {
  readonly baseId: ProtocolBaseId;
  readonly traits: readonly ResolvedTrait[];
}

const PROTOCOL_BASES: readonly ProtocolBaseDefinition[] = [
  { id: 'openai', base: openAIBase },
  { id: 'openai_responses', base: openAIResponsesBase },
  { id: 'anthropic', base: anthropicBase },
  { id: 'google-genai', base: googleGenAIBase },
];

export function getProtocolBase(id: ProtocolBaseId): ProtocolBaseDefinition | undefined {
  return PROTOCOL_BASES.find((definition) => definition.id === id);
}

export function listProtocolBases(): readonly ProtocolBaseDefinition[] {
  return PROTOCOL_BASES;
}
