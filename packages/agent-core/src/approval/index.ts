// approval/index.ts — public contract surface (pure contract: no *Service impl,
// no tools, so no registerApprovalServices / registerApprovalTools).
// Mirrors the surface historically re-exported from services/index.ts so the
// package root barrel stays byte-for-byte compatible for consumers like server.
export { IApprovalService } from './approval';
export type { ApprovalRequest, ApprovalResponse } from './approval';
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './approval';
