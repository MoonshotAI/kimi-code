/**
 * `ITaskService` — daemon-facing background task surface.
 *
 * Wraps `ICoreProcessService.rpc.{getBackground, stopBackground}` and adapts
 * `BackgroundTaskInfo` (camelCase + ms timestamps + agent-core literal sets)
 * into SCHEMAS §7 `BackgroundTask` (snake_case + ISO + spec literal sets).
 *
 * Adapter helpers (`toProtocolTask`, `isTerminalStatus`) are co-located here.
 *
 * **CoreAPI surface used**:
 *   - `core.rpc.getBackground({sessionId, agentId, activeOnly?, limit?})
 *      => readonly BackgroundTaskInfo[]`
 *     (packages/agent-core/src/rpc/core-api.ts:334 + WithSessionId+WithAgentId
 *      injection).
 *   - `core.rpc.stopBackground({sessionId, agentId, taskId, reason?})`
 *     (line 323).
 *
 * **Error model**:
 *   - `TaskNotFoundError` (→ 40406) when the task id does not exist within
 *     the session.
 *   - `TaskAlreadyFinishedError` (→ 40904) when the task has reached a
 *     terminal status (completed/failed/cancelled/timed_out/killed/lost).
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` / `Disposable` values and the `BackgroundTaskInfo` type.
 *
 * Reference table (task kind + status):
 *
 *   kind:    process   → bash
 *            agent     → subagent
 *            question  → tool
 *
 *   status:  running   → running
 *            completed → completed
 *            failed    → failed
 *            timed_out → failed       (lossy — stopReason carries hint)
 *            killed    → cancelled
 *            lost      → failed       (lossy)
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';
import type { BackgroundTaskInfo } from '@moonshot-ai/agent-core';
import type { BackgroundTask, BackgroundTaskKind, BackgroundTaskStatus } from '@moonshot-ai/protocol';

import { SessionNotFoundError } from '../session/session';

// ---------------------------------------------------------------------------
// Adapter helpers (moved from adapter/task-adapter.ts)
// ---------------------------------------------------------------------------

function mapKind(k: BackgroundTaskInfo['kind']): BackgroundTaskKind {
  switch (k) {
    case 'process':
      return 'bash';
    case 'agent':
      return 'subagent';
    case 'question':
      // SCHEMAS §7 has no 'question' literal; question background tasks are
      // tool-spawned flows (Loop runs them as part of `Question` tool
      // execution), so 'tool' is the closest spec literal.
      return 'tool';
  }
}

function mapStatus(s: BackgroundTaskInfo['status']): BackgroundTaskStatus {
  switch (s) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'timed_out':
      // SCHEMAS §7 has no 'timed_out' literal; collapse to 'failed'. The
      // optional `stop_reason`/`last_error` surface would carry the hint
      // once SCHEMAS adds the field (deferred).
      return 'failed';
    case 'killed':
      return 'cancelled';
    case 'lost':
      return 'failed';
  }
}

const TERMINAL_WIRE_STATUSES: ReadonlySet<BackgroundTaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminalStatus(status: BackgroundTaskStatus): boolean {
  return TERMINAL_WIRE_STATUSES.has(status);
}

export function toProtocolTask(sessionId: string, info: BackgroundTaskInfo): BackgroundTask {
  const status = mapStatus(info.status);
  const createdIso = new Date(info.startedAt).toISOString();
  const base: BackgroundTask = {
    id: info.taskId,
    session_id: sessionId,
    kind: mapKind(info.kind),
    description: info.description,
    status,
    // Agent-core has no separate creation stamp; we synthesize from
    // startedAt — running tasks usually start immediately after creation.
    created_at: createdIso,
    started_at: createdIso,
  };
  if (info.endedAt !== null && info.endedAt !== undefined) {
    return { ...base, completed_at: new Date(info.endedAt).toISOString() };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Interface + implementation
// ---------------------------------------------------------------------------

export interface TaskListQuery {
  readonly status?: BackgroundTaskStatus;
}

export interface ITaskService {
  readonly _serviceBrand: undefined;

  /** Return the (full) list of background tasks for the session. */
  list(sessionId: string, query: TaskListQuery): Promise<readonly BackgroundTask[]>;

  /**
   * Return a single background task. Throws `TaskNotFoundError` (→ 40406)
   * when the task id is not found.
   */
  get(sessionId: string, taskId: string): Promise<BackgroundTask>;

  /**
   * Cancel a running task. Throws:
   *   - `TaskNotFoundError`        → 40406
   *   - `TaskAlreadyFinishedError` → 40904 (daemon emits custom envelope
   *      with `data:{cancelled:false}`)
   */
  cancel(sessionId: string, taskId: string): Promise<{ cancelled: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITaskService = createDecorator<ITaskService>('taskService');

/**
 * Sentinel — daemon route maps to `code: 40406 task.not_found`.
 */
export class TaskNotFoundError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  constructor(sessionId: string, taskId: string) {
    super(`task ${taskId} does not exist in session ${sessionId}`);
    this.name = 'TaskNotFoundError';
    this.sessionId = sessionId;
    this.taskId = taskId;
  }
}

/**
 * Sentinel — daemon route maps to `code: 40904 task.already_finished`. The
 * envelope's `data` shape is `{ cancelled: false }` (REST.md §3.7 idempotent
 * shape mirroring 40903 + 40902 precedent).
 */
export class TaskAlreadyFinishedError extends Error {
  readonly sessionId: string;
  readonly taskId: string;
  readonly currentStatus: BackgroundTaskStatus;
  constructor(sessionId: string, taskId: string, currentStatus: BackgroundTaskStatus) {
    super(`task ${taskId} already finished (status: ${currentStatus})`);
    this.name = 'TaskAlreadyFinishedError';
    this.sessionId = sessionId;
    this.taskId = taskId;
    this.currentStatus = currentStatus;
  }
}

void ITaskService;
