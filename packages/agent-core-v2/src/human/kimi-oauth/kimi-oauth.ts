import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import type { CredentialSource } from './credential-source';

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const status = record['status'] ?? record['statusCode'];
  return typeof status === 'number' ? status : undefined;
}

export function kimiOAuthCredentialSource(tokens: BearerTokenProvider): CredentialSource {
  return {
    resolve: async (model, options) => ({
      ...model,
      apiKey: await tokens.getAccessToken({ force: options?.force === true }),
    }),
    canRecover: (_model, error) => statusOf(error) === 401,
  };
}
