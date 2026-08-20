import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const MonitorErrors = {
  codes: {
    MONITOR_LIMIT_EXCEEDED: 'monitor.limit_exceeded',
    MONITOR_NOT_FOUND: 'monitor.not_found',
    MONITOR_INVALID_PATTERN: 'monitor.invalid_pattern',
    MONITOR_WATCH_FAILED: 'monitor.watch_failed',
    MONITOR_RUNTIME_UNAVAILABLE: 'monitor.runtime_unavailable',
  },
  retryable: ['monitor.limit_exceeded'],
} as const satisfies ErrorDomain;

registerErrorDomain(MonitorErrors);

export type MonitorErrorCode = (typeof MonitorErrors.codes)[keyof typeof MonitorErrors.codes];

export class MonitorError extends Error2 {
  constructor(code: MonitorErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'MonitorError';
  }
}
