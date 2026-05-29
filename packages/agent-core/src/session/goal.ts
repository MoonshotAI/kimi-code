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

/** Conservative default safety cap applied when a goal provides no turn budget. */
export const DEFAULT_GOAL_TURN_BUDGET = 20;

/** Maximum objective length in characters. */
export const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'complete'
  | 'blocked'
  | 'impossible'
  | 'budget_limited'
  | 'interrupted'
  | 'error'
  | 'cancelled';

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

const TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'complete',
  'blocked',
  'impossible',
  'budget_limited',
  'interrupted',
  'error',
  'cancelled',
]);

/** Terminal statuses an evaluator or continuation controller may set via `updateGoal`. */
const UPDATABLE_TERMINAL_STATUSES: ReadonlySet<GoalStatus> = new Set<GoalStatus>([
  'complete',
  'blocked',
  'impossible',
]);

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_STATUSES.has(status);
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
}

/**
 * Single durable owner of the current goal.
 *
 * Lifecycle rules:
 * - `updateGoal()` only sets `complete`, `blocked`, or `impossible` (model/evaluator
 *   self-reported terminal states confirmed by the runtime).
 * - Runtime owns `budget_limited`, `interrupted`, `error` via the `mark*` methods.
 * - User owns `paused`, `cancelled`, and the `cleared` audit action.
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
   * `paused`, requiring `/goal resume` to restart work. Paused and terminal
   * goals are preserved. Malformed and stale-`cancelled` records are removed.
   */
  async normalizeMetadata(): Promise<void> {
    const state = this.options.readState();
    if (state === undefined) return;

    if (!isValidGoalState(state)) {
      await this.options.writeState(undefined);
      return;
    }

    // A `cancelled` status persisted to disk means clear did not complete; drop it.
    if (state.status === 'cancelled') {
      await this.options.writeState(undefined);
      return;
    }

    if (state.status === 'active') {
      this.applyStatus(state, 'paused', 'runtime', 'Paused after session resume');
      await this.options.writeState(state);
      this.appendStatusUpdate(state, 'runtime', 'Paused after session resume');
      return;
    }

    // Paused and terminal goals are left intact.
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
      const blocking = existing.status === 'active' || existing.status === 'paused';
      if (blocking && input.replace !== true) {
        throw new KimiError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal is already active; use replace to start a new one',
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

    await this.options.writeState(state);
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
    await this.options.writeState(state);
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused') {
      throw new KimiError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    const actor = input.actor ?? 'user';
    this.applyStatus(state, 'active', actor, input.reason);
    await this.options.writeState(state);
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async cancelGoal(input: GoalControlInput = {}): Promise<GoalSnapshot> {
    const state = this.requireState();
    const actor = input.actor ?? 'user';
    this.applyStatus(state, 'cancelled', actor, input.reason);
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    // Persist the cancelled transition and audit it, then clear the goal.
    await this.options.writeState(state);
    this.appendStatusUpdate(state, actor, input.reason);
    await this.clearInternal(actor, input.reason);
    return snapshot;
  }

  async clearGoal(input: GoalControlInput = {}): Promise<void> {
    await this.clearInternal(input.actor ?? 'user', input.reason);
  }

  // --- Model / evaluator confirmed terminal states ----------------------

  async updateGoal(input: {
    status: GoalStatus;
    actor?: GoalActor;
    reason?: string;
    evidence?: readonly GoalEvidence[];
  }): Promise<GoalSnapshot> {
    if (!UPDATABLE_TERMINAL_STATUSES.has(input.status)) {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `updateGoal cannot set status "${input.status}"; allowed: complete, blocked, impossible`,
      );
    }
    const state = this.requireState();
    const actor = input.actor ?? 'evaluator';
    this.applyStatus(state, input.status, actor, input.reason);
    state.terminalReason = input.reason;
    if (input.evidence !== undefined) {
      state.terminalEvidence = input.evidence;
      state.lastEvidence = input.evidence;
    }
    await this.options.writeState(state);
    this.appendStatusUpdate(state, actor, input.reason, input.evidence);
    return this.toSnapshot(state);
  }

  // --- Runtime-owned terminal states ------------------------------------

  async markBudgetLimited(input: {
    reason?: string;
    evidence?: readonly GoalEvidence[];
  } = {}): Promise<GoalSnapshot | null> {
    return this.markRuntimeTerminal('budget_limited', input.reason, input.evidence);
  }

  async markInterrupted(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.markRuntimeTerminal('interrupted', input.reason);
  }

  async markError(input: { reason?: string } = {}): Promise<GoalSnapshot | null> {
    return this.markRuntimeTerminal('error', input.reason);
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
    await this.options.writeState(state);
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
    await this.options.writeState(state);
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
    await this.options.writeState(state);
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
    await this.options.writeState(state);
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
    await this.options.writeState(state);
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
    await this.options.writeState(state);
    this.appendAudit({
      type: 'goal.evaluate',
      goalId: state.goalId,
      verdict: 'error',
      reason: input.reason,
    });
    return this.toSnapshot(state);
  }

  // --- Internals ---------------------------------------------------------

  private async markRuntimeTerminal(
    status: GoalStatus,
    reason?: string,
    evidence?: readonly GoalEvidence[],
  ): Promise<GoalSnapshot | null> {
    const state = this.options.readState();
    // Do not overwrite paused, cancelled, or already-terminal states.
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, status, 'runtime', reason);
    state.terminalReason = reason;
    if (evidence !== undefined) {
      state.terminalEvidence = evidence;
      state.lastEvidence = evidence;
    }
    await this.options.writeState(state);
    this.appendStatusUpdate(state, 'runtime', reason, evidence);
    return this.toSnapshot(state);
  }

  private async clearInternal(actor: GoalActor, reason?: string): Promise<void> {
    const state = this.options.readState();
    if (state === undefined) return; // idempotent
    const goalId = state.goalId;
    await this.options.writeState(undefined);
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

  private normalizeBudgetLimits(input?: GoalBudgetLimits): GoalBudgetLimits {
    const limits: GoalBudgetLimits = {
      ...input,
      turnBudget: input?.turnBudget ?? DEFAULT_GOAL_TURN_BUDGET,
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
  'complete',
  'blocked',
  'impossible',
  'budget_limited',
  'interrupted',
  'error',
  'cancelled',
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
