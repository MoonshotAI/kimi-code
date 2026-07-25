/**
 * `config` domain error codes.
 *
 * The `config.invalid` code string is owned by the kosong L0 wire contract
 * (`kosong/contract/errors.ts`); this module only registers it.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { CONFIG_INVALID_ERROR_CODE } from '#/kosong/contract/errors';

export const ConfigErrors = {
  codes: {
    CONFIG_INVALID: CONFIG_INVALID_ERROR_CODE,
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ConfigErrors);
