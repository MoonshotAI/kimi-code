/**
 * `/sessions/{sid}/passwords*` route handlers — sudo askpass password prompts.
 *
 * Implements the `/api/v1/sessions/{sid}/passwords` wire contract on top of
 * `agent-core-v2` services. Backed by the Session-scoped
 * `ISessionPasswordService` (for `resolve`) and `ISessionInteractionService`
 * (for the pending list + recently-resolved ledger).
 *
 *   GET  /sessions/{sid}/passwords              data: { items: PasswordRequest[] }
 *   POST /sessions/{sid}/passwords/{pid}        body: { password } | { cancelled: true }
 *                                               data: { resolved: true, resolved_at }
 *
 * Error mapping (REST.md §3.6):
 *   - 40401 (session.not_found)        — no live session matches {sid}
 *   - 40416 (password.not_found)       — no pending password request matches {pid}
 *   - 40902 (approval.already_resolved)— duplicate resolve; shared
 *                                        "already_resolved" code, custom envelope
 *                                        `{code:40902, data:{resolved:false}}`
 *   - 40001 (validation.failed)        — bad body via the Zod preHandler
 *
 * **Idempotency**: the interaction kernel remembers recently-resolved ids (60s
 * window). A re-POST of a just-resolved id hits `isRecentlyResolved` → 40902;
 * an id that never existed (or fell out of the window) → 40416.
 *
 * **SECURITY**: the resolve body carries the raw sudo password. It is
 * forwarded to the in-process broker and nowhere else — never logged (the
 * request log records only the outcome), never echoed in an envelope, event,
 * or snapshot, and never journaled (the kernel persists a redacted
 * `{cancelled}` response for password interactions).
 */

import {
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionPasswordService,
  type Interaction,
  type PasswordRequest,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import {
  listPendingPasswordsResponseSchema,
  passwordAlreadyResolvedDataSchema,
  passwordResolveRequestSchema,
  passwordResolveResultSchema,
} from '../protocol/rest-password';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';

interface PasswordRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
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

const passwordParamsSchema = z.object({
  session_id: z.string().min(1),
  password_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerPasswordsRoutes(app: PasswordRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/passwords',
      params: sessionIdParamSchema,
      success: { data: listPendingPasswordsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List pending sudo password requests for a session',
      tags: ['passwords'],
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
      const pending = handle.accessor.get(ISessionInteractionService).listPending('password');
      const items = pending.map((i) => toWirePassword(i, session_id));
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<PasswordRouteHost['get']>[2]);

  const resolveRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/passwords/{password_id}',
      params: passwordParamsSchema,
      body: passwordResolveRequestSchema,
      success: { data: passwordResolveResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.PASSWORD_NOT_FOUND]: {},
        [ErrorCode.APPROVAL_ALREADY_RESOLVED]: {
          dataSchema: passwordAlreadyResolvedDataSchema,
        },
      },
      description: 'Resolve a sudo password request (submit or cancel)',
      tags: ['passwords'],
    },
    async (req, reply) => {
      const { session_id, password_id } = req.params;
      const handle = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const interaction = handle.accessor.get(ISessionInteractionService);
      const isPending = interaction
        .listPending('password')
        .some((i) => i.id === password_id);

      if (!isPending) {
        if (interaction.isRecentlyResolved(password_id)) {
          reply.send({
            code: ErrorCode.APPROVAL_ALREADY_RESOLVED, // 40902 — shared "already_resolved"
            msg: `password ${password_id} already resolved`,
            data: { resolved: false as const },
            request_id: req.id,
          });
          return;
        }
        reply.send(
          errEnvelope(ErrorCode.PASSWORD_NOT_FOUND, `password ${password_id} not found`, req.id),
        );
        return;
      }

      const body = req.body;
      const cancelled = 'cancelled' in body;
      handle.accessor.get(ISessionPasswordService).resolve(password_id, {
        cancelled,
        password: cancelled ? undefined : body.password,
      });
      // Security-sensitive: record the outcome only — NEVER the password.
      requestLog(req)?.info(
        { session_id, password_id, outcome: cancelled ? 'cancelled' : 'submitted' },
        'password resolved',
      );
      reply.send(
        okEnvelope({ resolved: true as const, resolved_at: new Date().toISOString() }, req.id),
      );
    },
  );
  app.post(
    resolveRoute.path,
    resolveRoute.options,
    resolveRoute.handler as Parameters<PasswordRouteHost['post']>[2],
  );
}

// ---------------------------------------------------------------------------
// Projection — v2 interaction (password kind) onto the wire
// `passwordRequestSchema`. Carries the prompt only; never any response data.
// ---------------------------------------------------------------------------

export function toWirePassword(interaction: Interaction, sessionId: string): {
  id: string;
  session_id: string;
  prompt: string;
  command?: string;
} {
  const p = interaction.payload as PasswordRequest;
  return {
    id: interaction.id,
    session_id: sessionId,
    prompt: p.prompt,
    command: p.command,
  };
}
