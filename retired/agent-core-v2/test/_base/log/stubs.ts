/**
 * `log` test stubs — shared no-op `ILogService` / `ILogger` for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../log/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import type { ILogger } from '#/_base/log/log';

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

export function stubLog(): ILogService {
  return {
    ...stubLogger(),
    _serviceBrand: undefined,
    level: 'info',
    setLevel: () => {},
    flush: () => Promise.resolve(),
  };
}

export function registerLogServices(reg: ServiceRegistration): void {
  reg.defineInstance(ILogService, stubLog());
}
