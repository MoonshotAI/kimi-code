import { getTokenProvider } from '@aws/bedrock-token-generator';

import { errorStatusCode } from '#/llm/protocol/errors';
import type { LlmCredential, LlmCredentialProvider } from '#/llm/request';

export interface BedrockTokenProviderOptions {
  readonly region?: string;
  readonly profile?: string;
  readonly expiresInSeconds?: number;
  readonly now?: () => number;
  readonly createProvideToken?: (config: {
    readonly region?: string;
    readonly profile?: string;
    readonly expiresInSeconds?: number;
  }) => () => Promise<string>;
}

const DEFAULT_TTL_SECONDS = 43_200;
const EXPIRY_MARGIN_MS = 15 * 60 * 1000;

export function createBedrockTokenProvider(
  options: BedrockTokenProviderOptions = {},
): LlmCredentialProvider {
  const now = options.now ?? (() => Date.now());
  const ttlMs = (options.expiresInSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
  const provideToken = (options.createProvideToken ?? defaultProvideToken)({
    region: options.region,
    profile: options.profile,
    expiresInSeconds: options.expiresInSeconds,
  });
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  let refreshed: Promise<string> | undefined;

  const acquire = (): Promise<string> => {
    pending ??= provideToken().finally(() => {
      pending = undefined;
    });
    return pending;
  };

  return {
    resolve: async (): Promise<LlmCredential> => {
      const forced = refreshed;
      refreshed = undefined;
      if (forced !== undefined) {
        const token = await forced;
        cached = { token, expiresAt: now() + ttlMs - EXPIRY_MARGIN_MS };
        return { apiKey: token };
      }
      if (cached === undefined || now() >= cached.expiresAt) {
        const token = await acquire();
        cached = { token, expiresAt: now() + ttlMs - EXPIRY_MARGIN_MS };
      }
      return { apiKey: cached.token };
    },
    canRecover: (error) => errorStatusCode(error) === 401,
    invalidate: () => {
      cached = undefined;
      refreshed ??= acquire();
      refreshed.catch(() => undefined);
    },
  };
}

function defaultProvideToken(config: {
  readonly region?: string;
  readonly profile?: string;
  readonly expiresInSeconds?: number;
}): () => Promise<string> {
  return getTokenProvider({
    region: config.region,
    profile: config.profile,
    expiresInSeconds: config.expiresInSeconds,
  });
}
