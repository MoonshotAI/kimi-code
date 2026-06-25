/**
 * `permission` test stubs — shared `IPermissionService` placeholder.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permission/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IPermissionService } from '#/permission/permission';

/**
 * Register an empty `IPermissionService` placeholder. Tests exercising the real
 * `PermissionService` should override it via `additionalServices`.
 */
export function registerPermissionServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(IPermissionService, {});
}
