/**
 * `approval` domain (L7) — session-scope approval broker (reverse RPC).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ApprovalRequest {
  readonly id: string;
  readonly toolName: string;
}

export type ApprovalDecision = 'allow' | 'deny';

export interface IApprovalService {
  readonly _serviceBrand: undefined;
  request(req: ApprovalRequest): Promise<ApprovalDecision>;
  decide(id: string, decision: ApprovalDecision): void;
  listPending(): readonly ApprovalRequest[];
}

export const IApprovalService: ServiceIdentifier<IApprovalService> =
  createDecorator<IApprovalService>('approvalService');
