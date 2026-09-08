import { randomUUID } from 'node:crypto';

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_TOOL_CALL_ID,
  INTERACTION_TAG_TURN_ID,
  type InteractionTags,
} from '#/human/interaction/interaction';
import { ISessionInteractionService } from '#/session/interaction/sessionInteractionService';

import {
  type ApprovalRequest,
  type ApprovalResponse,
  ISessionApprovalService,
} from './approval';

export class SessionApprovalService implements ISessionApprovalService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionInteractionService private readonly interactions: ISessionInteractionService,
  ) {}

  request(req: ApprovalRequest): Promise<ApprovalResponse> {
    return this.interactions.request<ApprovalRequest, ApprovalResponse>({
      id: requestId(req),
      kind: 'approval',
      payload: req,
      tags: approvalTags(req),
    });
  }

  enqueue(req: ApprovalRequest): ApprovalRequest & { readonly id: string } {
    const id = requestId(req);
    this.interactions.enqueue<ApprovalRequest>({
      id,
      kind: 'approval',
      payload: req,
      tags: approvalTags(req),
    });
    return { ...req, id };
  }

  decide(id: string, response: ApprovalResponse): void {
    this.interactions.respond(id, response);
  }

  listPending(): readonly ApprovalRequest[] {
    return this.interactions.findAll({ kind: 'approval', resolved: false }).map((i) => ({
      ...(i.payload as ApprovalRequest),
      id: i.id,
    }));
  }
}

function requestId(req: ApprovalRequest): string {
  return req.id ?? `approval_${randomUUID()}`;
}

function approvalTags(req: ApprovalRequest): InteractionTags {
  const tags: InteractionTags = {};
  if (req.agentId !== undefined) tags[INTERACTION_TAG_AGENT_ID] = req.agentId;
  if (req.turnId !== undefined) tags[INTERACTION_TAG_TURN_ID] = req.turnId;
  if (req.toolCallId !== undefined) tags[INTERACTION_TAG_TOOL_CALL_ID] = req.toolCallId;
  return tags;
}

registerScopedService(LifecycleScope.Session, ISessionApprovalService, SessionApprovalService, ScopeActivation.OnScopeCreated, 'approval');
