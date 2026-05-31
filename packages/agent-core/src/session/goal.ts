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
 * slash command, model tools, continuation loop, and evaluator depend on.
 */

/**
 * Default malfunction guard: stop a goal after this many *consecutive evaluator
 * failures* (invalid JSON / judge errors). This is not a work cap — it only
 * protects against a broken evaluator looping forever. Work limits (turns,
 * tokens, time) have no defaults; an unbounded goal runs until the evaluator
 * judges it terminal, and any stop-clause lives in the objective.
 */
export const DEFAULT_GOAL_FAILURE_TURN_LIMIT = 3;

/**
 * Default no-progress guard: block a goal after this many *consecutive
 * evaluator `no_progress` verdicts*. Unlike work caps (turns/tokens/time, which
 * have no defaults), this one defaults on so an unclear or unachievable
 * objective (e.g. "prove me wrong", "1 + 1 = 3") cannot spin forever — it lands
 * in `blocked` after a few stuck turns and waits for the user to resume or
 * refine it. Matches Codex's "blocked after three turns" behavior.
 */
export const DEFAULT_GOAL_NO_PROGRESS_TURN_LIMIT = 3;

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
 * | `active`   | yes       | (running) | createGoal / resumeGoal         | The continuation loop may drive work.            |
 * | `paused`   | yes       | yes       | pauseGoal / pauseOnInterrupt /  | User (or interrupt) stopped it; intact.          |
 * |            |           |           | normalizeMetadata               |                                                  |
 * | `blocked`  | yes       | yes       | markBlocked                     | The system stopped it for some `reason`.         |
 * | `complete` | no        | —         | markComplete                    | Success — announced in a message, then cleared.  |
 *
 * Only an `active` goal advances: accounting, evaluator runs, and continuation
 * all gate on `status === 'active'`. `paused` and `blocked` are the same kind of
 * thing — "the loop is not driving, but the goal is intact and resumable via
 * `/goal resume`" — differing only in *who* stopped it (the user vs the system)
 * and the human-readable `reason`. There is no separate `impossible`,
 * `budget_limited`, `error`, or `cancelled` status: an unachievable goal, an
 * exhausted budget, a runtime/evaluator failure all become `blocked(+reason)`,
 * and "cancel" is just `clearGoal` (the record is discarded). See
 * {@link SessionGoalStore} for the setters and the per-status notes below.
 */
export type GoalStatus =
  /**
   * The goal is live and the continuation loop may drive work toward it. Set on
   * creation (`createGoal`) and when a paused/blocked goal is resumed
   * (`resumeGoal`). The only status under which turns/tokens/wall-clock are
   * accounted and the evaluator runs.
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
   * `terminalReason`: the evaluator judged it cannot proceed (an external
   * blocker, or an objective it deems unachievable); no progress was made for
   * `noProgressTurnLimit` consecutive turns; a configured hard budget
   * (token/turn/time/step) was reached; or a runtime/evaluator failure occurred.
   * Set by `markBlocked` (from the continuation controller and the turn catch).
   * Resumable like `paused` — `/goal resume` re-activates it; a plain message
   * just runs one normal turn without reactivating the loop. Editing the goal
   * while blocked takes effect on the next turn.
   */
  | 'blocked'
  /**
   * Success: the independent evaluator judged the objective met. Set by
   * `markComplete` from the continuation controller. This status is **transient**
   * — `markComplete` emits the completion, appends a completion message, and then
   * clears the durable record, so the goal box disappears and `complete` never
   * rests on disk (like the old `cancelled` pattern, but with an announcement).
   */
  | 'complete';

/** Who performed a goal action. `cleared` is an audit action, not a status. */
export type GoalActor = 'user' | 'model' | 'evaluator' | 'continuation' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
  readonly noProgressTurnLimit?: number;
  readonly failureTurnLimit?: number;
}

/** A small piece of evidence attached to a model report or evaluator verdict. */
export interface GoalEvidence {
  readonly summary: string;
  readonly detail?: string;
  readonly source?: string;
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
  consecutiveNoProgressTurns: number;
  consecutiveFailureTurns: number;
  tokensUsed: number;
  wallClockMs: number;
  budgetLimits: GoalBudgetLimits;
  lastModelReportStatus?: string;
  lastModelReportReason?: string;
  lastModelReportEvidence?: readonly GoalEvidence[];
  lastEvaluatorVerdict?: string;
  lastEvaluatorReason?: string;
  lastEvidence?: readonly GoalEvidence[];
  terminalReason?: string;
  terminalEvidence?: readonly GoalEvidence[];
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
  readonly noProgressTurnLimit: number | null;
  readonly failureTurnLimit: number | null;
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
  readonly consecutiveNoProgressTurns: number;
  readonly consecutiveFailureTurns: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly lastModelReportStatus?: string;
  readonly lastModelReportReason?: string;
  readonly lastModelReportEvidence?: readonly GoalEvidence[];
  readonly lastEvaluatorVerdict?: string;
  readonly lastEvaluatorReason?: string;
  readonly lastEvidence?: readonly GoalEvidence[];
  readonly terminalReason?: string;
  readonly terminalEvidence?: readonly GoalEvidence[];
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
 * Describes what changed on a `goal.updated` event, so the UI can render a
 * transcript marker (lifecycle/verdict) or a completion card (terminal). Absent
 * for snapshot-only refreshes (e.g. a turn increment that only moves the badge).
 */
export type GoalChangeKind = 'lifecycle' | 'verdict' | 'terminal';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly verdict?: string;
  readonly reason?: string;
  readonly evidence?: readonly GoalEvidence[];
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

export interface UpdateGoalControlInput extends GoalControlInput {}

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
}

/**
 * Single durable owner of the current goal.
 *
 * Lifecycle rules (see the {@link GoalStatus} union for the full per-status map):
 * - Success: only the continuation controller calls `markComplete`, carrying the
 *   independent evaluator's `complete` verdict. The model's own `UpdateGoal` tool
 *   call is recorded as a *report* (evidence), never a direct status change — see
 *   `recordModelReport`. `markComplete` announces, then clears the record.
 * - System stop: `markBlocked(reason)` sets `blocked` for any reason the system
 *   stops pursuing — evaluator `blocked` verdict, no-progress limit, a hard budget,
 *   a `maxStepsPerTurn` cap, or a runtime/evaluator failure. `blocked` is resumable.
 * - User stop: `pauseGoal` and the interrupt path `pauseOnInterrupt` set `paused`
 *   (resumable); `clearGoal` discards the record entirely (no status — this is
 *   what `/goal cancel` and `/goal clear` both do).
 * - An aborted turn (Esc / shutdown) is not terminal: it pauses the goal, so it
 *   stays resumable — mirroring how `normalizeMetadata` demotes an `active` goal
 *   to `paused` on session resume.
 */
export class SessionGoalStore {
  /** Audit records queued until the main-agent sink becomes available. */
  private readonly pending: AgentRecord[] = [];

  constructor(private readonly options: SessionGoalStoreOptions) {}

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
      consecutiveNoProgressTurns: 0,
      consecutiveFailureTurns: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: this.normalizeBudgetLimits(input.budgetLimits),
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
    // Clear the stop reason from the previous paused/blocked transition; the
    // goal is being pursued again.
    state.terminalReason = undefined;
    this.applyStatus(state, 'active', actor, input.reason);
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async clearGoal(input: GoalControlInput = {}): Promise<void> {
    await this.clearInternal(input.actor ?? 'user', input.reason);
  }

  /**
   * Discards the current goal (`/goal cancel`). There is no `cancelled` status —
   * cancel is just a clear that returns the snapshot it removed, so callers can
   * report what was cancelled. Throws if no goal exists.
   */
  async cancelGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    await this.clearInternal(input.actor ?? 'user', input.reason);
    return snapshot;
  }

  // --- Terminal outcomes (system-decided) -------------------------------

  /**
   * Marks the goal `blocked`: the system stopped pursuing it for `reason` — an
   * evaluator `blocked` verdict (incl. objectives it deems unachievable), the
   * no-progress limit, a hard budget, a `maxStepsPerTurn` cap, or a
   * runtime/evaluator failure. `blocked` is persisted and **resumable** via
   * `/goal resume` (it is a sibling of `paused`, not a dead end), so it emits a
   * `lifecycle` change. No-ops for a goal that is missing or not active, so a
   * user pause / clear is never overwritten.
   */
  async markBlocked(
    input: { actor?: GoalActor; reason?: string; evidence?: readonly GoalEvidence[] } = {},
  ): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const actor = input.actor ?? 'runtime';
    this.applyStatus(state, 'blocked', actor, input.reason);
    state.terminalReason = input.reason;
    if (input.evidence !== undefined) {
      state.terminalEvidence = input.evidence;
      state.lastEvidence = input.evidence;
    }
    await this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, evidence: input.evidence },
    });
    this.appendStatusUpdate(state, actor, input.reason, input.evidence);
    return this.toSnapshot(state);
  }

  /**
   * Records goal success, then clears the durable record. `complete` is
   * transient: this emits a terminal `complete` change carrying the final stats
   * (so the UI/caller can render the outcome) WITHOUT writing `complete` to disk,
   * then clears the goal so the box disappears. The continuation controller is
   * responsible for the user-facing completion message. Returns the final
   * snapshot (status `complete`) so the caller can build that message. No-ops for
   * a goal that is missing or not active.
   */
  async markComplete(
    input: { actor?: GoalActor; reason?: string; evidence?: readonly GoalEvidence[] } = {},
  ): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const actor = input.actor ?? 'evaluator';
    this.applyStatus(state, 'complete', actor, input.reason);
    state.terminalReason = input.reason;
    if (input.evidence !== undefined) {
      state.terminalEvidence = input.evidence;
      state.lastEvidence = input.evidence;
    }
    const snapshot = this.toSnapshot(state);
    // Audit + notify the UI of completion (with final stats) directly, without
    // persisting `complete` to disk...
    this.appendStatusUpdate(state, actor, input.reason, input.evidence);
    this.options.onGoalUpdated?.(snapshot, {
      kind: 'terminal',
      status: 'complete',
      reason: input.reason,
      evidence: input.evidence,
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

  async recordWallClockUsage(input: { wallClockMs: number }): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    const delta = Math.max(0, input.wallClockMs);
    state.wallClockMs += delta;
    state.updatedAt = new Date().toISOString();
    await this.persistState(state, { silent: true }); // per-step: no UI update
    this.appendAudit({
      type: 'goal.account_usage',
      goalId: state.goalId,
      usageKind: 'wall_clock',
      delta,
      source: 'main_wall_clock',
      tokensUsed: state.tokensUsed,
      wallClockMs: state.wallClockMs,
    });
    return this.toSnapshot(state);
  }

  async incrementTurn(input: { evidence?: readonly GoalEvidence[] } = {}): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    state.updatedAt = new Date().toISOString();
    if (input.evidence !== undefined) state.lastEvidence = input.evidence;
    await this.persistState(state);
    this.appendAudit({
      type: 'goal.continuation',
      goalId: state.goalId,
      turnsUsed: state.turnsUsed,
    });
    return this.toSnapshot(state);
  }

  async recordModelReport(input: {
    requestedStatus: string;
    reason?: string;
    evidence?: readonly GoalEvidence[];
  }): Promise<GoalSnapshot> {
    const state = this.requireActiveState();
    state.lastModelReportStatus = input.requestedStatus;
    state.lastModelReportReason = input.reason;
    state.lastModelReportEvidence = input.evidence;
    state.updatedAt = new Date().toISOString();
    // recordModelReport never changes status; it stores the model's requested
    // terminal state as evidence for the continuation controller / evaluator.
    await this.persistState(state);
    this.appendAudit({
      type: 'goal.report',
      goalId: state.goalId,
      requestedStatus: input.requestedStatus,
      reason: input.reason,
      evidence: input.evidence,
    });
    return this.toSnapshot(state);
  }

  async recordEvaluatorVerdict(input: {
    verdict: string;
    reason?: string;
    evidence?: readonly GoalEvidence[];
  }): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    state.lastEvaluatorVerdict = input.verdict;
    state.lastEvaluatorReason = input.reason;
    if (input.evidence !== undefined) state.lastEvidence = input.evidence;
    if (input.verdict === 'no_progress') {
      state.consecutiveNoProgressTurns += 1;
    } else {
      state.consecutiveNoProgressTurns = 0;
    }
    // A produced verdict means the evaluator ran successfully.
    state.consecutiveFailureTurns = 0;
    state.updatedAt = new Date().toISOString();
    await this.persistState(state, {
      change: {
        kind: 'verdict',
        verdict: input.verdict,
        reason: input.reason,
        evidence: input.evidence,
      },
    });
    this.appendAudit({
      type: 'goal.evaluate',
      goalId: state.goalId,
      verdict: input.verdict,
      reason: input.reason,
      evidence: input.evidence,
    });
    return this.toSnapshot(state);
  }

  /**
   * Records a failed evaluator run (invalid JSON or a thrown evaluator call).
   * Increments the consecutive-failure counter that `failureTurnLimit` checks.
   */
  async recordEvaluatorFailure(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    if (state === undefined || state.status !== 'active') return null;
    state.consecutiveFailureTurns += 1;
    state.updatedAt = new Date().toISOString();
    await this.persistState(state);
    this.appendAudit({
      type: 'goal.evaluate',
      goalId: state.goalId,
      verdict: 'error',
      reason: input.reason,
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

  private appendStatusUpdate(
    state: SessionGoalState,
    actor: GoalActor,
    reason?: string,
    evidence?: readonly GoalEvidence[],
  ): void {
    this.appendAudit({
      type: 'goal.update',
      goalId: state.goalId,
      status: state.status,
      actor,
      reason,
      evidence,
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

  private requireActiveState(): SessionGoalState {
    const state = this.requireState();
    if (state.status !== 'active') {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No active goal');
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
      wallClockMs: state.wallClockMs,
    };
  }

  private normalizeBudgetLimits(input?: GoalBudgetLimits): GoalBudgetLimits {
    // No default *work* caps (turns / tokens / time): an unbounded goal runs
    // until the evaluator judges it complete. Two guards default on, though, so
    // an unclear/unachievable goal cannot spin forever: the no-progress limit
    // (blocks after N stuck turns) and the evaluator malfunction limit.
    const limits: GoalBudgetLimits = {
      ...input,
      noProgressTurnLimit: input?.noProgressTurnLimit ?? DEFAULT_GOAL_NO_PROGRESS_TURN_LIMIT,
      failureTurnLimit: input?.failureTurnLimit ?? DEFAULT_GOAL_FAILURE_TURN_LIMIT,
    };
    return limits;
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
      consecutiveNoProgressTurns: state.consecutiveNoProgressTurns,
      consecutiveFailureTurns: state.consecutiveFailureTurns,
      tokensUsed: state.tokensUsed,
      wallClockMs: state.wallClockMs,
      budget: computeBudgetReport(state),
      lastModelReportStatus: state.lastModelReportStatus,
      lastModelReportReason: state.lastModelReportReason,
      lastModelReportEvidence: state.lastModelReportEvidence,
      lastEvaluatorVerdict: state.lastEvaluatorVerdict,
      lastEvaluatorReason: state.lastEvaluatorReason,
      lastEvidence: state.lastEvidence,
      terminalReason: state.terminalReason,
      terminalEvidence: state.terminalEvidence,
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

export function computeBudgetReport(state: SessionGoalState): GoalBudgetReport {
  const limits = state.budgetLimits;
  const tokenBudget = limits.tokenBudget ?? null;
  const turnBudget = limits.turnBudget ?? null;
  const wallClockBudgetMs = limits.wallClockBudgetMs ?? null;

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && state.wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - state.wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    noProgressTurnLimit: limits.noProgressTurnLimit ?? null,
    failureTurnLimit: limits.failureTurnLimit ?? null,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}
