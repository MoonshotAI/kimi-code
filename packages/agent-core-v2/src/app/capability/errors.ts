import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CapabilityErrors = {
  codes: {
    CAPABILITY_NOT_FOUND: 'capability.not_found',
    CAPABILITY_UNSUPPORTED: 'capability.unsupported',
    CAPABILITY_INSTALL_IN_PROGRESS: 'capability.install_in_progress',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CapabilityErrors);
