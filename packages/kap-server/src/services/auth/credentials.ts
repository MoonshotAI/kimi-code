import { timingSafeEqual } from 'node:crypto';

import type { IAuthTokenService } from './authTokenService';

export type CredentialValidator = (candidate: string) => Promise<boolean>;

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCredentialValidator(
  authTokenService: IAuthTokenService,
  rpcToken?: string,
): CredentialValidator {
  return async (candidate) => {
    if (await authTokenService.isValid(candidate)) return true;
    if (rpcToken !== undefined && candidate.length > 0 && timingSafeMatch(candidate, rpcToken)) {
      return true;
    }
    return false;
  };
}
