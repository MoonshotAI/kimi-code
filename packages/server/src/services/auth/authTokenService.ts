/**
 * `IAuthTokenService` DI surface (ROADMAP M2.1).
 *
 * Exposes the persistent bearer token plus a single validity check that accepts
 * EITHER the persistent token (constant-time, via `TokenStore`) OR a verified
 * user password (bcrypt, async). The seam exists so tests can inject a
 * fixed-token impl via `startServer({ serviceOverrides })`, and so `start.ts`
 * (M5.1) can wire the real async-built instance at boot.
 *
 * `isValid` is async because password verification (`bcrypt.compare`) is
 * async — the token path is synchronous, but the interface must await both.
 */

import { createDecorator } from '@moonshot-ai/agent-core';

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

// eslint-disable-next-line @typescript-eslint/no-redeclare
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
