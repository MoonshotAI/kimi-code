/**
 * `injection` test stubs — shared `IInjectionService` placeholder.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../injection/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IInjectionService } from '#/injection/injection';

/**
 * Register an empty `IInjectionService` placeholder. Tests exercising the real
 * `InjectionService` should override it via `additionalServices`.
 */
export function registerInjectionServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(IInjectionService, {});
}
