import { createDecorator } from '@moonshot-ai/agent-core-v2';

import { verifyPassword } from './password';
import type { TokenStore } from './tokenStore';

export interface IAuthTokenService {
  readonly _serviceBrand: undefined;

  /** The persistent bearer token (re-read from disk when its mtime changes). */
  getToken(): string;

  /**
   * True when `candidate` matches the persistent token OR verifies against the
   * configured password hash. Constant-time on the token path; bcrypt on the
   * password path.
   */
  isValid(candidate: string): Promise<boolean>;
}

export const IAuthTokenService =
  createDecorator<IAuthTokenService>('authTokenService');

/**
 * Default `IAuthTokenService` over a `TokenStore` + optional password hash.
 *
 * Constructed in `start.ts` (M5.1) where the async `TokenStore` /
 * `passwordHash` are available, then injected via `serviceOverrides`. NOT built
 * inside `createServerServiceCollection`: that path is synchronous and cannot
 * await the `TokenStore` file write or the bcrypt hash.
 */
export function createAuthTokenService(deps: {
  readonly tokenStore: TokenStore;
  readonly passwordHash: string | undefined;
}): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => deps.tokenStore.getToken(),
    isValid: async (candidate) =>
      deps.tokenStore.isValid(candidate) ||
      (await verifyPassword(candidate, deps.passwordHash)),
  };
}
