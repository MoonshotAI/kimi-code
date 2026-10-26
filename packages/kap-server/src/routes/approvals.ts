import {
  INTERACTION_TAG_AGENT_ID,
  INTERACTION_TAG_SESSION_ID,
  INTERACTION_TAG_TURN_ID,
  interactions,
  MAIN_AGENT_ID,
  resumeSessionById,
  type ApprovalRequest,
  type Interaction,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
} from '../protocol/rest-approval';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface ApprovalRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function registerApprovalsRoutes(app: ApprovalRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/approvals',
      params: sessionIdParamSchema,
      querystring: listPendingApprovalsQuerySchema,
      success: { data: listPendingApprovalsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List pending approval requests for a session',
      tags: ['approvals'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = await resumeSessionById(core.accessor, session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const pending = interactions.findAll({
        kind: 'approval',
        resolved: false,
        tags: { [INTERACTION_TAG_SESSION_ID]: session_id },
      });
      const items = pending.map((i) => toWireApproval(i, session_id));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<ApprovalRouteHost['get']>[2]);
}

export function approvalExpiresAt(interaction: Interaction): string {
  return new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString();
}

export function interactionAgentId(interaction: Interaction): string {
  const tag = interaction.tags[INTERACTION_TAG_AGENT_ID];
  return typeof tag === 'string' ? tag : MAIN_AGENT_ID;
}

export function toWireApproval(interaction: Interaction, sessionId: string): {
  approval_id: string;
  session_id: string;
  agent_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
  expires_at: string;
} {
  const p = interaction.payload as ApprovalRequest;
  const turnId = interaction.tags[INTERACTION_TAG_TURN_ID];
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    agent_id: interactionAgentId(interaction),
    turn_id: typeof turnId === 'number' ? turnId : undefined,
    tool_call_id: p.toolCallId ?? interaction.id,
    tool_name: p.toolName,
    action: p.action,
    tool_input_display: p.display,
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: approvalExpiresAt(interaction),
  };
}
