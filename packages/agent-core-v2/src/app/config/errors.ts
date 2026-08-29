import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';

export const ConfigErrors = {
  codes: {
    CONFIG_INVALID: CONFIG_INVALID_ERROR_CODE,
    CONFIG_PERSIST_BLOCKED: 'config.persist_blocked',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ConfigErrors);
