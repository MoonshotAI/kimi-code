import type { LlmModel } from '#/llm/model';

export interface CredentialResolveOptions {
  readonly force?: boolean;
}

export interface CredentialSource {
  resolve(model: LlmModel, options?: CredentialResolveOptions): Promise<LlmModel> | LlmModel;
  canRecover?(model: LlmModel, error: unknown): boolean;
}
