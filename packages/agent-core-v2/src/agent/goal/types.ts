/**
 * `goal` domain (L4) — public goal lifecycle and budget models.
 */

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budget_limited' | 'usage_limited';

export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

/** Controls which goal statuses are eligible for usage accounting.
 *  Mirrors Codex `GoalAccountingMode`. */
export type GoalAccountingMode =
  | 'active_status_only'    // only active (current behavior)
  | 'active_only'           // active + budget_limited
  | 'active_or_complete'    // active + budget_limited + complete
  | 'active_or_stopped';    // all except complete (active + paused + blocked + budget_limited + usage_limited)

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

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
  readonly inputTokensUsed: number;
  readonly outputTokensUsed: number;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  /** Total tokens used (input + output). */
  readonly tokensUsed: number;
  /** Input tokens used (inputOther + inputCacheRead + inputCacheCreation). */
  readonly inputTokensUsed: number;
  /** Output tokens used. */
  readonly outputTokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly blockedStreak?: number;
  /** Epoch milliseconds when the goal was created. */
  readonly createdAt: number;
  /** Epoch milliseconds when the goal was last updated. */
  readonly updatedAt: number;
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CreateGoalInput {
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly replace?: boolean;
}
