import type { LlmRequest } from '#/llm/request';
import type { LlmNoticeSink } from '#/llm/response';

export interface LlmResolveControl {
  readonly signal: AbortSignal;
  readonly report: LlmNoticeSink;
}

export interface LlmResolver {
  readonly id: string;
  resolve(request: LlmRequest, ctl: LlmResolveControl): Promise<LlmRequest>;
}
