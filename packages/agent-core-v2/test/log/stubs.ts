/**
 * `log` test stubs — shared no-op `ILogService` / `ILogger` for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../log/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import type { ILogger } from '#/_base/log/log';

/** A no-op `ILogger`: every method is a no-op, `child()` returns itself. */
export function stubLogger(): ILogger {
  const logger: ILogger = {
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => logger,
  };
  return logger;
}

/** A no-op `ILogService` fixed at `info` level. */
export function stubLog(): ILogService {
  return {
    ...stubLogger(),
    _serviceBrand: undefined,
    level: 'info',
    setLevel: () => {},
    flush: () => Promise.resolve(),
  };
}

/** Register the default no-op `ILogService`. */
export function registerLogServices(reg: ServiceRegistration): void {
  reg.defineInstance(ILogService, stubLog());
}
