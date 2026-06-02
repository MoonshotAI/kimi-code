import { randomUUID } from 'node:crypto';

import { ErrorCodes, KimiError } from '#/errors';
import type { AgentRecord } from '../agent/records/types';

/** Minimal audit sink the goal store writes `goal.*` records into. */
export interface GoalAuditSink {
  logRecord(record: AgentRecord): void;
}

/**
 * Durable goal-mode state owned by {@link SessionGoalStore}.
 *
 * The store keeps exactly one current goal in `Session.metadata.custom.goal`.
 * It owns the lifecycle rules, budget math, and actor boundaries that the
 * slash command, model tools, and goal continuation driver depend on.
 */

/** Maximum objective length in characters. */
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

/**
 * Lifecycle status of a goal — deliberately minimal. The durable record only
 * ever holds `active`, `paused`, or `blocked`; `complete` is transient
 * (announce-then-clear) and never rests on disk. There is exactly one running
 * state, two resumable "stopped" states, and one success outcome:
 *
 * | Status     | Persisted | Resumable | Set by                          | Meaning                                          |
 * |------------|-----------|-----------|---------------------------------|--------------------------------------------------|
 * | `active`   | yes       | (running) | createGoal / resumeGoal         | The goal driver may run continuation turns.      |
 * | `paused`   | yes       | yes       | pauseGoal / pauseOnInterrupt /  | User (or interrupt) stopped it; intact.          |
 * |            |           |           | normalizeMetadata               |                                                  |
 * | `blocked`  | yes       | yes       | markBlocked                     | The system stopped it for some `reason`.         |
 * | `complete` | no        | —         | markComplete                    | Success — announced in a message, then cleared.  |
 *
 * Only an `active` goal advances: accounting and continuation turns all gate on
 * `status === 'active'`. `paused` and `blocked` are the same kind of
 * thing — "the driver is not running continuation turns, but the goal is intact
 * and resumable via `/goal resume`" — differing only in *who* stopped it (the
 * user vs the system) and the human-readable `reason`. There is no separate
 * `impossible`, `budget_limited`, `error`, or `cancelled` status: an unachievable
 * goal, an exhausted budget, a runtime failure all become `blocked(+reason)`,
 * and `cancelGoal` discards the record entirely. See {@link SessionGoalStore}
 * for the setters and the per-status notes below.
 */
export type GoalStatus =
  /**
   * The goal is live and the goal driver may run continuation turns toward it.
   * Set on creation (`createGoal`) and when a paused/blocked goal is resumed
   * (`resumeGoal`). The only status under which turns/tokens/wall-clock are
   * accounted and continuation turns run.
   */
  | 'active'
  /**
   * The user stopped the goal but it is fully intact and resumable via
   * `/goal resume`. Reached three ways: the user pauses (`pauseGoal`); a live
   * turn is aborted mid-flight, e.g. Esc/shutdown (`pauseOnInterrupt`); or a
   * session is resumed from disk, where an `active` goal cannot still be running
   * and is demoted (`normalizeMetadata`).
   */
  | 'paused'
  /**
   * The *system* stopped pursuing the goal, for a reason carried in
   * `terminalReason`: the model reported it cannot proceed via
   * `UpdateGoal('blocked')` (an external blocker, or an objective it deems
   * unachievable); a configured hard budget (token/turn/time) was reached; or a
   * runtime failure occurred. Set by `markBlocked` (from the model's
   * `UpdateGoal`, the budget check in the goal driver, and the driver's
   * turn-failure catch).
   * Resumable like `paused` — `/goal resume` re-activates it; a plain message
   * just runs one normal turn without reactivating the loop. Editing the goal
   * while blocked takes effect on the next turn.
   */
  | 'blocked'
  /**
   * Success: the model reported the objective met via `UpdateGoal('complete')`.
   * Set by `markComplete`. This status is **transient**
   * — `markComplete` emits the completion, appends a completion message, and then
   * clears the durable record, so the goal box disappears and `complete` never
   * rests on disk (like the old `cancelled` pattern, but with an announcement).
   */
  | 'complete';

/** Who performed a goal action. `cleared` is an audit action, not a status. */
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

/** The durable goal record persisted in `metadata.custom.goal`. */
export interface SessionGoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  startedBy: GoalActor;
  updatedBy: GoalActor;
  turnsUsed: number;
  tokensUsed: number;
  /** Accumulated active-pursuit time from completed `active` intervals. */
  wallClockMs: number;
  /**
   * Epoch ms anchoring the current `active` interval (undefined when not active).
   * The live elapsed since this is added to `wallClockMs` when reporting, so the
   * timer is correct even when read mid-turn; the interval is folded into
   * `wallClockMs` when the goal leaves `active`. Reset on session resume.
   */
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
}

/** Computed budget view exposed through snapshots and tools. */
export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

/** Public, computed view of the current goal. */
export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedBy: GoalActor;
  readonly updatedBy: GoalActor;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
}

/** Wrapper returned by goal read operations and tools. */
export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

/** Snapshot of the goal's usage counters at the moment of a change. */
export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

/**
 * Describes what changed on a `goal.updated` event, so the UI can render the
 * right thing. Absent for snapshot-only refreshes (e.g. a turn increment that
 * only moves the badge).
 *
 * - `lifecycle`: a status transition — `paused` / `active` (resumed) / `blocked`
 *   — rendered as a low-profile transcript marker.
 * - `completion`: the goal completed successfully (the only outcome that posts
 *   the completion message and clears the record). This replaced the older
 *   `terminal` name, which since the state consolidation only ever meant
 *   `complete` — `blocked` is a resumable `lifecycle` change, not a completion.
 */
export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
}

/**
 * Statuses a stopped goal can be resumed from via `resumeGoal` / `/goal resume`.
 * Both are non-`active` but intact: `paused` (user/interrupt) and `blocked`
 * (system). `active` is already running and `complete` is transient, so neither
 * is resumable.
 */
const RESUMABLE_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>(['paused', 'blocked']);

export function isResumableGoalStatus(status: GoalStatus): boolean {
  return RESUMABLE_STATUSES.has(status);
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly budgetLimits?: GoalBudgetLimits;
  readonly replace?: boolean;
  readonly actor?: GoalActor;
}

export interface GoalControlInput {
  readonly actor?: GoalActor;
  readonly reason?: string;
}

export interface SessionGoalStoreOptions {
  readonly sessionId?: string | undefined;
  /** Reads the current goal state from session metadata. */
  readonly readState: () => SessionGoalState | undefined;
  /** Writes (or clears, when `undefined`) the goal state and persists metadata. */
  readonly writeState: (state: SessionGoalState | undefined) => Promise<void>;
  /**
   * Lazily resolves the main-agent audit sink. Goal audit records are written
   * here once the sink exists, and queued in order until then.
   */
  readonly auditSink?: () => GoalAuditSink | undefined;
  /**
   * Notified with the current goal snapshot (or `null` when cleared) after each
   * durable state change, so live UI (e.g. the footer badge) can update. A
   * `change` accompanies lifecycle / verdict / terminal transitions so the UI can
   * also render transcript markers; it is absent for snapshot-only refreshes
   * (e.g. a turn increment). Not called for per-step token / wall-clock
   * accounting, to avoid chatty updates.
   */
  readonly onGoalUpdated?: (snapshot: GoalSnapshot | null, change?: GoalChange) => void;
  /** Injectable clock (epoch ms) for the live wall-clock timer; tests override it. */
  readonly now?: () => number;
}

/**
 * Single durable owner of the current goal.
 *
 * Lifecycle rules (see the {@link GoalStatus} union for the full per-status map):
 * - Success: `markComplete` records success then clears the record (transient).
 *   The model marks completion via the `UpdateGoal('complete')` tool; the turn
 *   driver reads the status at the turn boundary. `markComplete` announces, then
 *   clears the record.
 * - System stop: `markBlocked(reason)` sets `blocked` for any reason the system
 *   stops pursuing — the model's `UpdateGoal('blocked')`, a hard budget, or a
 *   runtime error. `blocked` is resumable.
 * - User stop: `pauseGoal` and the interrupt path `pauseOnInterrupt` set `paused`
 *   (resumable); `cancelGoal` discards the record entirely (no status — this is
 *   what `/goal cancel` does, the single remove action).
 * - An aborted turn (Esc / shutdown) is not terminal: it pauses the goal, so it
 *   stays resumable — mirroring how `normalizeMetadata` demotes an `active` goal
 *   to `paused` on session resume.
 */
export class SessionGoalStore {
  /** Audit records queued until the main-agent sink becomes available. */
  private readonly pending: AgentRecord[] = [];

  constructor(private readonly options: SessionGoalStoreOptions) {}

  /** Current epoch ms from the injectable clock (defaults to `Date.now`). */
  private nowMs(): number {
    return this.options.now?.() ?? Date.now();
  }

  // --- Audit -------------------------------------------------------------

  /**
   * Writes an audit record to the main-agent sink, or queues it in order when
   * the sink is not yet available (e.g. before the main agent exists).
   */
  private appendAudit(record: AgentRecord): void {
    const sink = this.options.auditSink?.();
    if (sink !== undefined) {
      sink.logRecord(record);
    } else {
      this.pending.push(record);
    }
  }

  /** Flushes queued audit records in original order once a sink is available. */
  flushPendingRecords(): void {
    const sink = this.options.auditSink?.();
    if (sink === undefined) return;
    const queued = this.pending.splice(0);
    for (const record of queued) {
      sink.logRecord(record);
    }
  }

  /**
   * Reconciles persisted goal state with runtime reality on session resume.
   *
   * An `active` goal cannot still be running after a process restart (goal
   * continuation only advances inside a live turn), so it is demoted to
   * `paused`, requiring `/goal resume` to restart work. `paused` and `blocked`
   * goals are preserved (both resumable). Malformed records, and any stray
   * `complete` (which should have been cleared on completion), are removed.
   */
  async normalizeMetadata(): Promise<void> {
    const state = this.options.readState();
    if (state === undefined) return;

    if (!isValidGoalState(state)) {
      await this.persistState(undefined);
      return;
    }

    // The wall-clock anchor is a runtime timestamp; a persisted one is stale
    // (it predates the downtime). Drop it so resumed time isn't counted as
    // pursuit — `resumeGoal` re-anchors a fresh interval.
    state.wallClockResumedAt = undefined;

    // `complete` is transient and should never rest on disk; a persisted one
    // means completion did not finish clearing. Drop it.
    if (state.status === 'complete') {
      await this.persistState(undefined);
      return;
    }

    if (state.status === 'active') {
      this.applyStatus(state, 'paused', 'runtime', 'Paused after session resume');
      await this.persistState(state);
      this.appendStatusUpdate(state, 'runtime', 'Paused after session resume');
      return;
    }

    // `paused` and `blocked` goals are left intact (both resumable).
  }

  // --- Reads -------------------------------------------------------------

  getGoal(): GoalToolResult {
    const state = this.options.readState();
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  // --- Creation ----------------------------------------------------------

  async createGoal(input: CreateGoalInput): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new KimiError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new KimiError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    const existing = this.options.readState();
    if (existing !== undefined) {
      // Any persisted goal (active / paused / blocked) is intact and blocks a
      // new one unless `replace` is set; `complete` never persists, so it is not
      // observed here. This protects a resumable paused/blocked goal from being
      // silently overwritten.
      if (input.replace !== true) {
        throw new KimiError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      // Clear the previous goal through the same internal clear path so audit
      // and metadata stay consistent before storing the replacement.
      await this.clearInternal('system', 'Replaced by a new goal');
    }

    const now = new Date().toISOString();
    const actor = input.actor ?? 'user';
    const state: SessionGoalState = {
      goalId: randomUUID(),
      objective,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      startedBy: actor,
      updatedBy: actor,
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: this.nowMs(),
      budgetLimits: input.budgetLimits ?? {},
    };
    if (input.completionCriterion !== undefined && input.completionCriterion.trim().length > 0) {
      state.completionCriterion = input.completionCriterion.trim();
    }

    await this.persistState(state);
    this.appendAudit({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      status: state.status,
      actor,
      budgetLimits: state.budgetLimits,
    });
    return this.toSnapshot(state);
  }

  // --- User-owned lifecycle ---------------------------------------------

  async pauseGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    const actor = input.actor ?? 'user';
    this.applyStatus(state, 'paused', actor, input.reason);
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (!isResumableGoalStatus(state.status)) {
      throw new KimiError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    const actor = input.actor ?? 'user';
    // Resuming is a fresh attempt: clear the stop reason so a re-activated goal
    // starts clean.
    state.terminalReason = undefined;
    this.applyStatus(state, 'active', actor, input.reason);
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(input: {
    budgetLimits: GoalBudgetLimits;
    actor?: GoalActor;
  }): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    state.updatedBy = input.actor ?? 'user';
    state.updatedAt = new Date().toISOString();
    await this.persistState(state);
    return this.toSnapshot(state);
  }

  /**
   * Discards the current goal — the single user-facing "remove" action
   * (`/goal cancel`). There is no `cancelled` status: cancel clears the durable
   * record and returns the snapshot it removed, so callers can report what was
   * cancelled. Throws if no goal exists. (Internal callers that need to clear
   * without a return — e.g. `createGoal` replacing an existing goal — use the
   * private `clearInternal`.)
   */
  async cancelGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    await this.clearInternal(input.actor ?? 'user', input.reason);
    return snapshot;
  }

  // --- Terminal outcomes (system-decided) -------------------------------

  /**
   * Marks the goal `blocked`: the system stopped pursuing it for `reason` — the
   * model's `UpdateGoal('blocked')` (incl. objectives it deems unachievable), a
   * hard budget reached by the goal driver, or a runtime failure in the driver.
   * `blocked` is persisted and **resumable** via
   * `/goal resume` (it is a sibling of `paused`, not a dead end), so it emits a
   * `lifecycle` change. No-ops for a goal that is missing or not active, so a
   * user pause / clear is never overwritten.
   */
  async markBlocked(
    input: { actor?: GoalActor; reason?: string } = {},
  ): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const actor = input.actor ?? 'runtime';
    this.applyStatus(state, 'blocked', actor, input.reason);
    state.terminalReason = input.reason;
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  /**
   * Records goal success, then clears the durable record. `complete` is
   * transient: this emits a terminal `complete` change carrying the final stats
   * (so the UI/caller can render the outcome) WITHOUT writing `complete` to disk,
   * then clears the goal so the box disappears. The `UpdateGoal` tool is
   * responsible for the user-facing completion message. Returns the final
   * snapshot (status `complete`) so the caller can build that message. No-ops for
   * a goal that is missing or not active.
   */
  async markComplete(
    input: { actor?: GoalActor; reason?: string } = {},
  ): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const actor = input.actor ?? 'model';
    this.applyStatus(state, 'complete', actor, input.reason);
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    // Audit + notify the UI of completion (with final stats) directly, without
    // persisting `complete` to disk...
    this.appendStatusUpdate(state, actor, input.reason);
    this.options.onGoalUpdated?.(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
    });
    // ...then clear the durable record (emits onGoalUpdated(null) → box clears).
    await this.clearInternal(actor, input.reason);
    return snapshot;
  }

  // --- User-interrupt transition ----------------------------------------

  /**
   * Parks an active goal when its live turn is aborted (Esc, shutdown, or any
   * other turn-level cancellation). This is **not** terminal: the goal becomes
   * `paused` and stays resumable via `/goal resume`, mirroring how
   * `normalizeMetadata` demotes an `active` goal on session resume. No-ops for a
   * goal that is missing or already non-active, so a user pause / clear or an
   * already-stopped goal is never overwritten.
   */
  async pauseOnInterrupt(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused', 'user', input.reason);
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason },
    });
    this.appendStatusUpdate(state, 'user', input.reason);
    return this.toSnapshot(state);
  }

  // --- Accounting & reporting -------------------------------------------

  async recordTokenUsage(input: {
    tokenDelta: number;
    agentId: string;
    agentType: string;
    source: string;
  }): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, input.tokenDelta);
    state.tokensUsed += delta;
    state.updatedAt = new Date().toISOString();
    await this.persistState(state, { silent: true }); // per-step: no UI update
    this.appendAudit({
      type: 'goal.account_usage',
      goalId: state.goalId,
      usageKind: 'token',
      delta,
      agentId: input.agentId,
      agentType: input.agentType,
      source: input.source,
      tokensUsed: state.tokensUsed,
      wallClockMs: state.wallClockMs,
    });
    return this.toSnapshot(state);
  }


  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    state.updatedAt = new Date().toISOString();
    await this.persistState(state);
    this.appendAudit({
      type: 'goal.continuation',
      goalId: state.goalId,
      turnsUsed: state.turnsUsed,
    });
    return this.toSnapshot(state);
  }

  // --- Internals ---------------------------------------------------------

  private async clearInternal(actor: GoalActor, reason?: string): Promise<void> {
    const state = this.options.readState();
    if (state === undefined) return; // idempotent
    const goalId = state.goalId;
    await this.persistState(undefined);
    this.appendAudit({ type: 'goal.clear', goalId, actor, reason });
  }

  private appendStatusUpdate(state: SessionGoalState, actor: GoalActor, reason?: string): void {
    this.appendAudit({
      type: 'goal.update',
      goalId: state.goalId,
      status: state.status,
      actor,
      reason,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: state.wallClockMs,
    });
  }

  private applyStatus(
    state: SessionGoalState,
    status: GoalStatus,
    actor: GoalActor,
    _reason?: string,
  ): void {
    // Fold the live wall-clock interval into the running total when leaving
    // `active`, and anchor a fresh interval when entering it, so `wallClockMs`
    // stays a correct, persistable total across pause/resume/complete.
    const now = this.nowMs();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
    state.updatedBy = actor;
    state.updatedAt = new Date().toISOString();
  }

  private requireState(): SessionGoalState {
    const state = this.options.readState();
    if (state === undefined) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }


  /**
   * Persists goal state and (unless `silent`) notifies `onGoalUpdated` with the
   * resulting snapshot. `silent` is used for per-step token / wall-clock
   * accounting so the UI is not updated on every step.
   */
  private async persistState(
    state: SessionGoalState | undefined,
    opts: { silent?: boolean; change?: GoalChange } = {},
  ): Promise<void> {
    await this.options.writeState(state);
    if (opts.silent !== true) {
      this.options.onGoalUpdated?.(
        state === undefined ? null : this.toSnapshot(state),
        opts.change,
      );
    }
  }

  /** Counter snapshot for a {@link GoalChange}. */
  private statsOf(state: SessionGoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, this.nowMs()),
    };
  }

  private toSnapshot(state: SessionGoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      startedBy: state.startedBy,
      updatedBy: state.updatedBy,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state, this.nowMs()),
      budget: computeBudgetReport(state, this.nowMs()),
      terminalReason: state.terminalReason,
    };
  }
}

const ALL_GOAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  'active',
  'paused',
  'blocked',
  'complete',
]);

/** Structural validity check for a persisted goal record (used on resume). */
export function isValidGoalState(value: unknown): value is SessionGoalState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Partial<SessionGoalState>;
  return (
    typeof state.goalId === 'string' &&
    state.goalId.length > 0 &&
    typeof state.objective === 'string' &&
    state.objective.length > 0 &&
    typeof state.status === 'string' &&
    ALL_GOAL_STATUSES.has(state.status) &&
    typeof state.turnsUsed === 'number' &&
    typeof state.tokensUsed === 'number' &&
    typeof state.budgetLimits === 'object' &&
    state.budgetLimits !== null
  );
}

/**
 * Live active-pursuit time: the accumulated total plus the in-flight `active`
 * interval. Correct even when read mid-turn (the interval isn't folded into
 * `wallClockMs` until the goal leaves `active`).
 */
export function liveWallClockMs(state: SessionGoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

export function computeBudgetReport(
  state: SessionGoalState,
  now: number = Date.now(),
): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}
