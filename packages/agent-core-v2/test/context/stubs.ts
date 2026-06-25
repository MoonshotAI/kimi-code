/**
 * `context` test stubs — shared `IContextService` placeholder.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../context/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IContextService } from '#/context/context';

/**
 * Register an empty `IContextService` placeholder. Tests exercising the real
 * `ContextService` should override it via `additionalServices`.
 */
export function registerContextServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(IContextService, {});
}
