/**
 * `/sessions/{session_id}/tasks*` REST routes — server-v2 port.
 *
 * Implements the v1 `/api/v1/sessions/{sid}/tasks` wire contract on top of
 * `agent-core-v2` (REST.md §3.7):
 *
 *   GET  /sessions/{session_id}/tasks                 query: {status?}        data: {items[]}
 *   GET  /sessions/{session_id}/tasks/{task_id}       query: {with_output?,
 *                                                               output_bytes?} data: Task
 *   POST /sessions/{session_id}/tasks/{task_id}:cancel body: empty            data: {cancelled:true}
 *
 * **Thin wrapper over existing task domains**: the main agent's
 * `IAgentTaskService` is already exposed at Agent scope (`tasks:*` in the RPC
 * action map). These REST routes borrow it by interface and project its
 * `AgentTaskInfo` (camelCase + ms timestamps + agent-core literal sets)
 * into the protocol's `Task` shape (snake_case + ISO + spec literal sets).
 * Cancel accepts Agent ids as compatibility aliases for Agent tasks. Swarm
 * members are not task-service entries, so cancellation falls through to the
 * Session-scoped `ISessionSwarmService`, which owns member isolation. Cancel
 * resolution prefers an exact task id, then an active Agent-task alias, then a
 * swarm member, and only then terminal Agent-task history.
 *
 * **Resolution**: `core` → `ISessionIndex` (existence, → 40401) →
 * `ISessionLifecycleService` (live session handle) → `IAgentLifecycleService`
 * (the `main` agent) → `IAgentTaskService`. When the session is not live or
 * has no main agent yet (server-v2 gap G10 — the main agent is not created on
 * session creation), there is no task service: `list` returns an empty page
 * and `get`/`cancel` answer `40406`.
 *
 * **Error mapping**:
 *   - unknown session            → `40401` (session.not_found)
 *   - unknown task               → `40406` (task.not_found)
 *   - cancelling a terminal task → `40904` (task.already_finished) with custom
 *     `data:{cancelled:false}` + `details.current_status` for the idempotent
 *     cancellation shape.
 *   - invalid query / `:action`  → `40001` (validation.failed, via defineRoute
 *     or `parseActionSuffix`).
 *
 * **Action suffix**: `:cancel` uses the shared `parseActionSuffix` helper
 * because Fastify cannot disambiguate `/:task_id` from `/:task_id:cancel` on
 * the same Trie prefix.
 */

import {
  IAgentTaskService,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionSwarmService,
  type AgentTaskInfo,
  type SessionSwarmStopResult,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  cancelTaskResultSchema,
  getTaskQuerySchema,
  getTaskResponseSchema,
  listTasksQuerySchema,
  listTasksResponseSchema,
} from '@moonshot-ai/protocol';
import type { Task, TaskKind, TaskStatus } from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

/** Default cap (bytes) for the opt-in output preview on GET-by-id. */
const DEFAULT_TASK_OUTPUT_PREVIEW_BYTES = 32 * 1024;

interface TasksRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
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

// --- Params -----------------------------------------------------------------

const sessionIdParamSchema = z.object({
  session_id: z.string().min(1),
});

const sessionAndTaskIdParamSchema = z.object({
  session_id: z.string().min(1),
  task_id: z.string().min(1),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

// --- Registration -----------------------------------------------------------

export function registerTasksRoutes(app: TasksRouteHost, core: Scope): void {
  // GET /sessions/{session_id}/tasks ------------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks',
      params: sessionIdParamSchema,
      querystring: listTasksQuerySchema,
      success: { data: listTasksResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
      },
      description: 'List tasks for a session',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id } = req.params;
      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      // `list(false)` = include terminal (ghost) tasks, matching v1 which
      // lists everything and filters by wire status in-memory.
      const all = (resolved.tasks?.list(false) ?? []).map((info) =>
        toWireTask(session_id, info),
      );
      const query = req.query as { status?: TaskStatus };
      const items =
        query.status !== undefined ? all.filter((t) => t.status === query.status) : all;
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  // GET /sessions/{session_id}/tasks/{task_id} --------------------------
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/tasks/{task_id}',
      params: sessionAndTaskIdParamSchema,
      querystring: getTaskQuerySchema,
      success: { data: getTaskResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
      },
      description: 'Get a task by ID',
      tags: ['tasks'],
    },
    async (req, reply) => {
      const { session_id, task_id } = req.params;
      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const found = resolved.tasks?.getTask(task_id);
      if (found === undefined) {
        reply.send(taskNotFound(session_id, task_id, req.id));
        return;
      }

      const query = req.query as { with_output?: boolean; output_bytes?: number };
      let output: { preview: string; bytes: number } | undefined;
      if (query.with_output === true && resolved.tasks !== undefined) {
        const tailBytes = query.output_bytes ?? DEFAULT_TASK_OUTPUT_PREVIEW_BYTES;
        try {
          const preview = await resolved.tasks.readOutput(task_id, tailBytes);
          if (preview.length > 0) {
            output = { preview, bytes: Buffer.byteLength(preview, 'utf-8') };
          }
        } catch {
          // Output may not be available yet; fall back to task metadata only.
        }
      }

      reply.send(okEnvelope(toWireTask(session_id, found, output), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<TasksRouteHost['get']>[2]);

  // POST /sessions/{session_id}/tasks/{task_id}:cancel ------------------
  //
  // Fastify routes the GET `/:task_id` and the POST `/:tail` against the
  // same Trie prefix. A `/:task_id:cancel`-style path would collide, so we
  // capture `:tail` and demand the `:cancel` suffix via the shared parser.
  const cancelRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/tasks/{tail}',
      success: { data: cancelTaskResultSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.TASK_NOT_FOUND]: {},
        [ErrorCode.TASK_ALREADY_FINISHED]: {
          dataSchema: z.object({ cancelled: z.literal(false) }),
          detailsSchema: z.object({ current_status: z.string() }),
        },
      },
      description: 'Cancel a task',
      tags: ['tasks'],
      operationId: 'cancelTask',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as {
        session_id: string;
        tail: string;
      };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['cancel'] as const,
        resourceLabel: 'task',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        // POST without `:cancel` is not a defined action; the bare GET form
        // serves `/.../tasks/{tid}`.
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const task_id = parsed.id;
      if (!session_id || !task_id) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid path params', req.id));
        return;
      }

      const resolved = await resolveSessionTasks(core, session_id);
      if (resolved.kind === 'not_found') {
        reply.send(sessionNotFound(session_id, req.id));
        return;
      }

      const target = resolveCancelTarget(resolved, task_id);
      if (target.kind === 'agent_task') {
        const wireStatus = toWireTask(session_id, target.task).status;
        if (isTerminalStatus(wireStatus)) {
          reply.send(taskAlreadyFinished(session_id, task_id, wireStatus, req.id));
          return;
        }

        await resolved.tasks?.stop(target.task.taskId);
        reply.send(okEnvelope({ cancelled: true as const }, req.id));
        return;
      }

      if (
        target.kind === 'swarm' &&
        (target.result.kind === 'stopping' || target.result.kind === 'stopped')
      ) {
        reply.send(okEnvelope({ cancelled: true as const }, req.id));
        return;
      }
      if (target.kind === 'swarm' && target.result.kind === 'already_terminal') {
        reply.send(
          taskAlreadyFinished(
            session_id,
            task_id,
            mapSwarmStatus(target.result.status),
            req.id,
          ),
        );
        return;
      }

      reply.send(taskNotFound(session_id, task_id, req.id));
    },
  );
  app.post(cancelRoute.path, cancelRoute.options, cancelRoute.handler as Parameters<TasksRouteHost['post']>[2]);
}

// ---------------------------------------------------------------------------
// Resolution — walk core → session → main agent → `IAgentTaskService`.
// Returns `{kind:'not_found'}` when the session does not exist (→ 40401). A
// missing live session / main agent yields `{kind:'resolved', tasks: undefined}`
// (gap G10), which `list` treats as empty and `get`/`cancel` treat as 40406.
// ---------------------------------------------------------------------------

type ResolvedTasks =
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'resolved';
      readonly tasks: IAgentTaskService | undefined;
      readonly swarm: ISessionSwarmService | undefined;
    };

async function resolveSessionTasks(core: Scope, sid: string): Promise<ResolvedTasks> {
  const summary = await core.accessor.get(ISessionIndex).get(sid);
  if (summary === undefined) return { kind: 'not_found' };

  const session = core.accessor.get(ISessionLifecycleService).get(sid);
  if (session === undefined) {
    return { kind: 'resolved', tasks: undefined, swarm: undefined };
  }
  const agent = await ensureMainAgent(session);
  const tasks = agent.accessor.get(IAgentTaskService);
  const swarm = session.accessor.get(ISessionSwarmService);
  return { kind: 'resolved', tasks, swarm };
}

type SwarmCancelResult = Exclude<SessionSwarmStopResult, { readonly kind: 'not_found' }>;

type CancelTarget =
  | { readonly kind: 'agent_task'; readonly task: AgentTaskInfo }
  | { readonly kind: 'swarm'; readonly result: SwarmCancelResult }
  | { readonly kind: 'not_found' };

function resolveCancelTarget(
  resolved: Extract<ResolvedTasks, { readonly kind: 'resolved' }>,
  taskOrAgentId: string,
): CancelTarget {
  const exactTask = resolved.tasks?.getTask(taskOrAgentId);
  if (exactTask !== undefined) return { kind: 'agent_task', task: exactTask };

  const agentTask = resolved.tasks?.getAgentTask(taskOrAgentId);
  if (agentTask !== undefined && !isTerminalStatus(mapStatus(agentTask.status))) {
    return { kind: 'agent_task', task: agentTask };
  }

  const swarmResult = resolved.swarm?.stopAgent(taskOrAgentId);
  if (swarmResult !== undefined && swarmResult.kind !== 'not_found') {
    return { kind: 'swarm', result: swarmResult };
  }

  return agentTask === undefined
    ? { kind: 'not_found' }
    : { kind: 'agent_task', task: agentTask };
}

// ---------------------------------------------------------------------------
// Wire mapping — pure projection from `AgentTaskInfo` (agent-core literal
// sets + ms timestamps) to the protocol `Task` (spec literal sets +
// ISO timestamps). Mirrors v1's `toProtocolTask` / `mapKind` / `mapStatus` so
// the REST contract is byte-for-byte compatible.
//
//   kind:    process   → bash
//            agent     → subagent
//            question  → tool
//
//   status:  running   → running
//            completed → completed
//            failed    → failed
//            timed_out → failed       (lossy — stopReason carries the hint)
//            killed    → cancelled
//            lost      → failed       (lossy)
// ---------------------------------------------------------------------------

function mapKind(k: AgentTaskInfo['kind']): TaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
      // SCHEMAS §7 has no 'question' literal; question tasks are
      // tool-spawned flows, so 'tool' is the closest spec literal.
      return 'tool';
  }
}

function mapStatus(s: AgentTaskInfo['status']): TaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      // SCHEMAS §7 has no 'timed_out' literal; collapse to 'failed'.
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

function mapSwarmStatus(status: 'completed' | 'failed' | 'aborted'): TaskStatus {
  return status === 'aborted' ? 'cancelled' : status;
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

function toWireTask(
  sessionId: string,
  info: AgentTaskInfo,
  output?: { preview: string; bytes: number },
): Task {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: Task = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    // Agent-core has no separate creation stamp; synthesize from startedAt —
    // running tasks usually start immediately after creation.
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    base.completed_at = new Date(info.endedAt).toISOString();
  }
  if (info.kind === 'process' && 'command' in info && typeof info.command === 'string') {
    base.command = info.command;
  }
  if (output !== undefined) {
    base.output_preview = output.preview;
    base.output_bytes = output.bytes;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

function sessionNotFound(sid: string, requestId: string): unknown {
  return errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sid} does not exist`, requestId);
}

function taskNotFound(sid: string, tid: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.TASK_NOT_FOUND,
    `task ${tid} does not exist in session ${sid}`,
    requestId,
  );
}

/**
 * `40904` idempotent cancellation shape — REST.md §3.7 mandates
 * `data:{cancelled:false}` + `details.current_status` (mirrors the 40903 /
 * 40902 precedent).
 */
function taskAlreadyFinished(
  sid: string,
  tid: string,
  currentStatus: TaskStatus,
  requestId: string,
): unknown {
  return {
    code: ErrorCode.TASK_ALREADY_FINISHED,
    msg: `task ${tid} already finished (status: ${currentStatus})`,
    data: { cancelled: false },
    request_id: requestId,
    details: { current_status: currentStatus },
  };
}
