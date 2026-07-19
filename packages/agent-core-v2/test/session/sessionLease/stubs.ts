/**
 * `sessionLease` test stubs — no-op `ISessionLeaseService` for unit tests.
 *
 * Lives under `test/` (not `src/`). The default stub reports no lease info
 * and passes every `assertWritable` gate; tests that exercise fencing pass an
 * `assertWritable` override that throws. Import from a relative path.
 */

import { ISessionLeaseService } from '#/session/sessionLease/sessionLease';

export function stubSessionLeaseService(
  overrides: Partial<ISessionLeaseService> = {},
): ISessionLeaseService {
  return {
    _serviceBrand: undefined,
    info: undefined,
    assertWritable: () => {},
    ...overrides,
  };
}
