/**
 * Rust-engine session routes — the web UI's session surface served directly
 * by the Rust engine (no agent-core-v2 session services involved).
 *
 * Registers the same v1 wire shapes as the v2-backed routes (sessions,
 * prompts, approvals) so the web frontend is engine-agnostic. These routes
 * are registered INSTEAD of their v2 counterparts when the Rust engine is
 * available (see `registerApiV1Routes`).
 */

import { z } from 'zod';

import { okEnvelope, errEnvelope } from '../envelope';
import { ErrorCode } from '../protocol/error-codes';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

/** Map a zod error to the v1 validation envelope shape. */
function zodValidationEnvelope(error: z.ZodError, requestId: string) {
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg: error.issues[0]?.message ?? 'validation failed',
    data: null,
    request_id: requestId,
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

const createSessionSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const promptSchema = z.object({
  prompt: z.string(),
});

const resolveApprovalSchema = z.object({
  id: z.string(),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().optional(),
});

export interface RustSessionRouteHost {
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: any, reply: any) => unknown,
  ): unknown;
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (req: any, reply: any) => unknown,
  ): unknown;
}

/**
 * The minimum wire shapes the web UI needs. Session id params follow the v1
 * path convention `/sessions/:id/...`.
 */
export function registerRustSessionsRoutes(
  app: RustSessionRouteHost,
  rust: RustSessionService,
): void {
  app.post(
    '/sessions',
    { schema: { body: createSessionSchema } },
    async (req: any, reply: any) => {
      const body = createSessionSchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.send(zodValidationEnvelope(body.error, req.id));
        return;
      }
      const metadata = body.data.metadata ?? {};
      const workDir =
        (typeof metadata['cwd'] === 'string' ? metadata['cwd'] : undefined) ??
        process.cwd();
      const sessionId = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const session = await rust.createSession({
        sessionId,
        workDir,
      });
      if (session === null) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'Rust engine unavailable', req.id),
        );
        return;
      }
      const now = new Date().toISOString();
      reply.send(
        okEnvelope(
          {
            id: sessionId,
            workspace_id: '',
            title: body.data.title ?? '',
            created_at: now,
            updated_at: now,
            busy: false,
            main_turn_active: false,
            pending_interaction: 'none',
            archived: false,
            last_prompt: null,
            metadata: { cwd: workDir },
            agent_config: { model: '' },
            usage: { by_model: {}, total: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
            permission_rules: [],
            message_count: 0,
            last_seq: 0,
          },
          req.id,
        ),
      );
    },
  );

  app.post(
    '/sessions/:id/prompts',
    { schema: { body: promptSchema } },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = promptSchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.send(zodValidationEnvelope(body.error, req.id));
        return;
      }
      if (rust.getSession(id) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id));
        return;
      }
      try {
        const result = await rust.prompt(id, body.data.prompt);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error),
            req.id,
          ),
        );
      }
    },
  );

  app.post(
    '/sessions/:id/cancel',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const cancelled = await rust.cancel(id);
      reply.send(okEnvelope({ cancelled }, req.id));
    },
  );

  app.get(
    '/sessions/:id/approvals',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const result = await rust.approvalList(id);
      reply.send(okEnvelope(result, req.id));
    },
  );

  app.post(
    '/sessions/:id/approvals/resolve',
    { schema: { body: resolveApprovalSchema } },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const body = resolveApprovalSchema.safeParse(req.body ?? {});
      if (!body.success) {
        reply.send(zodValidationEnvelope(body.error, req.id));
        return;
      }
      const result = await rust.approvalResolve(id, body.data);
      reply.send(okEnvelope(result, req.id));
    },
  );
}
