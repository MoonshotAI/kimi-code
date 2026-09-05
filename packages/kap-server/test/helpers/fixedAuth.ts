import type { IAuthTokenService } from '../../src/services/auth/authTokenService';

export function fixedTokenAuth(token = 'test-token'): IAuthTokenService {
  return {
    _serviceBrand: undefined,
    getToken: () => token,
    isValid: async (candidate) => candidate === token,
  };
}
