/**
 * `config` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const ConfigErrors = {
  codes: {
    CONFIG_INVALID: 'config.invalid',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ConfigErrors);
