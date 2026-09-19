import type { Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';

import type { LlmRecovering } from './recovery';
import type { LlmRetrying } from './retry';
import type { ToolCallIdNormalizer } from './tool-call-id';

import type {
  LlmCredentialProvider,
  LlmRequestConfig,
  LlmRequestContent,
  LlmRequestEvent,
} from './requester';
import type { LlmAborted, LlmOutput } from './settle';

export interface LlmInput {
  readonly config: LlmRequestConfig;
  readonly content: LlmRequestContent;
  readonly signal: AbortSignal;
  readonly toolCallIds?: ToolCallIdNormalizer;
  readonly credentialProvider?: LlmCredentialProvider;
}

export interface MessageResolveContext {
  readonly model: LlmModel;
  readonly signal: AbortSignal;
}

export interface MessageResolver {
  readonly id: string;
  resolve(
    messages: readonly Message[],
    ctx: MessageResolveContext,
  ): Promise<readonly Message[]>;
}

export type LlmEvent =
  | Exclude<LlmRequestEvent, { type: 'llm.sent' } | { type: 'llm.done' }>
  | { type: 'llm.sent' }
  | ({ type: 'llm.done' } & LlmOutput)
  | ({ type: 'llm.aborted' } & LlmAborted)
  | LlmRetrying
  | LlmRecovering;
