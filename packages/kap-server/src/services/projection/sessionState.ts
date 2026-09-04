import type {
  AgentActivityState,
  PermissionMode,
  SessionActivityState,
  TokenUsage,
  UsageStatus,
} from '@moonshot-ai/agent-core-v2';

import type {
  AgentPhase,
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
  private mainActivity: AgentActivityState | undefined;
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

  feedMainActivity(state: AgentActivityState): void {
    this.mainActivity = state;
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
    const activity = this.computeActivity(busy);
    const contextUsage =
      this.contextTokens !== undefined &&
      this.maxContextTokens !== undefined &&
      this.maxContextTokens > 0
        ? this.contextTokens / this.maxContextTokens
        : undefined;
    const modes = this.computeModes();
    return {
      type: 'session.state',
      session_id: sessionId,
      timestamp: new Date().toISOString(),
      busy,
      main_turn_active: this.sessionActivity?.mainTurnActive ?? false,
      pending_interaction: this.sessionActivity?.pendingInteraction,
      last_turn_reason: this.mainActivity?.lastTurn?.reason ?? this.sessionActivity?.lastTurnReason,
      activity,
      phase: this.mainActivity === undefined ? undefined : toAgentPhase(this.mainActivity),
      model: this.model,
      thinking_effort: this.thinkingEffort,
      permission: this.permission,
      usage: this.usage,
      context_tokens: this.contextTokens,
      max_context_tokens: this.maxContextTokens,
      context_usage: contextUsage,
      goal: this.goal ?? undefined,
      modes,
    };
  }

  private computeActivity(busy: boolean): 'idle' | 'turn' | 'disposing' | 'unknown' {
    if (this.mainActivity?.lifecycle === 'disposed') return 'disposing';
    if (this.sessionActivity === undefined) return 'unknown';
    return busy ? 'turn' : 'idle';
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

export function toAgentPhase(state: AgentActivityState): AgentPhase | undefined {
  const { lifecycle, turn, lastTurn } = state;
  if (turn === undefined) {
    if (lifecycle === 'ready' && lastTurn !== undefined) {
      return {
        kind: 'ended',
        turn_id: lastTurn.turnId,
        reason: lastTurn.reason,
        duration_ms: lastTurn.durationMs,
        at: lastTurn.at,
      };
    }
    if (lifecycle === 'ready') return { kind: 'idle' };
    return undefined;
  }
  const stepId = `t${turn.turnId}.${turn.step}`;
  if (turn.pendingApprovals.length > 0) {
    const latest = turn.pendingApprovals.at(-1)!;
    return {
      kind: 'awaiting_approval',
      turn_id: turn.turnId,
      step: turn.step > 0 ? turn.step : undefined,
      approval: { approval_id: latest.approvalId, tool_call_id: latest.toolCallId },
      since: latest.since,
    };
  }
  if (turn.ending && turn.endingReason !== undefined) {
    return {
      kind: 'interrupted',
      turn_id: turn.turnId,
      step: turn.step > 0 ? turn.step : undefined,
      reason: turn.endingReason,
      at: turn.since,
    };
  }
  switch (turn.phase) {
    case 'running':
      return { kind: 'running', turn_id: turn.turnId, step: turn.step, step_id: stepId, since: turn.since };
    case 'streaming': {
      const latestTool = turn.activeToolCalls.at(-1);
      return {
        kind: 'streaming',
        turn_id: turn.turnId,
        step: turn.step,
        step_id: stepId,
        stream: turn.stream ?? 'assistant',
        tool_call_id: turn.stream === 'tool_call' ? latestTool?.toolCallId : undefined,
        tool_name: turn.stream === 'tool_call' ? latestTool?.name : undefined,
        since: turn.since,
      };
    }
    case 'retrying':
      return {
        kind: 'retrying',
        turn_id: turn.turnId,
        step: turn.step,
        step_id: stepId,
        failed_attempt: turn.retry?.failedAttempt ?? 0,
        next_attempt: turn.retry?.nextAttempt ?? 0,
        max_attempts: turn.retry?.maxAttempts ?? 0,
        delay_ms: turn.retry?.delayMs ?? 0,
        error_name: turn.retry?.errorName,
        status_code: turn.retry?.statusCode,
        since: turn.since,
      };
    case 'tool_call': {
      const latest = turn.activeToolCalls.at(-1);
      return {
        kind: 'tool_call',
        turn_id: turn.turnId,
        step: turn.step,
        tool_call_id: latest?.toolCallId ?? '',
        name: latest?.name ?? '',
        since: latest?.since ?? turn.since,
      };
    }
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
