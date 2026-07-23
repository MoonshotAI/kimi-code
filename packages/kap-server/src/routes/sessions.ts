/**
 * `/sessions` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions` wire contract on top of
 * `agent-core-v2` services:
 *   POST   /sessions                  create
 *   GET    /sessions                  list
 *   GET    /sessions/{session_id}     get
 *   GET    /sessions/{session_id}/profile
 *   POST   /sessions/{session_id}/profile      update title / metadata / agent_config
 *   POST   /sessions/{tail}                    action: fork / compact / undo /
 *                                              abort / btw / archive / restore
 *   GET    /sessions/{session_id}/children     list child sessions
 *   POST   /sessions/{session_id}/children     create child session (fork+tag)
 *   GET    /sessions/{session_id}/status       best-effort
 *   GET    /sessions/{session_id}/goal         current goal (null when none)
 *   GET    /sessions/{session_id}/warnings     agents-md-oversized notice
 *
 * The `POST /sessions/{tail}` actions split into two groups. The thin
 * pass-throughs — `fork` / `compact` / `abort` / `archive` / `restore` — call
 * the native v2 services directly (`ISessionLifecycleService.fork` / `archive` / `restore`,
 * `IAgentFullCompactionService.begin`, `IAgentRPCService.cancel`); there is no
 * v1-only projection to centralize, so no adapter is involved. `undo` likewise
 * calls `IAgentPromptService.undo` directly (it now throws
 * `session.undo_unavailable` with a structured reason) and only borrows
 * `ISessionLegacyService.status` for the cross-domain status rollup. The
 * `/sessions/{id}/children` endpoints call `ISessionLifecycleService.createChild`
 * and `ISessionIndex.list({ childOf })` directly — the child markers and
 * parent-title default live in the lifecycle, and the child filter lives in the
 * index. Only `POST /sessions/{id}/profile` (`updateProfile`),
 * `GET /sessions/{id}/status`, and `GET /sessions/{id}/goal` go through
 * `ISessionLegacyService` (the `agent_config` patch, the status rollup, and the
 * current-goal read hold real cross-domain adaptation);
 * the route forwards each adapter result verbatim, mirroring v1's thin handler.
 * `create`, `fork`, and child creation publish `event.session.created` on the
 * core event bus, matching v1.
 *
 * `GET /sessions/{id}/warnings` surfaces the only v1 warning
 * (`agents-md-oversized`) by projecting the main agent's
 * `IAgentProfileService.getAgentsMdWarning()` — computed and cached when the
 * agent binds a profile (via `prepareSystemPromptContext`) — into the v1
 * `{ code, message, severity }` wire shape. An unbound main agent yields an
 * empty list, matching v1's "no warning" case.
 *
 * **Wire fidelity**: mirrors v1's `toProtocolSession`
 * (`packages/agent-core/src/services/session/session.ts`), which populates
 * only the index/metadata fields and returns placeholders for the heavy ones
 * (`agent_config:{model:''}`, `usage:zeros`, `permission_rules:[]`,
 * `message_count:0`, `last_seq:0`). v2 produces the same placeholder shape
 * from `ISessionIndex` (with `cwd` persisted on the session itself), and now
 * also surfaces `last_prompt` and the merged custom `metadata`.
 *
 * **Busy / last turn**: v1's `SessionService` overwrites the placeholder
 * `status` with the live value before projecting (`_patchSessionStatus`). v2
 * projects the orthogonal facts instead: `toWireSession` takes
 * `resolveSessionFacts` — `busy` from the session lifecycle's authoritative
 * drain registry and `last_turn_reason` from the main agent's activity view (a
 * cold session is not busy and carries no reason) — so both are real on every
 * session-producing endpoint here. `GET /sessions` and
 * `GET /sessions/{id}/children` filter their projected page by the `busy`
 * query param (post-page, matching v1 — `has_more` reflects the pre-filter
 * page), except `archived_only` lists filter busy before route pagination so
 * they can drain archived pages the same way v1 does.
 *
 * **cwd resolution (gap G3 closed)**: the session's frozen work dir is
 * persisted on its metadata document (`ISessionMetadata`) and surfaced on the
 * `ISessionIndex` summary, so `metadata.cwd` comes from the session itself —
 * not from `IWorkspaceService`. Sessions whose workspace was unregistered keep
 * their original cwd and stay listed / gettable (matching v1, which stores
 * `workDir` on the session). `IWorkspaceService` is consulted only as a
 * back-compat fallback for sessions written before `cwd` was persisted.
 */

import {
  ErrorCodes,
  IAgentContextMemoryService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentFullCompactionService,
  IAgentLifecycleService,
  IAgentRPCService,
  IAgentActivityView,
  IAuthSummaryService,
  ISessionBtwService,
  ISessionContext,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionLegacyService,
  IEventService,
  IWorkspaceAliases,
  IWorkspaceService,
  isError2,
  Error2,
  toProtocolMessage,
  type ContextMessage,
  type IAgentScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { ErrorCode } from '../protocol/error-codes';
import { pageResponseSchema } from '../protocol/pagination';
import {
  archiveSessionResponseSchema,
  compactSessionRequestSchema,
  compactSessionResponseSchema,
  createSessionChildRequestSchema,
  createSessionRequestSchema,
  forkSessionRequestSchema,
  getSessionGoalResponseSchema,
  listSessionChildrenResponseSchema,
  sessionAbortResponseSchema,
  sessionStatusResponseSchema,
  sessionWarningsResponseSchema,
  startBtwSessionResponseSchema,
  undoSessionRequestSchema,
  undoSessionResponseSchema,
  updateSessionProfileRequestSchema,
} from '../protocol/rest-session';
import {
  emptySessionUsage,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
} from '../protocol/session';
import { workspaceIdSchema } from '../protocol/workspace';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent, MAIN_AGENT_ID } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

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

const DEFAULT_SESSION_LIST_PAGE_SIZE = 20;

// NOTE: mirrors v1's `GET /sessions` query. `before_id`/`after_id` id-cursors
// and `page_size` ARE applied in the route handler (the `FileSessionIndex` does
// not implement `cursor`, so we page over its recency-sorted result); `status`
// filters the projected page (post-page, matching v1). `include_archive` →
// `includeArchived`; `archived_only` forces `includeArchived` and then keeps
// only archived sessions; `workspace_id` → `workspaceIds` after
// `resolveAliasIds` expands the alias set of the directory (legacy split
// buckets list as one workspace); `exclude_empty` drops sessions with no
// prompt.
const sessionsListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
    include_archive: booleanQueryParam,
    exclude_empty: booleanQueryParam,
    archived_only: booleanQueryParam,
    workspace_id: workspaceIdSchema.optional(),
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
    if (value.archived_only === true && value.include_archive === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'archived_only and include_archive are mutually exclusive',
        path: ['archived_only'],
        params: { code: ErrorCode.VALIDATION_FAILED },
      });
    }
  });

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

// Mirrors v1's children query: id-cursors + page_size + busy. The route
// projects the live busy fact onto each child and filters the page by it
// (post-page, matching v1); the child-marker filtering lives in
// `ISessionIndex.list({ childOf })`, the busy filter stays at the edge.
const sessionChildrenListQueryCoercion = z
  .object({
    before_id: z.string().min(1).optional(),
    after_id: z.string().min(1).optional(),
    page_size: z.coerce.number().int().min(1).max(100).optional(),
    busy: booleanQueryParam,
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
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
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

      const registry = core.accessor.get(IWorkspaceService);
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
      try {
        const touched = await registry.createOrTouch(workDir);

        const handle = await core.accessor.get(ISessionLifecycleService).create({
          workDir,
        });
        if (typeof body.title === 'string') {
          await handle.accessor.get(ISessionMetadata).setTitle(body.title);
        }
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const session = toWireSession(
          { ...meta, workspaceId: touched.id },
          touched.root,
          { busy: false, mainTurnActive: false, pendingInteraction: 'none' },
        );
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: { agentId: 'main', sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
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
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'List sessions',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const raw = req.query;
      const pageSize = raw.page_size;
      const archivedOnly = raw.archived_only === true;

      const workspaces = await core.accessor.get(IWorkspaceService).list();
      const roots = new Map(workspaces.map((w) => [w.id, w.root]));

      // v1 resolves `workspace_id` to its root and 40410s when it is unknown;
      // the existence check stays on the listed (root-deduped) registry so an
      // unknown id fails byte-identically, and only then is a known id
      // expanded to every id spelling of the same directory — legacy split
      // buckets (casing/slash variants) list as one workspace.
      if (raw.workspace_id !== undefined && !roots.has(raw.workspace_id)) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${raw.workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }

      // `FileSessionIndex` does not implement `cursor` (gap G5 closed here), so
      // we fetch the full recency-sorted set (no `limit`) and apply the id
      // cursor in this handler. `list()` already orders by `updatedAt` desc and
      // filters across the workspace-id set / archived. `archived_only` forces
      // archived rows into the set, then the filter below keeps only them.
      const workspaceIds =
        raw.workspace_id === undefined
          ? undefined
          : await core.accessor.get(IWorkspaceAliases).resolveAliasIds(raw.workspace_id);
      const page = await core.accessor.get(ISessionIndex).list({
        workspaceIds,
        includeArchived: archivedOnly ? true : raw.include_archive,
      });

      // Filter down to the sequence the client can page over BEFORE computing
      // the cursor position. `cwd` is read from the session's own summary first
      // (gap G3 closed — an unregistered workspace no longer drops the session);
      // the registry `roots` map is only a back-compat fallback for sessions
      // written before `cwd` was persisted. A session with no recoverable cwd is
      // still skipped.
      const eligible: {
        readonly summary: (typeof page.items)[number];
        readonly cwd: string;
        readonly facts?: SessionFacts;
      }[] = [];
      for (const summary of page.items) {
        const cwd = summary.cwd ?? roots.get(summary.workspaceId);
        if (cwd === undefined) continue;
        if (raw.exclude_empty === true && (summary.lastPrompt ?? '').length === 0) continue;
        eligible.push({ summary, cwd });
      }

      // `before_id` = strictly older than this id (forward / default paging);
      // `after_id` = strictly newer. An unknown cursor resolves to an empty,
      // terminal page (`has_more: false`) so a client cannot spin on a cursor
      // the server cannot advance (this was the boot-time request storm).
      let start = 0;
      let end = eligible.length;
      const cursorId = raw.before_id ?? raw.after_id;
      if (cursorId !== undefined) {
        const idx = eligible.findIndex((e) => e.summary.id === cursorId);
        if (idx === -1) {
          reply.send(okEnvelope({ items: [], has_more: false }, req.id));
          return;
        }
        if (raw.before_id !== undefined) start = idx + 1;
        else end = idx;
      }

      const window = eligible.slice(start, end);
      let visible = window;
      if (archivedOnly) {
        visible =
          raw.busy === undefined
            ? window.filter((entry) => entry.summary.archived === true)
            : window.flatMap((entry) => {
                if (entry.summary.archived !== true) return [];
                const facts = resolveSessionFacts(core, entry.summary.id);
                return facts.busy === raw.busy ? [{ ...entry, facts }] : [];
              });
      }
      const limit = archivedOnly
        ? (pageSize ?? DEFAULT_SESSION_LIST_PAGE_SIZE)
        : (pageSize ?? visible.length);
      const hasMore = visible.length > limit;
      const projected: Session[] = visible
        .slice(0, limit)
        .map(({ summary, cwd, facts }) =>
          toWireSession(summary, cwd, facts ?? resolveSessionFacts(core, summary.id)),
        );
      // v1 filters ordinary lists by the busy fact post-page; `archived_only`
      // already applied it before pagination above so it can drain to a full page.
      const items =
        raw.busy !== undefined && !archivedOnly
          ? projected.filter((session) => session.busy === raw.busy)
          : projected;
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
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        // Persisted session with no `cwd` on disk and no registered workspace
        // to fall back to (predates gap-G3 persistence) — cannot project cwd.
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
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
      const cwd =
        summary.cwd ?? (await core.accessor.get(IWorkspaceService).get(summary.workspaceId))?.root;
      if (cwd === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.SESSION_NOT_FOUND,
            `session ${session_id} has no recoverable cwd`,
            req.id,
          ),
        );
        return;
      }
      reply.send(
        okEnvelope(toWireSession(summary, cwd, resolveSessionFacts(core, session_id)), req.id),
      );
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
      description: 'Update session profile (title, metadata, agent_config)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const fields = await core.accessor
          .get(ISessionLegacyService)
          .updateProfile(session_id, req.body);
        const session = toWireSession(fields, fields.root, resolveSessionFacts(core, fields.id));
        // Broadcast the title change to every connection (including clients not
        // subscribed to this session, and covering inactive sessions), so session
        // lists stay in sync — mirrors v1's `session.meta.updated` publish.
        if (typeof req.body.title === 'string' && req.body.title.trim().length > 0) {
          core.accessor.get(IEventService).publish({
            type: 'session.meta.updated',
            payload: {
              agentId: 'main',
              sessionId: session_id,
              title: session.title,
              patch: { title: session.title, isCustomTitle: true },
            },
          });
        }
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
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
          allowedActions: ['fork', 'compact', 'undo', 'abort', 'btw', 'archive', 'restore'] as const,
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
          // `lifecycle.fork` throws `session.not_found` for an unknown source,
          // so no explicit existence check is needed here.
          const handle = await core.accessor.get(ISessionLifecycleService).fork({
            sourceSessionId: parsed.id,
            title: body.title,
            metadata: body.metadata,
          });
          const meta = await handle.accessor.get(ISessionMetadata).read();
          const ctx = handle.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          core.accessor.get(IEventService).publish({
            type: 'event.session.created',
            payload: { agentId: 'main', sessionId: session.id, session },
          });
          requestLog(req)?.info(
            { session_id: parsed.id, action: 'fork', new_session_id: session.id },
            'session action completed',
          );
          reply.send(okEnvelope(session, req.id));
          return;
        }

        if (parsed.action === 'compact') {
          const body = compactSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          // `begin` returns false when busy / over the per-turn limit — v1
          // treats that as a silent success. It throws `compaction.unable`
          // when there is no compactable prefix, which propagates.
          agent.accessor
            .get(IAgentFullCompactionService)
            .begin({ source: 'manual', instruction: normalizeOptional(body.instruction) });
          requestLog(req)?.info({ session_id: parsed.id, action: 'compact' }, 'session action completed');
          reply.send(okEnvelope({}, req.id));
          return;
        }

        if (parsed.action === 'undo') {
          const body = undoSessionRequestSchema.parse(req.body);
          const agent = await resolveMainAgent(core, parsed.id);
          // `prompt.undo` throws `session.undo_unavailable` (with a structured
          // `reason`) when the history cannot satisfy `count`; it is a no-op
          // until the precheck passes, so the post-undo read below always sees
          // the cut applied. The status rollup stays in the legacy adapter
          // (cross-domain) and is reused here verbatim.
          agent.accessor.get(IAgentPromptService).undo(body.count);
          const history = agent.accessor.get(IAgentContextMemoryService).get();
          requestLog(req)?.info({ session_id: parsed.id, action: 'undo' }, 'session action completed');
          const [summary, status] = await Promise.all([
            core.accessor.get(ISessionIndex).get(parsed.id),
            legacy.status(parsed.id),
          ]);
          reply.send(
            okEnvelope(
              {
                messages: pageUndoMessages(
                  parsed.id,
                  summary?.createdAt ?? 0,
                  history,
                  body.page_size,
                ),
                status,
              },
              req.id,
            ),
          );
          return;
        }

        if (parsed.action === 'abort') {
          const agent = await resolveMainAgent(core, parsed.id);
          // No turnId → cancel whatever turn is active; a safe no-op when idle.
          // v1 always reports success once the session exists.
          await agent.accessor.get(IAgentRPCService).cancel({});
          requestLog(req)?.info({ session_id: parsed.id, action: 'abort' }, 'session action completed');
          reply.send(okEnvelope({ aborted: true }, req.id));
          return;
        }

        if (parsed.action === 'btw') {
          // `resume` (not `get`) so a freshly-opened cold session can start a
          // side-channel agent; matches v1's `startBtw` which resumes first.
          const session = await core.accessor.get(ISessionLifecycleService).resume(parsed.id);
          if (session === undefined) {
            throw new Error2(
              ErrorCodes.SESSION_NOT_FOUND,
              `session ${parsed.id} does not exist`,
            );
          }
          await core.accessor.get(IAuthSummaryService).ensureReady();
          const agentId = await session.accessor.get(ISessionBtwService).start();
          reply.send(okEnvelope({ agent_id: agentId }, req.id));
          return;
        }

        if (parsed.action === 'restore') {
          const restored = await core.accessor.get(ISessionLifecycleService).restore(parsed.id);
          if (restored === undefined) {
            throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
          }
          const meta = await restored.accessor.get(ISessionMetadata).read();
          const ctx = restored.accessor.get(ISessionContext);
          const session = toWireSession(
            { ...meta, workspaceId: ctx.workspaceId },
            ctx.cwd,
            resolveSessionFacts(core, meta.id),
          );
          requestLog(req)?.info({ session_id: parsed.id, action: 'restore' }, 'session action completed');
          reply.send(okEnvelope(session, req.id));
          return;
        }

        // archive — `resume` (not `get`) so archiving a freshly-opened cold
        // session still works; `resume` returns undefined only when the session
        // is unknown or its workspace is gone, reported as `session.not_found`.
        const archived = await core.accessor.get(ISessionLifecycleService).resume(parsed.id);
        if (archived === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`);
        }
        await core.accessor.get(ISessionLifecycleService).archive(parsed.id);
        requestLog(req)?.info({ session_id: parsed.id, action: 'archive' }, 'session action completed');
        reply.send(okEnvelope({ archived: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
        // 404 when the parent is unknown — the live handle wins, otherwise the
        // persisted index (a closed parent can still list children, like v1).
        const exists =
          core.accessor.get(ISessionLifecycleService).get(session_id) !== undefined ||
          (await core.accessor.get(ISessionIndex).get(session_id)) !== undefined;
        if (!exists) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${session_id} does not exist`);
        }

        // The index filters by the child markers (`parent_session_id` +
        // `child_session_kind`) and returns the recency-sorted children. The
        // id-cursor, page-size, and status projection/filter stay at the edge
        // (v1 wire concerns; status needs live handles).
        const children = (await core.accessor.get(ISessionIndex).list({ childOf: session_id }))
          .items;

        let pivotIndex = -1;
        if (req.query.before_id !== undefined) {
          pivotIndex = children.findIndex((s) => s.id === req.query.before_id);
        } else if (req.query.after_id !== undefined) {
          pivotIndex = children.findIndex((s) => s.id === req.query.after_id);
        }
        let slice: typeof children;
        if (req.query.before_id !== undefined && pivotIndex >= 0) {
          slice = children.slice(pivotIndex + 1);
        } else if (req.query.after_id !== undefined && pivotIndex >= 0) {
          slice = children.slice(0, pivotIndex);
        } else {
          slice = children;
        }
        // `page_size` is already clamped to [1, 100] by the query coercion; 100
        // is the v1 default when omitted.
        const pageSize = req.query.page_size ?? 100;
        const window = slice.slice(0, pageSize);

        // `cwd` is read from the child's own summary first (gap G3 closed); the
        // registry is only a back-compat fallback for sessions written before
        // `cwd` was persisted, defaulting to '' (matches the prior adapter).
        const roots = new Map(
          (await core.accessor.get(IWorkspaceService).list()).map((w) => [w.id, w.root]),
        );
        const projected = window.map((summary) =>
          toWireSession(
            summary,
            summary.cwd ?? roots.get(summary.workspaceId) ?? '',
            resolveSessionFacts(core, summary.id),
          ),
        );
        // v1 filters the projected page by the busy fact (post-page); `has_more`
        // reflects the pre-filter page.
        const items =
          req.query.busy !== undefined
            ? projected.filter((session) => session.busy === req.query.busy)
            : projected;
        reply.send(okEnvelope({ items, has_more: slice.length > pageSize }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
        // `createChild` throws `session.not_found` for an unknown source (via
        // `fork`), so no explicit existence check is needed here. The child
        // markers (`parent_session_id` / `child_session_kind`) and the default
        // `Child: <parent>` title are applied by the lifecycle.
        const handle = await core.accessor.get(ISessionLifecycleService).createChild({
          sourceSessionId: session_id,
          title: req.body.title,
          metadata: req.body.metadata,
        });
        const meta = await handle.accessor.get(ISessionMetadata).read();
        const ctx = handle.accessor.get(ISessionContext);
        const session = toWireSession(
          { ...meta, workspaceId: ctx.workspaceId },
          ctx.cwd,
          resolveSessionFacts(core, meta.id),
        );
        core.accessor.get(IEventService).publish({
          type: 'event.session.created',
          payload: { agentId: 'main', sessionId: session.id, session },
        });
        reply.send(okEnvelope(session, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
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
      try {
        const { session_id } = req.params;
        const status = await core.accessor.get(ISessionLegacyService).status(session_id);
        reply.send(okEnvelope(status, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    statusRoute.path,
    statusRoute.options,
    statusRoute.handler as Parameters<SessionRouteHost['get']>[2],
  );

  const goalRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/goal',
      params: sessionIdParamSchema,
      success: { data: getSessionGoalResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'Get the current session goal (null when none is active)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { session_id } = req.params;
        const goal = await core.accessor.get(ISessionLegacyService).goal(session_id);
        reply.send(okEnvelope(goal, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
    },
  );
  app.get(
    goalRoute.path,
    goalRoute.options,
    goalRoute.handler as Parameters<SessionRouteHost['get']>[2],
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
      // `resume` (not `get`) so a freshly-opened cold session still computes its
      // warnings; matches v1's best-effort `resumeSession` before reading them.
      const session = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }
      try {
        // Surface the v2 `agents-md-oversized` notice in the v1 wire shape. The
        // warning is computed (and cached) by `IAgentProfileService` when the main
        // agent binds a profile; an unbound main agent yields `undefined` → `[]`,
        // matching v1's "no warning" case.
        const agent = await ensureMainAgent(session);
        const agentsMdWarning = agent.accessor.get(IAgentProfileService).getAgentsMdWarning();
        const warnings =
          agentsMdWarning === undefined
            ? []
            : [
                {
                  code: 'agents-md-oversized',
                  message: agentsMdWarning,
                  severity: 'warning' as const,
                },
              ];
        reply.send(okEnvelope({ warnings }, req.id));
      } catch (error) {
        sendMappedError(reply, req, error);
      }
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

export function toWireSession(
  fields: SessionWireFields,
  cwd: string,
  facts: SessionFacts,
): Session {
  return {
    id: fields.id,
    workspace_id: fields.workspaceId,
    title: fields.title ?? '',
    created_at: new Date(fields.createdAt).toISOString(),
    updated_at: new Date(fields.updatedAt).toISOString(),
    busy: facts.busy,
    main_turn_active: facts.mainTurnActive,
    pending_interaction: facts.pendingInteraction,
    last_turn_reason: facts.lastTurnReason,
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

/** Live activity and interaction facts projected onto the wire `Session`. */
export interface SessionFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * Resolve a session's live wire facts, derived on demand from the agents'
 * activity views: `busy` = any agent with an active turn or background task;
 * the reason is the main agent's latest turn outcome (`blocked` folds into
 * `failed`). Nothing is booked at session level — a cold session (no live
 * handle) is not busy and carries no outcome.
 */
export function resolveSessionFacts(core: Scope, sessionId: string): SessionFacts {
  const handle = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (handle === undefined) {
    return {
      busy: false,
      mainTurnActive: false,
      pendingInteraction: 'none',
    };
  }
  const agents = handle.accessor.get(IAgentLifecycleService);
  const mainActivity = agents.get(MAIN_AGENT_ID)?.accessor.get(IAgentActivityView).state();
  const interactions = handle.accessor.get(ISessionInteractionService);
  let busy = false;
  for (const agent of agents.list()) {
    const state = agent.accessor.get(IAgentActivityView).state();
    if (state.turn !== undefined || state.background.length > 0) {
      busy = true;
      break;
    }
  }
  const reason = mainActivity?.lastTurn?.reason;
  const pendingInteraction = resolvePendingInteraction(interactions);
  return {
    busy,
    mainTurnActive: mainActivity?.turn !== undefined,
    pendingInteraction,
    lastTurnReason: reason === 'blocked' ? 'failed' : reason,
  };
}

function resolvePendingInteraction(
  interactions: ISessionInteractionService,
): SessionPendingInteraction {
  if (interactions.listPending('approval').length > 0) return 'approval';
  if (interactions.listPending('question').length > 0) return 'question';
  return 'none';
}

/**
 * Resume the session (cold-load if needed) and resolve its main agent, throwing
 * `session.not_found` when the session is unknown or its workspace is gone.
 * Shared by the `compact` / `abort` actions, which both operate on the main
 * agent but carry no v1-specific projection worth keeping in
 * `ISessionLegacyService`.
 */
async function resolveMainAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await core.accessor.get(ISessionLifecycleService).resume(sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

/** Trim a compaction instruction; treat an empty/blank value as absent. */
function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** v1 `:undo` message page-size clamp (`packages/agent-core/.../sessionService.ts`). */
const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

/**
 * Mirror of v1 `pageContextMessages`: project the post-undo history into a
 * newest-first wire page, clamping `page_size` to `[1, 100]` (default 50).
 */
function pageUndoMessages(
  sessionId: string,
  sessionCreatedAtMs: number,
  history: readonly ContextMessage[],
  requestedPageSize: number | undefined,
): { items: ReturnType<typeof toProtocolMessage>[]; has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((message, index) =>
    toProtocolMessage(sessionId, index, message, sessionCreatedAtMs),
  );
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
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
  req: { id: string },
  err: unknown,
): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case 'session.not_found':
      case 'agent.not_found':
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'session.fork_active_turn':
        reply.send(errEnvelope(ErrorCode.SESSION_BUSY, err.message, requestId, err.stack));
        return;
      case 'compaction.unable':
        reply.send(errEnvelope(ErrorCode.COMPACTION_UNABLE, err.message, requestId, err.stack));
        return;
      case 'session.undo_unavailable':
        reply.send({
          code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
          msg: err.message,
          data: (err as { details?: unknown }).details ?? null,
          request_id: requestId,
          stack: err.stack,
        });
        return;
      case ErrorCodes.GOAL_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.GOAL_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_STATUS_INVALID:
        reply.send(errEnvelope(ErrorCode.GOAL_STATUS_INVALID, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_NOT_RESUMABLE:
        reply.send(errEnvelope(ErrorCode.GOAL_NOT_RESUMABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_EMPTY:
        reply.send(errEnvelope(ErrorCode.GOAL_OBJECTIVE_EMPTY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.GOAL_OBJECTIVE_TOO_LONG:
        reply.send(
          errEnvelope(ErrorCode.GOAL_OBJECTIVE_TOO_LONG, err.message, requestId, err.stack),
        );
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case 'request.invalid':
      case 'validation.failed':
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'session request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}
