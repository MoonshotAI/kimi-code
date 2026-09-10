import { errorStatusCode } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
import type { LlmRecovery } from '#/llm/requester/recovery';
import {
  mergeRequestHeaders,
  type LlmCredential,
  type LlmCredentialProvider,
} from '#/llm/requester/requester';

export interface CredentialTokenSource {
  (options?: { readonly force?: boolean }): Promise<string | undefined>;
}

export function staticCredentials(apiKey?: string): LlmCredentialProvider {
  return {
    resolve: () =>
      apiKey === undefined || apiKey.trim().length === 0 ? undefined : { apiKey },
  };
}

export function oauthCredentials(getToken: CredentialTokenSource): LlmCredentialProvider {
  let refreshed: Promise<string | undefined> | undefined;
  return {
    resolve: async () => {
      const pending = refreshed;
      refreshed = undefined;
      const apiKey = pending === undefined ? await getToken() : await pending;
      return apiKey === undefined ? undefined : { apiKey };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      refreshed ??= getToken({ force: true });
      refreshed.catch(() => {});
    },
  };
}

export function applyCredential(
  model: LlmModel,
  credential: LlmCredential | undefined,
): LlmModel {
  if (credential === undefined) {
    return model;
  }
  return {
    ...model,
    apiKey: credential.apiKey ?? model.apiKey,
    defaultHeaders: mergeRequestHeaders(model.defaultHeaders, credential.headers),
  };
}

export async function resolveModelCredentials(
  model: LlmModel,
  credentials: LlmCredentialProvider | undefined,
): Promise<LlmModel> {
  return applyCredential(model, await credentials?.resolve());
}

export const credentialsRecovery: LlmRecovery = {
  id: 'credentials',
  propose: ({ error, applied, credentials }) =>
    credentials?.canRecover?.(error) === true &&
    !applied.some((record) => record.strategy === 'credentials')
      ? { action: 'refresh', refreshCredentials: true }
      : undefined,
};
