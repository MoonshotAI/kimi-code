import type { LlmModel } from '#/llm/model';

export interface ProtocolHookContext {
  readonly model: LlmModel;
}
