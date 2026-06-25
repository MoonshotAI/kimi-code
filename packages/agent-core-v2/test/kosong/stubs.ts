/**
 * `kosong` test stubs — shared kosong collaborators for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../kosong/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { ILLMService } from '#/kosong/kosong';

/** Register an empty `ILLMService` placeholder. */
export function registerKosongServices(reg: ServiceRegistration): void {
  reg.definePartialInstance(ILLMService, {});
}
