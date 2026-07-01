import type { IAuthTokenService } from '../../src/services/auth/authTokenService';

/**
 * Deterministic `IAuthTokenService` for tests that need a known token without
 * touching the on-disk `server.token` store. Injected via
 * `startServer({ authTokenService: fixedTokenAuth(...) })`.
 */
export function fixedTokenAuth(token = 'test-token'): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: async (candidate) => candidate === token,
  };
}
