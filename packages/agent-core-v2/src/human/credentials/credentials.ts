import { errorCode, errorStatusCode } from '@moonshot-ai/core/llm/protocol/errors';
import type { LlmCredentialProvider } from '@moonshot-ai/core/llm/request';

export interface AccessTokenResolver {
  (options?: { readonly force?: boolean }): Promise<string | undefined>;
}

export interface OAuthCredentialProviderOptions {
  readonly isNonRecoverableCode?: (code: string) => boolean;
}

export function createStaticCredentialProvider(apiKey?: string): LlmCredentialProvider {
  return {
    resolve: () =>
      apiKey === undefined || apiKey.trim().length === 0 ? undefined : { apiKey },
  };
}

export function createOAuthCredentialProvider(
  getToken: AccessTokenResolver,
  options?: OAuthCredentialProviderOptions,
): LlmCredentialProvider {
  let refreshed: Promise<string | undefined> | undefined;
  return {
    resolve: async () => {
      const pending = refreshed;
      refreshed = undefined;
      const apiKey = pending === undefined ? await getToken() : await pending;
      return apiKey === undefined ? undefined : { apiKey };
    },
    canRecover: (error) => {
      if (errorStatusCode(error) !== 401) return false;
      const code = errorCode(error);
      if (code !== undefined && options?.isNonRecoverableCode?.(code) === true) return false;
      return true;
    },
    invalidate: () => {
      refreshed ??= getToken({ force: true });
      refreshed.catch(() => {});
    },
  };
}
