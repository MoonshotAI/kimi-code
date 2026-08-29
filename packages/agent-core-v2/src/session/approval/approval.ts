import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface ISessionApprovalService {
  readonly _serviceBrand: undefined;

  request(req: ApprovalRequest): Promise<ApprovalResponse>;
  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string };
  decide(id: string, response: ApprovalResponse): void;
  listPending(): readonly ApprovalRequest[];
}

export const ISessionApprovalService: ServiceIdentifier<ISessionApprovalService> =
  createDecorator<ISessionApprovalService>('sessionApprovalService');
