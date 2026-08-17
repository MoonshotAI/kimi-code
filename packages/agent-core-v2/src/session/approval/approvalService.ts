/**
 * `approval` domain — `ISessionApprovalService` implementation.
 *
 * Typed facade over the `interaction` kernel for approval requests; owns no
 * pending state of its own (the kernel holds it). Interaction ids are minted
 * here (`approval_<uuid>`) — never derived from the provider's toolCallId,
 * which is not unique across responses on some self-hosted endpoints and stays
 * on the payload for correlation only. `listPending` merges the parked id back
 * into each returned request so hosts can `decide` without kernel access.
 * Bound at Session scope.
 */

import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionInteractionService } from '#/session/interaction/interaction';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  ISessionApprovalService,
} from './approval';

export class SessionApprovalService implements ISessionApprovalService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionInteractionService private readonly interaction: ISessionInteractionService) {}

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    return this.interaction.request<ApprovalRequest, ApprovalResponse>({
      id: requestId(req),
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
  }

  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string } {
    const id = requestId(req);
    this.interaction.enqueue<ApprovalRequest>({
      id,
      kind: 'approval',
      payload: req,
      origin: { agentId: req.agentId, turnId: req.turnId },
    });
    return { ...req, id };
  }

  decide(id: string, response: ApprovalResponse): void {
    this.interaction.respond(id, response);
  }

  listPending(): readonly ApprovalRequest[] {
    return this.interaction
      .listPending('approval')
      .map((i) => ({ ...(i.payload as ApprovalRequest), id: i.id }));
  }
}

function requestId(req: ApprovalRequest): string {
  return req.id ?? `approval_${randomUUID()}`;
}

registerScopedService(LifecycleScope.Session, ISessionApprovalService, SessionApprovalService, ScopeActivation.OnScopeCreated, 'approval');
