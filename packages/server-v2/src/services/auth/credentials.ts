/**
 * Unified credential validator.
 *
 * One persistent bearer token (held by {@link IAuthTokenService}) protects every
 * route. An optional `rpcToken` may be accepted as an *additional* credential
 * for the `/api/v2` RPC surface (REST + WebSocket); it is never required and
 * never the only gate. The validator returns true when the presented candidate
 * matches the persistent token / password (via {@link IAuthTokenService.isValid})
 * OR, when configured, the `rpcToken` (compared timing-safely).
 *
 * Shared by the global HTTP auth hook, the WebSocket upgrade handler, and the
 * post-connect handshakes so the same credential is accepted everywhere (no
 * "passes upgrade with the bearer then fails the handshake on rpcToken"
 * mismatch).
 */

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
