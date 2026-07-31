/**
 * Cold-path fact fold: enrich a base snapshot (the turn tree built by
 * `groupMessagesIntoSnapshot`) with the durable facts carried by the
 * non-`context.*` wire records — tasks, interactions, todos, turn ends, and
 * the goal/plan/swarm meta.
 *
 * This is the second half of the cold rebuild: the engine persists these
 * records next to the context messages in the same `wire.jsonl`, and the live
 * path projects their events into global entities and timeline markers, so a
 * restart must be able to rebuild them from the records alone. The fold is
 * last-wins in record order, mirroring the live upsert semantics.
 *
 * Known limitations, accepted by design:
 *  - markers and taskrefs cannot be placed at their exact mid-timeline
 *    position (the base items carry no timestamps to interleave with), so
 *    they append IN RECORD ORDER at the END of the base items with an
 *    accurate `at` (record time). Entity state is complete.
 *  - turn end facts (terminal state / durationMs / error message) are
 *    rebuilt from the persisted `turn.ended` records when the journal
 *    carries them, with engine turn ids mapped to grouping ordinals
 *    through the replayed turn clock (hidden retry turns and cancelled
 *    queued reservations shift the ordinals); journals written before
 *    those records existed keep the grouping default (`completed`).
 *  - live-only detail is never backfilled: step usage / finishReason /
 *    timing / retry, tool inputText / progress, and task resultSummary /
 *    error / stateReason / usage exist only on live engine events — the
 *    persisted records do not carry them.
 *  - prompts are NOT cold-rebuilt: the wire journal has no prompt records
 *    (`prompt.submitted/completed/aborted/steered` are in-memory eventBus
 *    events of the engine's prompt service, never persisted as Ops), so a
 *    cold snapshot always carries `prompts: []`.
 *
 * The input type is structural so the engine's `WireRecord` is directly
 * assignable without a dependency from this package onto the engine (same
 * idiom as `HistoryMessage` in `groupTurns`).
 */

import type { TranscriptInteraction } from '../model/interaction';
import type { TranscriptItem, TranscriptMarker, TranscriptTaskRef } from '../model/item';
import type { GoalMeta, GoalStatus, TranscriptMeta } from '../model/meta';
import type { TranscriptTask } from '../model/task';
import type { TodoItem, TranscriptTodo } from '../model/todo';
import type { TranscriptTurn } from '../model/turn';
import type { AgentTranscriptSnapshot } from '../ops/operation';

export interface HistoryWireRecord {
  readonly type: string;
  readonly time?: number;
  readonly [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Record payload shapes (structural reads of the engine op payloads — see
// `agent-core-v2` goal/plan/swarm/todo/task/interaction ops).
// ---------------------------------------------------------------------------

/** `tools.update_store` payload. */
interface UpdateStorePayload {
  readonly key?: unknown;
  readonly value?: unknown;
}

/** `goal.create` / `goal.update` payload (the GoalState source fields). */
interface GoalPayload {
  readonly objective?: unknown;
  readonly completionCriterion?: unknown;
  readonly status?: unknown;
  readonly tokensUsed?: unknown;
  readonly budgetLimits?: { readonly tokenBudget?: unknown };
}

/** `task.started` / `task.terminated` `info` (`AgentTaskInfo`). */
interface TaskInfoPayload {
  readonly taskId?: unknown;
  readonly kind?: unknown;
  readonly status?: unknown;
  readonly detached?: unknown;
  readonly description?: unknown;
  readonly agentId?: unknown;
  readonly startedAt?: unknown;
  readonly endedAt?: unknown;
}

/** `interaction.request` payload. */
interface InteractionRequestPayload {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly toolCallId?: unknown;
  readonly request?: unknown;
}

/** `interaction.resolved` payload. */
interface InteractionResolvedPayload {
  readonly id?: unknown;
  readonly response?: unknown;
}

/** `plan.revision` payload (a versioned, reference-style plan content record). */
interface PlanRevisionPayload {
  readonly id?: unknown;
  readonly version?: unknown;
  readonly path?: unknown;
  readonly sha256?: unknown;
  readonly bytes?: unknown;
}

/** `turn.ended` payload (the loop's terminal turn record). */
interface TurnEndedPayload {
  readonly turnId?: unknown;
  readonly reason?: unknown;
  readonly error?: unknown;
  readonly durationMs?: unknown;
}

/** `turn.prompt` / `turn.cancel` payloads (the loop's turn-clock records). */
interface TurnPromptPayload {
  readonly origin?: unknown;
}
interface TurnCancelPayload {
  readonly turnId?: unknown;
  readonly target?: unknown;
  readonly reason?: unknown;
}

/**
 * Mirror of groupTurns' turn-opening rules, applied to `turn.prompt`
 * origins: whether the turn opens a visible transcript item. The engine
 * opens a real turn a transcript never shows for retry turns
 * (`RetryStepRequest` — origin `retry`, no context messages); hidden
 * mid-turn origins never produce `turn.prompt` records at all, but are
 * classified here anyway for completeness.
 */
function isVisibleTurnOrigin(origin: unknown): boolean {
  const kind = (origin as { kind?: unknown } | undefined)?.kind;
  if (kind === 'system_trigger') {
    const name = (origin as { name?: unknown } | undefined)?.name;
    return name === 'goal_continuation' || name === 'subagent';
  }
  if (kind === 'skill_activation' || kind === 'plugin_command') {
    return (origin as { trigger?: unknown } | undefined)?.trigger === 'user-slash';
  }
  if (kind === 'injection' || kind === 'retry' || kind === 'compaction_summary') return false;
  // user / cron / task / hook / shell_command / unknown kinds open visible turns.
  return true;
}

/** Engine task kinds (`AgentTaskInfoByKind`: process / agent / question) → transcript kinds. */
function mapTaskKind(kind: unknown): TranscriptTask['kind'] {
  switch (kind) {
    case 'process':
      return 'shell';
    case 'agent':
      return 'subagent';
    default:
      return 'other';
  }
}

const TASK_STATES = new Set<TranscriptTask['state']>([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]);

const GOAL_STATUSES = new Set<GoalStatus>(['active', 'paused', 'blocked', 'complete']);

/** Interaction terminal state — mirrors the live path's `mapInteractionEndState`. */
function mapInteractionEndState(
  kind: TranscriptInteraction['interactionKind'],
  response: unknown,
): TranscriptInteraction['state'] {
  if (kind === 'question') return response === null ? 'dismissed' : 'answered';
  const decision = (response as { decision?: unknown } | null | undefined)?.decision;
  if (decision === 'approved' || decision === 'rejected' || decision === 'cancelled') {
    return decision;
  }
  return 'cancelled';
}

/** Turn terminal state — mirrors the live path's `mapTurnEndState` (`blocked` folds into `failed`). */
function mapTurnEndReason(reason: unknown): TranscriptTurn['state'] | undefined {
  switch (reason) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    case 'blocked':
      return 'failed';
    default:
      return undefined;
  }
}

/** The transcript turn carries only the terminal error's message. */
function readTurnErrorMessage(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** Epoch-ms record times become ISO `at` stamps; ISO strings pass through. */
function recordTimeIso(record: HistoryWireRecord): string | undefined {
  const time: unknown = record.time;
  if (typeof time === 'number' && Number.isFinite(time)) return new Date(time).toISOString();
  if (typeof time === 'string') return time;
  return undefined;
}

function epochMsToIso(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

/** The record payload (everything but the envelope fields), carried on markers. */
function payloadOf(record: HistoryWireRecord): Record<string, unknown> {
  const { type: _type, time: _time, ...payload } = record;
  return payload;
}

/** Mirror of the engine's `readTodoItems`: keep only well-formed entries. */
function readTodoItems(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    const title = (entry as { title?: unknown } | undefined)?.title;
    const status = (entry as { status?: unknown } | undefined)?.status;
    if (typeof title !== 'string') continue;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'done') continue;
    items.push({ title, status });
  }
  return items;
}

export function foldWireRecordFacts(
  records: Iterable<HistoryWireRecord>,
  base: AgentTranscriptSnapshot,
): AgentTranscriptSnapshot {
  const tasks = new Map<string, TranscriptTask>();
  const interactions = new Map<string, TranscriptInteraction>();
  /** Latest `turn.ended` record per engine turn id (last-wins). */
  const endedTurns = new Map<number, HistoryWireRecord>();
  /**
   * Turn-clock replay (mirrors the loop's TurnModel): engine turn ids are
   * assigned to `turn.prompt` records in order, skipping queued-then-
   * cancelled reservations. Turns whose origin opens no visible transcript
   * item (retry turns) make engine ids drift from the grouping ordinals.
   */
  let nextTurnId = 0;
  const cancelledTurnIds = new Set<number>();
  const hiddenTurnIds = new Set<number>();
  const skipCancelledTurnIds = (): void => {
    // A skipped reservation never starts: no prompt, no messages, no item.
    while (cancelledTurnIds.delete(nextTurnId)) {
      hiddenTurnIds.add(nextTurnId);
      nextTurnId += 1;
    }
  };
  let todo: TranscriptTodo | undefined;
  let goal: GoalMeta | undefined;
  let goalTouched = false;
  let planActive: boolean | undefined;
  /** Latest folded `plan.revision` reference; feeds the active plan badge. */
  let planRevision: { readonly reviewPath?: string; readonly version?: number } | undefined;
  let swarmActive: boolean | undefined;

  /** Markers/taskrefs generated by the fold, appended after the base items. */
  const appended: TranscriptItem[] = [];
  const activeCancelTurnIds = new Set<number>();
  // Marker ids continue the base's `m<N>` numbering (groupTurns uses the same
  // namespace); taskref ids dedupe against refs the base already carries.
  let markerSeq = 0;
  const usedRefIds = new Set<string>();
  for (const item of base.items) {
    if (item.kind === 'marker') {
      const match = /^m(\d+)$/.exec(item.markerId);
      if (match !== null) markerSeq = Math.max(markerSeq, Number(match[1]));
    } else if (item.kind === 'taskref') {
      usedRefIds.add(item.refId);
    }
  }
  const pushMarker = (marker: string, record: HistoryWireRecord): void => {
    markerSeq += 1;
    const item: TranscriptMarker = {
      kind: 'marker',
      markerId: `m${markerSeq}`,
      marker,
      payload: payloadOf(record),
      at: recordTimeIso(record),
    };
    appended.push(item);
  };

  const upsertTask = (record: HistoryWireRecord): void => {
    const info = record['info'] as TaskInfoPayload | undefined;
    if (info === undefined || typeof info.taskId !== 'string') return;
    const taskId = info.taskId;
    const prev = tasks.get(taskId);
    const status = info.status;
    const task: TranscriptTask = {
      taskId,
      kind: mapTaskKind(info.kind),
      state:
        typeof status === 'string' && TASK_STATES.has(status as TranscriptTask['state'])
          ? (status as TranscriptTask['state'])
          : (prev?.state ?? 'running'),
      // Legacy records omit the flag and are treated as detached (mirrors the
      // live `info.detached ?? prev?.detached ?? true`).
      detached: typeof info.detached === 'boolean' ? info.detached : (prev?.detached ?? true),
      description: typeof info.description === 'string' ? info.description : prev?.description,
      agentId: typeof info.agentId === 'string' ? info.agentId : prev?.agentId,
      // `task.terminated` records may carry the captured output tail.
      outputTail:
        typeof record['outputTail'] === 'string'
          ? record['outputTail']
          : (prev?.outputTail ?? ''),
      startedAt: prev?.startedAt ?? epochMsToIso(info.startedAt),
      endedAt: epochMsToIso(info.endedAt) ?? prev?.endedAt,
    };
    tasks.set(taskId, task);
    if (record.type === 'task.started') {
      const refId = `ref-${taskId}`;
      if (!usedRefIds.has(refId)) {
        usedRefIds.add(refId);
        const ref: TranscriptTaskRef = {
          kind: 'taskref',
          refId,
          taskId,
          at: recordTimeIso(record),
        };
        appended.push(ref);
      }
    }
  };

  for (const record of records) {
    switch (record.type) {
      case 'tools.update_store': {
        const payload = record as UpdateStorePayload;
        if (payload.key !== 'todo') break;
        todo = {
          todoId: 'todo',
          items: readTodoItems(payload.value),
          updatedAt: recordTimeIso(record),
        };
        break;
      }
      case 'goal.create': {
        const payload = record as GoalPayload;
        goalTouched = true;
        // Mirrors the model's `apply`: a create always lands active with zero
        // usage; budget limits arrive via `goal.update`.
        goal = {
          objective: typeof payload.objective === 'string' ? payload.objective : '',
          status: 'active',
          completionCriterion:
            typeof payload.completionCriterion === 'string'
              ? payload.completionCriterion
              : undefined,
          budgetUsed: 0,
        };
        pushMarker('goal', record);
        break;
      }
      case 'goal.update': {
        const payload = record as GoalPayload;
        goalTouched = true;
        if (goal !== undefined) {
          const tokenBudget = payload.budgetLimits?.tokenBudget;
          goal = {
            ...goal,
            status:
              typeof payload.status === 'string' &&
              GOAL_STATUSES.has(payload.status as GoalStatus)
                ? (payload.status as GoalStatus)
                : goal.status,
            budgetUsed:
              typeof payload.tokensUsed === 'number' ? payload.tokensUsed : goal.budgetUsed,
            budgetLimit: typeof tokenBudget === 'number' ? tokenBudget : goal.budgetLimit,
          };
        }
        pushMarker('goal', record);
        break;
      }
      case 'goal.clear': {
        goalTouched = true;
        goal = undefined;
        break;
      }
      case 'plan_mode.enter': {
        planActive = true;
        planRevision = undefined;
        pushMarker('plan.enter', record);
        break;
      }
      case 'plan_mode.exit':
      case 'plan_mode.cancel': {
        planActive = false;
        planRevision = undefined;
        pushMarker('plan.exit', record);
        break;
      }
      case 'plan.revision': {
        const payload = record as PlanRevisionPayload;
        // A revision is submitted while plan mode is active; it refines the
        // badge with the offloaded plan file reference, and the exit/cancel
        // record still clears the badge afterwards (the marker stays).
        planActive = true;
        planRevision = {
          reviewPath: typeof payload.path === 'string' ? payload.path : undefined,
          version: typeof payload.version === 'number' ? payload.version : undefined,
        };
        pushMarker('plan.revision', record);
        break;
      }
      case 'swarm_mode.enter': {
        swarmActive = true;
        pushMarker('swarm.enter', record);
        break;
      }
      case 'swarm_mode.exit': {
        swarmActive = false;
        pushMarker('swarm.exit', record);
        break;
      }
      case 'task.started':
      case 'task.terminated': {
        upsertTask(record);
        break;
      }
      case 'turn.cancel': {
        const payload = record as TurnCancelPayload;
        if (
          payload.target === 'queued' &&
          typeof payload.turnId === 'number' &&
          payload.turnId >= nextTurnId
        ) {
          cancelledTurnIds.add(payload.turnId);
          skipCancelledTurnIds();
          break;
        }
        if (
          payload.target !== 'active' ||
          typeof payload.turnId !== 'number' ||
          !Number.isInteger(payload.turnId) ||
          payload.turnId < 0 ||
          activeCancelTurnIds.has(payload.turnId)
        ) {
          break;
        }
        activeCancelTurnIds.add(payload.turnId);
        if (payload.reason !== 'user_cancelled') break;
        pushMarker('interruption', record);
        break;
      }
      case 'interaction.request': {
        const payload = record as InteractionRequestPayload;
        // The live path projects only approvals/questions (`user_tool`
        // requests never become transcript entities).
        if (payload.kind !== 'approval' && payload.kind !== 'question') break;
        if (typeof payload.id !== 'string') break;
        const requestToolCallId = (payload.request as { toolCallId?: unknown } | undefined)
          ?.toolCallId;
        const toolCallId =
          typeof payload.toolCallId === 'string'
            ? payload.toolCallId
            : typeof requestToolCallId === 'string'
              ? requestToolCallId
              : undefined;
        interactions.set(payload.id, {
          interactionId: payload.id,
          interactionKind: payload.kind,
          toolCallId,
          state: 'pending',
          request: payload.request,
        });
        break;
      }
      case 'interaction.resolved': {
        const payload = record as InteractionResolvedPayload;
        if (typeof payload.id !== 'string') break;
        const entity = interactions.get(payload.id);
        if (entity === undefined) break;
        interactions.set(payload.id, {
          ...entity,
          state: mapInteractionEndState(entity.interactionKind, payload.response),
          response: payload.response,
        });
        break;
      }
      case 'turn.ended': {
        const payload = record as TurnEndedPayload;
        if (typeof payload.turnId === 'number') endedTurns.set(payload.turnId, record);
        break;
      }
      case 'turn.prompt': {
        skipCancelledTurnIds();
        const turnId = nextTurnId;
        nextTurnId += 1;
        if (!isVisibleTurnOrigin((record as TurnPromptPayload).origin)) hiddenTurnIds.add(turnId);
        break;
      }
      default:
        break;
    }
  }

  // A request without a resolve means the process died while the interaction
  // was pending — crash == cancelled (never rebuild a ghost pending).
  for (const [id, entity] of interactions) {
    if (entity.state === 'pending') {
      interactions.set(id, { ...entity, state: 'cancelled' });
    }
  }

  // `turn.ended` records rewrite the matching base turn items. An engine
  // turn id maps to the grouping ordinal `id - (hidden ids below it)`:
  // hidden turns (retry turns, queued-then-cancelled reservations) consume
  // an engine id without opening a visible item. Their own end records map
  // nowhere and are dropped; ids with no matching item are ignored (e.g.
  // turns compacted out of the message history). One residual gap,
  // accepted: a turn that ends between `turn.prompt` and its first context
  // message leaves no message trace and still shifts the ordinals behind it.
  const endedByOrdinal = new Map<number, HistoryWireRecord>();
  for (const [turnId, record] of endedTurns) {
    if (hiddenTurnIds.has(turnId)) continue;
    let hidden = 0;
    for (const id of hiddenTurnIds) if (id < turnId) hidden += 1;
    endedByOrdinal.set(turnId - hidden, record);
  }

  const items =
    endedByOrdinal.size > 0
      ? base.items.map((item) => {
          if (item.kind !== 'turn') return item;
          const record = endedByOrdinal.get(item.ordinal);
          if (record === undefined) return item;
          const payload = record as TurnEndedPayload;
          return {
            ...item,
            state: mapTurnEndReason(payload.reason) ?? item.state,
            endedAt: recordTimeIso(record) ?? item.endedAt,
            durationMs:
              typeof payload.durationMs === 'number' ? payload.durationMs : item.durationMs,
            error: readTurnErrorMessage(payload.error) ?? item.error,
          };
        })
      : base.items;

  const modesTouched = planActive !== undefined || swarmActive !== undefined;
  const meta: TranscriptMeta = {
    ...base.meta,
    goal: goalTouched ? goal : base.meta.goal,
    modes: modesTouched
      ? {
          ...base.meta.modes,
          // The plan badge carries the latest revision reference when
          // `plan.revision` records exist; without them (older sessions) it
          // stays the bare `{}` the live path projects. Same for the swarm
          // trigger.
          plan:
            planActive === undefined
              ? base.meta.modes?.plan
              : planActive
                ? (planRevision ?? {})
                : undefined,
          swarm: swarmActive === undefined ? base.meta.modes?.swarm : swarmActive ? {} : undefined,
        }
      : base.meta.modes,
  };

  return {
    ...base,
    items: appended.length > 0 ? [...items, ...appended] : items,
    tasks: [...tasks.values()],
    interactions: [...interactions.values()],
    todos: todo !== undefined ? [todo] : base.todos,
    meta,
  };
}
