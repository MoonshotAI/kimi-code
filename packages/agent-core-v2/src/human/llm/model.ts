import type { ModelCapability } from '#/llm/capability';

export interface LlmConnection {
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly defaultHeaders?: Record<string, string>;
}

export interface LlmModel extends LlmConnection {
  readonly provider: string;
  readonly model: string;
  readonly capability: ModelCapability;
  readonly maxContextSize?: number;
  readonly maxInputSize?: number;
}

export function modelKey(model: LlmModel): string {
  return model.baseUrl === undefined ? model.model : `${model.baseUrl}#${model.model}`;
}
