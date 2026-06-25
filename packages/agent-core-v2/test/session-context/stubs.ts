/**
 * `session-context` test stubs — shared `ISessionContext` placeholder.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../session-context/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { ISessionContext } from '#/session-context/sessionContext';

/** Register an empty `ISessionContext` placeholder. */
export function registerSessionContextServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(ISessionContext, {});
}
