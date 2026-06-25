/**
 * `environment` test stubs — shared `IEnvironmentService` stub for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../environment/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IEnvironmentService } from '#/environment/environment';

/**
 * An `IEnvironmentService` rooted at the given home dir. `detect()` rejects
 * with "unused in test" so accidental calls surface loudly rather than
 * silently hitting the real OS probe.
 */
export function stubEnvironment(homeDir = '/tmp/kimi-home'): IEnvironmentService {
  return {
    _serviceBrand: undefined,
    homeDir,
    configPath: `${homeDir}/config.toml`,
    detect: () => Promise.reject(new Error('unused in test')),
  };
}

/** Register the default `IEnvironmentService` rooted at `/tmp/kimi-home`. */
export function registerEnvironmentServices(reg: ServiceRegistration): void {
  reg.defineInstance(IEnvironmentService, stubEnvironment());
}
