import { errorStatusCode } from '#/llm/errors';
import type { LlmModel } from '#/llm/model';
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
  let forceNext = false;
  return {
    resolve: async () => {
      const force = forceNext ? true : undefined;
      forceNext = false;
      const apiKey = await getToken({ force });
      return apiKey === undefined ? undefined : { apiKey };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      forceNext = true;
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

export async function attemptWithCredentialRecovery<T>(
  credentials: LlmCredentialProvider,
  attempt: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (signal?.aborted === true || credentials.canRecover?.(error) !== true) {
      throw error;
    }
    credentials.invalidate?.();
    return attempt();
  }
}
