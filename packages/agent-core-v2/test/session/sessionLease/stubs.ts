/**
 * `sessionLease` test stubs — no-op session lease and write admission.
 *
 * Lives under `test/` (not `src/`). The default stub reports no lease info
 * and admits every write; tests that exercise fencing override the relevant
 * gate. Import from a relative path.
 */

import type { ISessionWriteAdmission } from '#/persistence/interface/sessionWriteAdmission';
import { ISessionLeaseService } from '#/session/sessionLease/sessionLease';

export function stubSessionLeaseService(
  overrides: Partial<ISessionLeaseService & ISessionWriteAdmission> = {},
): ISessionLeaseService & ISessionWriteAdmission {
  const lease: ISessionLeaseService & ISessionWriteAdmission = {
    _serviceBrand: undefined,
    info: undefined,
    assertWritable: () => {},
    assertCanWriteNow: () => lease.assertWritable(),
    withPhysicalWrite: async (io) => {
      lease.assertCanWriteNow();
      return io();
    },
    sealAndDrain: async () => {},
    ...overrides,
  };
  return lease;
}
