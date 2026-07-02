import type { Message, ThinkingEffort, Tool } from '#/app/llmProtocol';
import type { Protocol } from '#/app/protocol';

import { createDecorator } from "#/_base/di";
import type { LLMRequestLogFields } from '#/agent/loop';

export interface LLMRequestLogInput {
  /** Wire protocol identifier (e.g. `kimi`, `anthropic`). */
  readonly protocol: Protocol;
  /** Wire-facing model name (e.g. `kimi-k2-instruct`). */
  readonly modelName: string;
  /** Config-side Model id / alias. */
  readonly modelAlias?: string;
  /** Thinking effort applied for the request, when any. */
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: LLMRequestLogFields;
}

export interface IAgentLLMRequestLogService {
  readonly _serviceBrand: undefined;

  logRequest(input: LLMRequestLogInput): void;
}

export const IAgentLLMRequestLogService =
  createDecorator<IAgentLLMRequestLogService>('agentLLMRequestLogService');
