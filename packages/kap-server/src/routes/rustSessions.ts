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
import type { RustSessionService, RustWebSession } from '../services/rustSession/rustSessionService';

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

/** Map a session-proxy failure to the v1 error envelope (404 for unknown
 *  sessions, 500 otherwise). */
function sessionError(error: unknown, sessionId: string, requestId: string) {
  const message = error instanceof Error ? error.message : String(error);
  return errEnvelope(
    message.includes('no session')
      ? ErrorCode.SESSION_NOT_FOUND
      : ErrorCode.INTERNAL_ERROR,
    message,
    requestId,
  );
}

/** Project a live engine session onto the v1 session summary shape (the same
 *  object POST /sessions returns). Busy facts ride the projected events. */
function toSessionSummary(session: RustWebSession): Record<string, unknown> {
  return {
    id: session.id,
    workspace_id: '',
    title: session.title,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    busy: session.busy,
    main_turn_active: session.busy,
    pending_interaction: 'none',
    archived: false,
    last_prompt: null,
    metadata: { cwd: session.workDir },
    agent_config: { model: '' },
    usage: { by_model: {}, total: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

/** One pending tool approval as returned by the engine `session/approval_list`
 *  RPC (see `packages/kimi-agent/rust-loop.ts` EngineApprovalEntry). */
export interface EngineApprovalEntry {
  id: string;
  session_id?: string | null;
  tool_call_id: string;
  tool_name: string;
  arguments: unknown;
  approval_rule: string;
  created_at_ms: number;
}

/** Project an engine approval entry onto the v1 approval request wire shape.
 *  `expires_at` is a stable derived value (created_at + 24h) because the v1
 *  wire schema requires it and engine approvals never expire. */
function toWireApproval(entry: EngineApprovalEntry): Record<string, unknown> {
  const createdAt = new Date(entry.created_at_ms);
  const expiresAt = new Date(entry.created_at_ms + 24 * 60 * 60 * 1000);
  return {
    approval_id: entry.id,
    session_id: entry.session_id ?? '',
    tool_call_id: entry.tool_call_id,
    tool_name: entry.tool_name,
    action: entry.approval_rule,
    tool_input_display: entry.arguments,
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
}

const createSessionSchema = z.object({
  title: z.string().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const promptSchema = z.object({
  prompt: z.string().min(1),
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
        typeof metadata['cwd'] === 'string' ? metadata['cwd'] : undefined;
      // v1 semantics: a session is created against an explicit cwd. No cwd →
      // 40001; a cwd that does not exist or is not a directory → 40409.
      if (workDir === undefined) {
        reply.send({
          code: ErrorCode.VALIDATION_FAILED,
          msg: 'metadata.cwd is required',
          data: null,
          request_id: req.id,
          details: [{ path: 'metadata.cwd', message: 'required' }],
        });
        return;
      }
      let cwdStat;
      try {
        cwdStat = await import('node:fs/promises').then((fs) => fs.stat(workDir));
      } catch {
        cwdStat = undefined;
      }
      if (cwdStat === undefined || !cwdStat.isDirectory()) {
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `cwd does not exist: ${workDir}`, req.id),
        );
        return;
      }
      const sessionId = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const session = await rust.createSession({
        sessionId,
        workDir,
        title: body.data.title,
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
      if (rust.getSession(id) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id));
        return;
      }
      const result = (await rust.approvalList(id)) as
        | { pending: EngineApprovalEntry[] }
        | null
        | undefined;
      reply.send(okEnvelope({ items: (result?.pending ?? []).map(toWireApproval) }, req.id));
    },
  );

  // ── Session detail routes (stage 1a: engine snapshots → v1 wire) ────────
  // Previously skipped in Rust mode, leaving status/goal/warnings empty.

  app.get(
    '/sessions',
    { schema: {} },
    async (req: any, reply: any) => {
      const items = rust.listSessions().map(toSessionSummary);
      reply.send(okEnvelope({ items, has_more: false }, req.id));
    },
  );

  // GET /sessions/:id — session detail (stage 1e remainder). The web UI
  // opens a session by id; the v2 detail route is skipped in Rust mode.
  app.get(
    '/sessions/:id',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      const session = rust.getSession(id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id),
        );
        return;
      }
      reply.send(okEnvelope(toSessionSummary(session), req.id));
    },
  );

  app.get(
    '/sessions/:id/status',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      try {
        const result = await rust.getStatus(id);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        reply.send(sessionError(error, id, req.id));
      }
    },
  );

  app.get(
    '/sessions/:id/goal',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      try {
        const result = await rust.goalGet(id);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        reply.send(sessionError(error, id, req.id));
      }
    },
  );

  app.get(
    '/sessions/:id/warnings',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      try {
        const result = await rust.getWarnings(id);
        reply.send(okEnvelope(result, req.id));
      } catch (error) {
        reply.send(sessionError(error, id, req.id));
      }
    },
  );

  // ── Message history (stage 1d: accumulated engine events → v1 wire) ──────
  // Previously skipped in Rust mode; the web UI's message list was empty.

  app.get(
    '/sessions/:id/messages',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      if (rust.getSession(id) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id));
        return;
      }
      const items = rust.getMessages(id).map((m) => ({
        id: m.id,
        session_id: id,
        role: m.role,
        content: m.content,
        created_at: m.created_at,
      }));
      reply.send(okEnvelope({ items, has_more: false }, req.id));
    },
  );

  // ── Background-task roster (engine `task/list` → v1 wire) ─────────────────
  // The engine's `task/list` is process-wide; the v1 endpoint is per-session,
  // so we gate on session existence and project each engine task onto the v1
  // `Task` shape (kind/status literal remap, epoch-ms → ISO timestamps).
  const TASK_KIND_REMAP: Record<string, 'subagent' | 'bash' | 'tool'> = {
    agent: 'subagent',
    process: 'bash',
    question: 'tool',
  };
  const TASK_STATUS_REMAP: Record<string, 'running' | 'completed' | 'failed' | 'cancelled'> = {
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    timed_out: 'failed',
    killed: 'cancelled',
    lost: 'failed',
  };
  app.get(
    '/sessions/:id/tasks',
    { schema: {} },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      if (rust.getSession(id) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id));
        return;
      }
      const tasks = (await rust.taskList(id)) as
        | Array<{
            task_id: string;
            description: string;
            status: string;
            kind: string;
            started_at: number;
            ended_at?: number | null;
            [key: string]: unknown;
          }>
        | null
        | undefined;
      const items = (tasks ?? []).map((t) => {
        const startedAt = new Date(t.started_at).toISOString();
        return {
          id: t.task_id,
          session_id: id,
          kind: TASK_KIND_REMAP[t.kind] ?? 'tool',
          description: t.description,
          status: TASK_STATUS_REMAP[t.status] ?? 'failed',
          created_at: startedAt,
          started_at: startedAt,
          completed_at:
            typeof t.ended_at === 'number' ? new Date(t.ended_at).toISOString() : undefined,
        };
      });
      reply.send(okEnvelope({ items, has_more: false }, req.id));
    },
  );

  app.post(
    '/sessions/:id/approvals/resolve',
    { schema: { body: resolveApprovalSchema } },
    async (req: any, reply: any) => {
      const { id } = req.params as { id: string };
      if (rust.getSession(id) === undefined) {
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${id} not found`, req.id));
        return;
      }
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
