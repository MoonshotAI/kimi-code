/**
 * Auth token service accepting either the persistent bearer token or an optional password.
 */

import { createDecorator } from '@moonshot-ai/agent-core-v2';

import { verifyPassword } from './password';
import type { TokenStore } from './tokenStore';

export interface IAuthTokenService {
  readonly _serviceBrand: undefined;
  getToken(): string;
  isValid(candidate: string): Promise<boolean>;
}

export const IAuthTokenService = createDecorator<IAuthTokenService>('authTokenService');

export function createAuthTokenService(deps: {
  readonly tokenStore: TokenStore;
  readonly passwordHash: string | undefined;
}): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => deps.tokenStore.getToken(),
    isValid: async (candidate) =>
      deps.tokenStore.isValid(candidate) || (await verifyPassword(candidate, deps.passwordHash)),
  };
}
