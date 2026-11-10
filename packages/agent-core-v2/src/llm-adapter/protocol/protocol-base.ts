import { anthropicProtocol } from '#human/llm/builtin/protocol/anthropic/index';
import { googleGenAIProtocol } from '#human/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#human/llm/builtin/protocol/openai/index';
import { openAIResponsesProtocol } from '#human/llm/builtin/protocol/openai-responses/index';
import type { Protocol as CoreProtocol } from '#human/llm/protocol/protocol';

import type { Protocol } from './protocol';

export type ProtocolBaseId = Protocol;

export interface ProtocolBaseDefinition {
  readonly id: ProtocolBaseId;
  readonly capability?: CoreProtocol['capability'];
}

export interface ResolvedAdapterIdentity {
  readonly baseId: ProtocolBaseId;
  readonly thinkingDriven?: boolean;
  readonly strictThinkingValidation?: boolean;
}

const PROTOCOL_BASES: readonly ProtocolBaseDefinition[] = [
  { id: 'openai', capability: openAIProtocol.capability },
  { id: 'openai_responses', capability: openAIResponsesProtocol.capability },
  { id: 'anthropic', capability: anthropicProtocol.capability },
  { id: 'google-genai', capability: googleGenAIProtocol.capability },
];

export function getProtocolBase(id: ProtocolBaseId): ProtocolBaseDefinition | undefined {
  return PROTOCOL_BASES.find((definition) => definition.id === id);
}

export function listProtocolBases(): readonly ProtocolBaseDefinition[] {
  return PROTOCOL_BASES;
}
