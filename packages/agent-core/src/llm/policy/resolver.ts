import type { Message } from '#/llm/message';
import type { MediaSupport } from '#/llm/protocol/rules/media';
import type { LlmEndpoint, LlmModelSpec } from '#/llm/request';
import type { LlmNoticeSink } from '#/llm/response';

export interface MessageResolveContext {
  readonly model: LlmModelSpec;
  readonly endpoint?: LlmEndpoint;
  readonly media: MediaSupport;
  readonly signal: AbortSignal;
  readonly report: LlmNoticeSink;
}

export interface MessageResolver {
  readonly id: string;
  resolve(
    messages: readonly Message[],
    ctx: MessageResolveContext,
  ): Promise<readonly Message[]>;
}
