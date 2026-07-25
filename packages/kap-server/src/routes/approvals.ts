/**
 * `/sessions/{sid}/approvals*` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions/{sid}/approvals` wire contract on top of
 * `agent-core-v2` services. Backed by the Session-scoped `ISessionApprovalService`
 * (for `decide`) and `ISessionInteractionService` (for the pending list, including the
 * `createdAt` metadata the facade does not surface).
 *
 *   GET  /sessions/{sid}/approvals?status=pending   data: { items: ApprovalRequest[] }
 *   POST /sessions/{sid}/approvals/{aid}            body: ApprovalResponse
 *                                                   data: { resolved: true, resolved_at }
 *
 * Error mapping (REST.md §3.6):
 *   - 40401 (session.not_found)        — no live session matches {sid}
 *   - 40404 (approval.not_found)       — no pending approval matches {aid}
 *   - 40902 (approval.already_resolved)— duplicate resolve; custom envelope
 *                                        `{code:40902, data:{resolved:false}}`
 *   - 40001 (validation.failed)        — bad body via the Zod preHandler
 *
 * **Idempotency**: the interaction kernel remembers recently-resolved ids (60s
 * window). A re-POST of a just-resolved id hits `isRecentlyResolved` → 40902;
 * an id that never existed (or fell out of the window) → 40404.
 *
 * **Wire fidelity gaps**:
 *   - `expires_at` — v2 interactions never expire; we emit a stable derived
 *     value (`created_at + 24h`) because the wire schema requires it.
 *   - `tool_call_id` / `session_id` — v2 marks them optional on the payload;
 *     we fall back to the interaction id / path session id when absent.
 */

import {
  ISessionApprovalService,
  ISessionInteractionService,
  ISessionLifecycleService,
  type ApprovalRequest,
  type ApprovalResponse,
  type Interaction,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  approvalAlreadyResolvedDataSchema,
  approvalResolveRequestSchema,
  approvalResolveResultSchema,
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
} from '../protocol/rest-approval';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
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
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const approvalParamsSchema = z.object({
  session_id: z.string().min(1),
  approval_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

/** Stable, derived expiry horizon: v2 approvals do not expire. */
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
      const handle = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const pending = handle.accessor.get(ISessionInteractionService).listPending('approval');
      const items = pending.map((i) => toWireApproval(i, session_id));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<ApprovalRouteHost['get']>[2]);

  const resolveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/approvals/{approval_id}',
      params: approvalParamsSchema,
      body: approvalResolveRequestSchema,
      success: { data: approvalResolveResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: {
          dataSchema: approvalAlreadyResolvedDataSchema,
        },
      },
      description: 'Resolve an approval request',
      tags: ['approvals'],
    },
    async (req, reply) => {
      const { session_id, approval_id } = req.params;
      const handle = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const interaction = handle.accessor.get(ISessionInteractionService);
      const isPending = interaction
        .listPending('approval')
        .some((i) => i.id === approval_id);

      if (!isPending) {
        if (interaction.isRecentlyResolved(approval_id)) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
            msg: `approval ${approval_id} already resolved`,
            data: { resolved: false as const },
            request_id: req.id,
          });
          return;
        }
        reply.send(
          errEnvelope(ErrorCode.APPROVAL_NOT_FOUND, `approval ${approval_id} not found`, req.id),
        );
        return;
      }

      const body = req.body;
      const response: ApprovalResponse = {
        decision: body.decision,
        scope: body.scope,
        feedback: body.feedback,
        selectedLabel: body.selected_label,
      };
      handle.accessor.get(ISessionApprovalService).decide(approval_id, response);
      // Security-sensitive: record who resolved what, and how.
      requestLog(req)?.info(
        { session_id, approval_id, decision: response.decision, scope: response.scope },
        'approval decided',
      );
      reply.send(
        okEnvelope({ resolved: true as const, resolved_at: new Date().toISOString() }, req.id),
      );
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<ApprovalRouteHost['post']>[2],
  );
}

// ---------------------------------------------------------------------------
// Projection — v2 interaction (approval kind) onto the v1 wire
// `approvalRequestSchema`.
// ---------------------------------------------------------------------------

export function toWireApproval(interaction: Interaction, sessionId: string): {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display: unknown;
  created_at: string;
  expires_at: string;
} {
  const p = interaction.payload as ApprovalRequest;
  return {
    approval_id: interaction.id,
    session_id: sessionId,
    turn_id: interaction.origin.turnId,
    tool_call_id: p.toolCallId ?? interaction.id,
    tool_name: p.toolName,
    action: p.action,
    tool_input_display: p.display,
    created_at: new Date(interaction.createdAt).toISOString(),
    expires_at: new Date(interaction.createdAt + APPROVAL_EXPIRY_MS).toISOString(),
  };
}
