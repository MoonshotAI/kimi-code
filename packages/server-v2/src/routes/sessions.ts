/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title (partial)
 *   POST   /sessions/{tail}                    action: fork / compact / undo /
 *                                              abort / btw / archive
 *   GET    /sessions/{session_id}/children     list child sessions
 *   POST   /sessions/{session_id}/children     create child session (fork+tag)
 *   GET    /sessions/{session_id}/status       best-effort
 *   GET    /sessions/{session_id}/warnings     empty (no warning sources ported)
 *
 * The `POST /sessions/{tail}` actions and the `/sessions/{id}/children`
 * endpoints are dispatched to `ISessionLegacyService` (a v1 edge adapter over
 * the native v2 services); `archive` stays on the native
 * `ISessionLifecycleService`. `create`, `fork`, and child creation publish
 * `event.session.created` on the core event bus, matching v1.
 *
 * `GET /sessions/{id}/warnings` returns `{ warnings: [] }`: the only v1 warning
 * (`agents-md-oversized`) is computed by `prepareSystemPromptContext`, which is
 * not ported to v2 yet. This is within v1's observable behaviour — it falls back
 * to `[]` whenever the underlying computation throws.
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`packages/agent-core/src/services/session/session.ts`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`, hardcoded `status:'idle'`). v2 produces the
 * same placeholder shape from `ISessionIndex` + `IWorkspaceRegistry`, and now
 * also surfaces `last_prompt` and the merged custom `metadata`.
 *
 * **cwd resolution (gap G3)**: v2 does not store the original work dir on the
 * session; we recover `metadata.cwd` from `IWorkspaceRegistry`
 * (`workspaceId → root`). Sessions whose workspace is not registered cannot be
 * represented and are filtered from list / 404 on get.
 */

import {
  ISessionActivity,
  ISessionContext,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionLegacyService,
  IEventService,
  IWorkspaceRegistry,
  isKimiError,
  KimiError,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  emptySessionUsage,
  forkSessionRequestSchema,
  listSessionChildrenResponseSchema,
  pageResponseSchema,
  sessionAbortResponseSchema,
  sessionSchema,
  sessionStatusResponseSchema,
  sessionStatusSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
} from '@moonshot-ai/protocol';
import type { Session } from '@moonshot-ai/protocol';
import { ulid } from 'ulid';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { parseActionSuffix } from './action-suffix';
import { toProtocolMessage } from './_messageProjection';

interface SessionRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown; headers: Record<string, unknown> },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const booleanQueryParam = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === 1 || value === true) return true;
  if (value === 'false' || value === '0' || value === 0 || value === false) return false;
  return value;
}, z.boolean().optional());

// NOTE: `status` filtering and the `before_id`/`after_id` id-cursors are
// accepted for wire compatibility but not applied — `ISessionIndex` does not
// support them (gap G5). `page_size` maps to `limit`; `include_archive` maps
// to `includeArchived`; `workspace_id` maps to `workspaceId`.
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
    include_archive: booleanQueryParam,
    workspace_id: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// Mirrors v1's children query: id-cursors + page_size + status. `status` is
// accepted for wire compatibility but not applied by `ISessionLegacyService`
// (the wire projection reports a hardcoded 'idle'; see gap G10 / G5).
const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    status: sessionStatusSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_id !== undefined && value.after_id !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_id and after_id are mutually exclusive',
        path: ['before_id'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionActionTailParamSchema = z.object({
  tail: z.string().min(1),
});

/**
 * Combined body schema for `POST /sessions/{tail}`. Each action parses its own
 * fields from this superset (mirrors v1's `sessionActionRequestSchema`, which is
 * also a server-side superset — the per-action wire schemas live in protocol).
 */
const sessionActionRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),
  z.object({
    title: z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    instruction: z.string().optional(),
    count: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
);

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

export function registerSessionsRoutes(app: SessionRouteHost, core: Scope): void {
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions',
      body: createSessionRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Create a new session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const body = req.body;
      const callerCwd = typeof body.metadata?.cwd === 'string' ? body.metadata.cwd : undefined;
      const workspaceId = body.workspace_id;
      if (workspaceId === undefined && callerCwd === undefined) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'metadata.cwd', message: 'either workspace_id or metadata.cwd is required' }],
            req.id,
          ),
        );
        return;
      }

      const registry = core.accessor.get(IWorkspaceRegistry);
      let workDir: string;
      if (workspaceId !== undefined) {
        const workspace = await registry.get(workspaceId);
        if (workspace === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspaceId} does not exist`,
              req.id,
            ),
          );
          return;
        }
        if (callerCwd !== undefined && callerCwd !== workspace.root) {
          reply.send(
            buildValidationEnvelope(
              [
                {
                  path: 'metadata.cwd',
                  message: `metadata.cwd (${callerCwd}) must equal workspace root (${workspace.root})`,
                },
              ],
              req.id,
            ),
          );
          return;
        }
        workDir = workspace.root;
      } else {
        workDir = callerCwd as string;
      }

      // Ensure the workspace is registered so `metadata.cwd` is resolvable on
      // read (gap G3 — v2 does not store workDir on the session).
      const touched = await registry.createOrTouch(workDir);

      const handle = await core.accessor.get(ISessionLifecycleService).create({
        sessionId: ulid(),
        workDir,
      });
      if (typeof body.title === 'string') {
        await handle.accessor.get(ISessionMetadata).setTitle(body.title);
      }
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const session = toWireSession({ ...meta, workspaceId: touched.id }, touched.root);
      core.accessor.get(IEventService).publish({
        type: 'event.session.created',
        payload: { agentId: 'main', sessionId: session.id, session },
      });
      reply.send(okEnvelope(session, req.id));
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions',
      querystring: sessionsListQueryCoercion,
      success: { data: pageResponseSchema(sessionSchema) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const limit = raw.page_size;
      const page = await core.accessor.get(ISessionIndex).list({
        workspaceId: raw.workspace_id,
        includeArchived: raw.include_archive,
        // Fetch one extra to detect `has_more` (FileSessionIndex does not
        // expose a cursor today).
        limit: limit !== undefined ? limit + 1 : undefined,
      });

      let hasMore = false;
      let summaries = page.items;
      if (limit !== undefined && summaries.length > limit) {
        summaries = summaries.slice(0, limit);
        hasMore = true;
      }

      const workspaces = await core.accessor.get(IWorkspaceRegistry).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));
      const items: Session[] = [];
      for (const summary of summaries) {
        const cwd = roots.get(summary.workspaceId);
        if (cwd === undefined) continue; // gap G3: cannot represent cwd
        items.push(toWireSession(summary, cwd));
      }
      reply.send(okEnvelope({ items, has_more: hasMore }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get a session by ID',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(summary.workspaceId);
      if (workspace === undefined) {
        // gap G3: persisted session whose workspace is not registered → cwd
        // cannot be recovered.
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession(summary, workspace.root), req.id));
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const getProfileRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session profile',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(summary.workspaceId);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession(summary, workspace.root), req.id));
    },
  );
  app.get(
    getProfileRoute.path,
    getProfileRoute.options,
    getProfileRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const updateProfileRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/profile',
      params: sessionIdParamSchema,
      body: updateSessionProfileRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Update session profile (title only in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const title = req.body.title;
      if (typeof title === 'string') {
        await handle.accessor.get(ISessionMetadata).setTitle(title);
      }
      const meta = await handle.accessor.get(ISessionMetadata).read();
      const workspaceId = handle.accessor.get(ISessionContext).workspaceId;
      const workspace = await core.accessor.get(IWorkspaceRegistry).get(workspaceId);
      if (workspace === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} workspace missing`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope(toWireSession({ ...meta, workspaceId }, workspace.root), req.id));
    },
  );
  app.post(
    updateProfileRoute.path,
    updateProfileRoute.options,
    updateProfileRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const sessionActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{tail}',
      params: sessionActionTailParamSchema,
      body: sessionActionRequestSchema,
      success: {
        data: z.union([
          sessionSchema,
          compactSessionResponseSchema,
          undoSessionResponseSchema,
          sessionAbortResponseSchema,
          startBtwSessionResponseSchema,
          archiveSessionResponseSchema,
        ]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
        [ErrorCode.COMPACTION_UNABLE]: {},
        [ErrorCode.SESSION_UNDO_UNAVAILABLE]: {},
        [ErrorCode.AUTH_TOKEN_MISSING]: {},
      },
      description: 'Run a session action',
      tags: ['sessions'],
      operationId: 'runSessionAction',
    },
    async (req, reply) => {
      try {
        const { tail } = req.params;
        const parsed = parseActionSuffix({
          tail,
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive'] as const,
          resourceLabel: 'session',
        });
        if (parsed.kind !== 'action') {
          const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`;
          reply.send(buildValidationEnvelope([{ path: 'session_id', message }], req.id));
          return;
        }

        const legacy = core.accessor.get(ISessionLegacyService);

        if (parsed.action === 'fork') {
          const body = forkSessionRequestSchema.parse(req.body);
          const fields = await legacy.fork(parsed.id, body);
          const session = toWireSession(fields, fields.root);
          core.accessor.get(IEventService).publish({
            type: 'event.session.created',
            payload: { agentId: 'main', sessionId: session.id, session },
          });
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const result = await legacy.compact(parsed.id, body);
          reply.send(okEnvelope(result, req.id));
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          const { history, status } = await legacy.undo(parsed.id, body);
          const pageSize = Math.min(Math.max(body.page_size ?? 50, 1), 100);
          const summary = await core.accessor.get(ISessionIndex).get(parsed.id);
          const createdAt = summary?.createdAt ?? 0;
          const all = history.map((msg, index) => toProtocolMessage(parsed.id, index, msg, createdAt));
          const desc = [...all].reverse();
          reply.send(
            okEnvelope(
              {
                messages: { items: desc.slice(0, pageSize), has_more: desc.length > pageSize },
                status,
              },
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'abort') {
          const result = await legacy.abort(parsed.id);
          reply.send(okEnvelope(result, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          const result = await legacy.startBtw(parsed.id);
          reply.send(okEnvelope(result, req.id));
          return;
        }

        // archive
        const handle = core.accessor.get(ISessionLifecycleService).get(parsed.id);
        if (handle === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`, req.id),
          );
          return;
        }
        await core.accessor.get(ISessionLifecycleService).archive(parsed.id);
        reply.send(okEnvelope({ archived: true as const }, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    sessionActionRoute.path,
    sessionActionRoute.options,
    sessionActionRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const listChildrenRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      querystring: sessionChildrenListQueryCoercion,
      success: { data: listSessionChildrenResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List child sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const page = await core.accessor.get(ISessionLegacyService).listChildren(session_id, req.query);
        reply.send(
          okEnvelope(
            {
              items: page.items.map((fields) => toWireSession(fields, fields.root)),
              has_more: page.has_more,
            },
            req.id,
          ),
        );
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.get(
    listChildrenRoute.path,
    listChildrenRoute.options,
    listChildrenRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const createChildRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/children',
      params: sessionIdParamSchema,
      body: createSessionChildRequestSchema,
      success: { data: sessionSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Create a child session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const fields = await core
          .accessor.get(ISessionLegacyService)
          .createChild(session_id, req.body);
        const session = toWireSession(fields, fields.root);
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: { agentId: 'main', sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    createChildRoute.path,
    createChildRoute.options,
    createChildRoute.handler as Parameters<SessionRouteHost['post']>[2],
  );

  const statusRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/status',
      params: sessionIdParamSchema,
      success: { data: sessionStatusResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get realtime session status (best-effort in this slice)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const handle = core.accessor.get(ISessionLifecycleService).get(session_id);
      if (handle === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      const status = handle.accessor.get(ISessionActivity).status();
      // Rich fields (model / thinking_level / permission / plan_mode /
      // swarm_mode / context_*) require the main agent's scope; not wired yet
      // (gap G10). Return safe defaults for the first slice.
      reply.send(
        okEnvelope(
          {
            status,
            thinking_level: '',
            permission: '',
            plan_mode: false,
            swarm_mode: false,
            context_tokens: 0,
            max_context_tokens: 0,
            context_usage: 0,
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const sessionWarningsRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/warnings',
      params: sessionIdParamSchema,
      success: { data: sessionWarningsResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get session-level warnings (e.g. oversized AGENTS.md)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const summary = await core.accessor.get(ISessionIndex).get(session_id);
      if (summary === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      // No warning sources are ported to v2 yet (the v1 `agents-md-oversized`
      // detection lives in `prepareSystemPromptContext`, which is not wired
      // here). Return an empty list — within v1's own observable behaviour,
      // since it falls back to `[]` whenever the underlying computation throws.
      reply.send(okEnvelope({ warnings: [] }, req.id));
    },
  );
  app.get(
    sessionWarningsRoute.path,
    sessionWarningsRoute.options,
    sessionWarningsRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// API body wrapper — pure field projection from a service return value to the
// wire `Session` shape. No service calls, no control flow: handlers pull data
// through `ServiceAccessor.get` and pass it straight here.
// ---------------------------------------------------------------------------

export interface SessionWireFields {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export function toWireSession(fields: SessionWireFields, cwd: string): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    status: 'idle',
    archived: fields.archived,
    last_prompt: fields.lastPrompt,
    metadata: buildWireMetadata(fields.custom, cwd),
    agent_config: { model: '' },
    usage: emptySessionUsage(),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

/**
 * Build the wire `Session.metadata`: caller-supplied custom fields (minus the
 * reserved `goal` key, matching v1's `toProtocolSession`) overlaid with the
 * required `cwd`. `cwd` always wins so the resolved work dir is authoritative.
 */
function buildWireMetadata(
  custom: Record<string, unknown> | undefined,
  cwd: string,
): { cwd: string; [key: string]: unknown } {
  if (custom === undefined) return { cwd };
  const { goal: _drop, ...rest } = custom as { goal?: unknown; [key: string]: unknown };
  return { ...rest, cwd };
}

function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (isKimiError(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
        return;
      case 'session.fork_active_turn':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId));
        return;
      case 'compaction.unable':
        reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId));
        return;
      case 'session.undo_unavailable':
        reply.send(errEnvelope(ErrorCode.SESSION_UNDO_UNAVAILABLE, err.message, requestId));
        return;
      case 'auth.login_required':
        reply.send(errEnvelope(ErrorCode.AUTH_TOKEN_MISSING, err.message, requestId));
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
        return;
    }
  }
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
    ),
  );
}
