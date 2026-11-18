import type { LlmRequest } from '#/llm/request';
import type { LlmNoticeSink } from '#/llm/response';
import type { LlmRecoveryRecord } from './recovery';

export interface LlmResolveControl {
  readonly signal: AbortSignal;
  readonly report: LlmNoticeSink;
  readonly appliedRecoveries: readonly LlmRecoveryRecord[];
}

export interface LlmResolver {
  readonly id: string;
  readonly recoveryRequest?: 'resolved';
  resolve(request: LlmRequest, ctl: LlmResolveControl): Promise<LlmRequest>;
}
