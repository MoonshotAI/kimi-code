import type {
  PermissionMode,
  SessionActivityState,
  TokenUsage,
  UsageStatus,
} from '@moonshot-ai/agent-core-v2';

import type {
  SessionStateGoal,
  SessionStateMessage,
  SessionStateModes,
  SessionStateUsage,
  StepUsage,
} from '../../protocol/messages';

interface GoalSnapshotLike {
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete';
  readonly completionCriterion?: string;
  readonly tokensUsed: number;
  readonly budget: { readonly tokenBudget: number | null };
}

export class SessionStateAggregator {
  private sessionActivity: SessionActivityState | undefined;
  private model: string | undefined;
  private thinkingEffort: string | undefined;
  private permission: 'manual' | 'yolo' | 'auto' | undefined;
  private usage: SessionStateUsage | undefined;
  private contextTokens: number | undefined;
  private maxContextTokens: number | undefined;
  private goal: SessionStateGoal | null | undefined;
  private planMode = false;
  private swarmMode = false;
  private planRevision: { path: string; version: number } | undefined;
  private lastEmittedJson: string | undefined;

  feedSessionActivity(state: SessionActivityState): void {
    this.sessionActivity = state;
  }

  feedMainStatus(event: {
    model?: string;
    thinkingEffort?: string;
    usage?: UsageStatus;
    contextTokens?: number;
    maxContextTokens?: number;
    planMode?: boolean;
    swarmMode?: boolean;
    permission?: 'manual' | 'yolo' | 'auto';
  }): void {
    if (event.model !== undefined) this.model = event.model;
    if (event.thinkingEffort !== undefined) this.thinkingEffort = event.thinkingEffort;
    if (event.usage !== undefined) this.usage = usageToWire(event.usage);
    if (event.contextTokens !== undefined) this.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) this.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) this.planMode = event.planMode;
    if (event.swarmMode !== undefined) this.swarmMode = event.swarmMode;
    if (event.permission !== undefined) this.permission = event.permission;
  }

  feedSeed(seed: {
    model?: string;
    thinkingEffort?: string;
    usage?: UsageStatus;
    contextTokens?: number;
    maxContextTokens?: number;
    permission?: PermissionMode;
  }): void {
    if (seed.model !== undefined) this.model = seed.model;
    if (seed.thinkingEffort !== undefined) this.thinkingEffort = seed.thinkingEffort;
    if (seed.usage !== undefined) this.usage = usageToWire(seed.usage);
    if (seed.contextTokens !== undefined) this.contextTokens = seed.contextTokens;
    if (seed.maxContextTokens !== undefined) this.maxContextTokens = seed.maxContextTokens;
    if (seed.permission !== undefined) this.permission = seed.permission;
  }

  feedGoal(snapshot: GoalSnapshotLike | null): void {
    this.goal =
      snapshot === null
        ? null
        : {
            objective: snapshot.objective,
            status: snapshot.status,
            completion_criterion: snapshot.completionCriterion,
            budget_used: snapshot.tokensUsed,
            budget_limit: snapshot.budget.tokenBudget ?? undefined,
          };
  }

  feedPlanRevision(path: string, version: number): void {
    this.planRevision = { path, version };
  }

  snapshot(sessionId: string): SessionStateMessage {
    return this.build(sessionId);
  }

  changed(sessionId: string): SessionStateMessage | undefined {
    const next = this.build(sessionId);
    const { timestamp: _timestamp, ...comparable } = next;
    const json = JSON.stringify(comparable);
    if (json === this.lastEmittedJson) return undefined;
    this.lastEmittedJson = json;
    return next;
  }

  private build(sessionId: string): SessionStateMessage {
    const busy = this.sessionActivity?.busy ?? false;
    const modes = this.computeModes();
    return {
      type: 'session.state',
      session_id: sessionId,
      timestamp: Date.now(),
      status: busy ? 'running' : 'idle',
      pending_interaction: this.sessionActivity?.pendingInteraction,
      model: this.model,
      thinking_effort: this.thinkingEffort,
      permission: this.permission,
      usage: this.usage,
      context_tokens: this.contextTokens,
      max_context_tokens: this.maxContextTokens,
      goal: this.goal ?? undefined,
      modes,
    };
  }

  private computeModes(): SessionStateModes | undefined {
    const modes: SessionStateModes = {};
    if (this.planMode) {
      modes.plan = {
        review_path: this.planRevision?.path,
        version: this.planRevision?.version,
      };
    }
    if (this.swarmMode) modes.swarm = {};
    return modes.plan === undefined && modes.swarm === undefined ? undefined : modes;
  }
}

function usageToWire(usage: UsageStatus): SessionStateUsage {
  return {
    by_model:
      usage.byModel === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(usage.byModel).map(([model, u]) => [model, toSnakeUsage(u)]),
          ),
    current_turn: usage.currentTurn === undefined ? undefined : toSnakeUsage(usage.currentTurn),
    total: usage.total === undefined ? undefined : toSnakeUsage(usage.total),
  };
}

function toSnakeUsage(usage: TokenUsage): StepUsage {
  return {
    input_other: usage.inputOther,
    output: usage.output,
    input_cache_read: usage.inputCacheRead,
    input_cache_creation: usage.inputCacheCreation,
  };
}
