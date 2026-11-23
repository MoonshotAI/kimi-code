import { timingSafeEqual } from 'node:crypto';

import { createDecorator } from '@moonshot-ai/agent-core-v2';

import { verifyPassword } from './password';
import { generateServerToken } from './persistentToken';
import type { TokenStore } from './tokenStore';

export interface IAuthTokenService {
  readonly _serviceBrand: undefined;

  getToken(): string;

  isValid(candidate: string): Promise<boolean>;
}

export const IAuthTokenService =
  createDecorator<IAuthTokenService>('authTokenService');

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

export function createEphemeralAuthTokenService(
  secret: string = generateServerToken(),
): IAuthTokenService {
  const expected = Buffer.from(secret, 'utf8');
  return {
    _serviceBrand: undefined,
    getToken: () => secret,
    isValid: async (candidate: string) => {
      const actual = Buffer.from(candidate, 'utf8');
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    },
  };
}
