/**
 * `sessionExport` domain error codes — export precondition failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionExportErrors = {
  codes: {
    SESSION_EXPORT_NOT_FOUND: 'session.export_not_found',
    SESSION_EXPORT_MISSING_VERSION: 'session.export_missing_version',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SessionExportErrors);
