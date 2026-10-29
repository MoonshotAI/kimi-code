import { timingSafeEqual } from 'node:crypto';

import type { IAuthTokenService } from './authTokenService';
import { LEGACY_AUTH_PRINCIPAL, type AuthPrincipal } from './principal';

export type CredentialValidator = (candidate: string) => Promise<AuthPrincipal | undefined>;

export interface CentralCredentialValidatorOptions {
  readonly authenticate: (candidate: string) => Promise<AuthPrincipal | undefined>;
  readonly enabled: () => boolean;
}

function timingSafeMatch(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCredentialValidator(
  authTokenService: IAuthTokenService,
  rpcToken?: string,
  central?: CentralCredentialValidatorOptions,
): CredentialValidator {
  return async (candidate) => {
    if (central?.enabled()) {
      const principal = await central.authenticate(candidate);
      if (principal !== undefined) return principal;
    }
    if (await authTokenService.isValid(candidate)) return LEGACY_AUTH_PRINCIPAL;
    if (rpcToken !== undefined && candidate.length > 0 && timingSafeMatch(candidate, rpcToken)) {
      return LEGACY_AUTH_PRINCIPAL;
    }
    return undefined;
  };
}
