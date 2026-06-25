/**
 * `records` test stubs — shared no-op records implementations for unit tests.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or `../records/stubs`).
 */

import type { ServiceRegistration } from '#/_base/di/test';
import { IAgentRecords, ISessionMetaStore } from '#/records/records';

/**
 * A no-op `IAgentRecords`: writes vanish, replay yields nothing, restore is a
 * no-op. Use when the service under test requires an `IAgentRecords`
 * dependency but the test does not exercise persistence.
 */
export function stubAgentRecords(): IAgentRecords {
  return {
    _serviceBrand: undefined,
    logRecord: () => Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/require-await
    replay: async function* () {
      /* no records in tests */
    },
    restore: () => Promise.resolve(),
  };
}

/**
 * Register the default records collaborators: a no-op `IAgentRecords` and an
 * empty `ISessionMetaStore` placeholder.
 */
export function registerRecordsServices(reg: ServiceRegistration): void {
  reg.defineInstance(IAgentRecords, stubAgentRecords());
  reg.definePartialInstance(ISessionMetaStore, {});
}
