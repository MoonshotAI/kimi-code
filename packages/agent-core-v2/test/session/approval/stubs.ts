/**
 * `approval` test stubs — shared doubles for `ISessionApprovalService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../approval/stubs`).
 */

import type { ApprovalResponse, ISessionApprovalService } from '#/session/approval/approval';

export function stubApprovalService(respond: () => ApprovalResponse): ISessionApprovalService {
  return {
    _serviceBrand: undefined,
    request: async () => respond(),
    enqueue: (req) => ({ ...req, id: 'stub-approval-id' }),
    decide: () => {},
    listPending: () => [],
  };
}
