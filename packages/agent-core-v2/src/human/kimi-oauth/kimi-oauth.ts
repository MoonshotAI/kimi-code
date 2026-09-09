import type { BearerTokenProvider } from '@moonshot-ai/kimi-code-oauth';

import { errorStatusCode } from '#/llm/errors';
import type { LlmCredentialProvider } from '#/llm/requester/requester';

export function kimiOAuthCredentialProvider(tokens: BearerTokenProvider): LlmCredentialProvider {
  let forceNext = false;
  return {
    resolve: async () => {
      const force = forceNext ? true : undefined;
      forceNext = false;
      return { apiKey: await tokens.getAccessToken({ force }) };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      forceNext = true;
    },
  };
}
