/**
 * `/sessions/{sid}/approvals*` REST routes.
 *
 * 2 endpoints (REST.md §3.6):
 *
 *   GET    /sessions/{sid}/approvals?status=pending
 *                                             data: { items: ApprovalRequest[] }
 *   POST   /sessions/{sid}/approvals/{aid}   body: ApprovalResponse
 *                                               data: { resolved: true, resolved_at }
 *
 * Error mapping (REST.md §3.6):
 *   - 40404 (approval.not_found)         — no pending approval matches {aid}
 *   - 40902 (approval.already_resolved)  — second resolve; custom envelope
 *                                          `{code:40902, data:{resolved:false}}`
 *                                          matching the server's idempotent-conflict pattern
 *   - 40001 (validation.failed)          — bad body via the Zod preHandler
 *
 * **Mechanism**: idempotency is handled by the broker's `isPending()` gate
 * BEFORE calling `resolve()`. The broker drops the entry on resolve, so a
 * second call sees `!isPending` → we emit `40902`. (REST.md §3.6 says
 * `details.resolved_by` should carry the client_id; today we don't track
 * who answered first, so `details` stays absent — fully spec-compliant
 * but conservative.)
 *
 * **Anti-corruption**: route resolves `IApprovalService` via the accessor —
 * no SDK imports.
 */

import {
  approvalResolveRequestSchema,
  approvalResolveResultSchema,
  ErrorCode,
  listPendingApprovalsQuerySchema,
  listPendingApprovalsResponseSchema,
} from '@moonshot-ai/protocol';
import { IApprovalService, approvalToAgentCoreResponse, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  ApprovalService,
} from '#/services/approval';

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

export function registerApprovalsRoutes(
  app: ApprovalRouteHost,
  ix: IInstantiationService,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/approvals',
      params: sessionIdParamSchema,
      querystring: listPendingApprovalsQuerySchema,
      success: { data: listPendingApprovalsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {
          detailsSchema: z.array(
            z.object({ path: z.string(), message: z.string() }),
          ),
        },
      },
      description: 'List pending approval requests for a session',
      tags: ['approvals'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const broker = ix.invokeFunction((a) =>
        a.get(IApprovalService) as ApprovalService,
      );
      reply.send(okEnvelope({ items: broker.listPending(session_id) }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<ApprovalRouteHost['get']>[2],
  );

  const route = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/approvals/{approval_id}',
      params: approvalParamsSchema,
      body: approvalResolveRequestSchema,
      success: { data: approvalResolveResultSchema },
      description: 'Resolve an approval request',
      tags: ['approvals'],
    },
    async (req, reply) => {
        const { approval_id } = req.params;
        const body = req.body;

        // Pre-check pending state. Two failure modes:
        //   - never-existed → 40404 (approval.not_found)
        //   - was-pending-and-resolved → 40902 (approval.already_resolved)
        // The broker doesn't distinguish — the route does, using
        // `isPending()`. We can't tell "never-existed" from "already-resolved"
        // without history, so we conservatively emit 40404 (more accurate
        // signal that the id is invalid; 40902 would be misleading for a
        // typo'd id). The broker tracks a short recently-resolved window to
        // honor 40902 for immediate re-POSTs.
        const broker = ix.invokeFunction((a) =>
          a.get(IApprovalService) as ApprovalService,
        );
        if (!broker.isPending(approval_id)) {
          // 40404 path covers BOTH "never-existed" and "already-resolved" in
          // this iteration. REST.md §3.6 lists 40902 for "已应答 + 抢答场景" —
          // for that we'd need a resolved-ids ledger. To still honor the 40902
          // contract for re-POST cases, broker tracks recently-resolved ids:
          // see `isRecentlyResolved`.
          if (broker.isRecentlyResolved(approval_id)) {
            reply.send({
              code: ErrorCode.APPROVAL_ALREADY_RESOLVED,
              msg: `approval ${approval_id} already resolved`,
              data: { resolved: false },
              request_id: req.id,
            });
            return;
          }
          reply.send(
            errEnvelope(
              ErrorCode.APPROVAL_NOT_FOUND,
              `approval ${approval_id} not found`,
              req.id,
            ),
          );
          return;
        }

        // Adapt wire body → in-process SDK shape; settle the broker Promise.
        // The broker also broadcasts `event.approval.resolved` synchronously
        // before settling.
        const inProc = approvalToAgentCoreResponse(body);
        broker.resolve(approval_id, inProc);
        // Mark for short-window idempotency.
        broker.markResolved(approval_id);

        const result = {
          resolved: true,
          resolved_at: new Date().toISOString(),
        };
        reply.send(okEnvelope(result, req.id));
    },
  );

  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ApprovalRouteHost['post']>[2],
  );
}
