import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CronErrors = {
  codes: {
    CRON_EXPRESSION_INVALID: 'cron.expression_invalid',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CronErrors);
