/**
 * `approval` domain (L7) — session-scope approval broker.
 *
 * Defines the public contract of approval brokering: the `ApprovalRequest` /
 * `ApprovalDecision` models and the `IApprovalService` used to request a
 * decision, resolve it, and list pending approvals. Session-scoped — one
 * broker per session.
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
