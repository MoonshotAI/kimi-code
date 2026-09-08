import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  enqueueSessionInteraction,
  listSessionPendingInteractions,
  requestSessionInteraction,
  respondSessionInteraction,
} from '#/features/interaction/sessionInteractions';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  ISessionApprovalService,
} from './approval';

export class SessionApprovalService implements ISessionApprovalService {
  declare readonly _serviceBrand: undefined;

  constructor(@IAgentLifecycleService private readonly agents: IAgentLifecycleService) {}

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    return requestSessionInteraction<ApprovalRequest, ApprovalResponse>(this.agents, {
      id: requestId(req),
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
  }

  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string } {
    const id = requestId(req);
    enqueueSessionInteraction<ApprovalRequest>(this.agents, {
      id,
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
    return { ...req, id };
  }

  decide(id: string, response: ApprovalResponse): void {
    respondSessionInteraction(this.agents, id, response);
  }

  listPending(): readonly ApprovalRequest[] {
    return listSessionPendingInteractions(this.agents, 'approval').map((i) => ({
      ...(i.payload as ApprovalRequest),
      id: i.id,
    }));
  }
}

function requestId(req: ApprovalRequest): string {
  return req.id ?? `approval_${randomUUID()}`;
}

registerScopedService(LifecycleScope.Session, ISessionApprovalService, SessionApprovalService, ScopeActivation.OnScopeCreated, 'approval');
