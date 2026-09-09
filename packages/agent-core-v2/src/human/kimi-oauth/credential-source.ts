import type { LlmModel } from '#/llm/model';
import type { LlmRequestResolver } from '#/llm/requester/machine';
import type { LlmRecovery } from '#/llm/requester/recovery';

export interface CredentialResolveOptions {
  readonly force?: boolean;
}

export interface CredentialSource {
  resolve(model: LlmModel, options?: CredentialResolveOptions): Promise<LlmModel> | LlmModel;
  canRecover?(model: LlmModel, error: unknown): boolean;
}

export function credentialResolver(source: CredentialSource): LlmRequestResolver {
  return {
    id: 'credential',
    resolve: async ({ config }, ctx) => {
      const force =
        ctx.lastAttemptError !== undefined &&
        source.canRecover?.(config.model, ctx.lastAttemptError) === true;
      const model = await source.resolve(config.model, force ? { force: true } : undefined);
      if (model === config.model) return undefined;
      return { config: { ...config, model } };
    },
  };
}

export function credentialRecovery(source: CredentialSource): LlmRecovery {
  const id = 'credential';
  return {
    id,
    propose: ({ model, error, applied }) => {
      if (applied.some((record) => record.strategy === id)) return undefined;
      if (source.canRecover?.(model, error) !== true) return undefined;
      return { action: 'refresh-credentials' };
    },
  };
}
