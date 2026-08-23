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
