import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const CapabilityErrors = {
  codes: {
    CAPABILITY_NOT_FOUND: 'capability.not_found',
    CAPABILITY_UNSUPPORTED: 'capability.unsupported',
    CAPABILITY_INSTALL_IN_PROGRESS: 'capability.install_in_progress',
    CAPABILITY_PROCESSES_RUNNING: 'capability.processes_running',
    CAPABILITY_PROCESS_CONTROL_FAILED: 'capability.process_control_failed',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CapabilityErrors);
