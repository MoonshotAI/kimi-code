import type { ProtocolBase } from '#human/llm/protocol/base';
import type { AnyProtocolTrait } from '#human/llm/provider/definition';
import { anthropicBase } from '#human/llm/requester/bases/anthropic/requester';
import { googleGenAIBase } from '#human/llm/requester/bases/google-genai/requester';
import { openAIBase } from '#human/llm/requester/bases/openai/requester';
import { openAIResponsesBase } from '#human/llm/requester/bases/openai-responses/requester';

import type { Protocol } from './protocol';

export type ProtocolBaseId = Protocol;

export interface ProtocolBaseDefinition {
  readonly id: ProtocolBaseId;
  readonly base: ProtocolBase<AnyProtocolTrait>;
}

export interface ResolvedAdapterIdentity {
  readonly baseId: ProtocolBaseId;
  readonly trait?: AnyProtocolTrait;
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
