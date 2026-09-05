import type {
  AgentPhase,
  SessionModes,
  SessionStateMessage,
  SessionStateUsage,
  StepUsage,
} from '../../protocol/v2/messages/index';

export interface ComposerActivityFact {
  busy: boolean;
  mainTurnActive: boolean;
  pendingInteraction: 'none' | 'approval' | 'question';
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface ComposerTurnFact {
  turnId: number;
  step: number;
  phase: 'running' | 'streaming' | 'tool_call' | 'retrying';
  since: number;
  pendingApprovals?: readonly unknown[];
}

export interface ComposerAgentActivityFact {
  lifecycle: 'ready' | 'disposed';
  turn?: ComposerTurnFact;
}

export interface ComposerStatusFact {
  model?: string;
  thinkingEffort?: string;
  contextTokens?: number;
  maxContextTokens?: number;
  usage?: {
    byModel?: Record<string, unknown>;
    total?: unknown;
    currentTurn?: unknown;
  };
}

export interface ComposerGoalFact {
  objective: string;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  completionCriterion?: string;
  budgetUsed?: number;
  budgetLimit?: number;
}

export interface SessionFactsPatch {
  activity?: ComposerActivityFact;
  agentActivity?: ComposerAgentActivityFact;
  status?: ComposerStatusFact;
  permission?: 'manual' | 'yolo' | 'auto';
  goal?: ComposerGoalFact | null;
  modes?: SessionModes;
}

function toStepUsage(usage: unknown): StepUsage | undefined {
  const u = usage as
    | { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number }
    | undefined;
  if (!u) return undefined;
  return {
    input_other: u.inputOther ?? 0,
    output: u.output ?? 0,
    input_cache_read: u.inputCacheRead ?? 0,
    input_cache_creation: u.inputCacheCreation ?? 0,
  };
}

export class SessionStateComposer {
  private activity?: ComposerActivityFact;
  private agentActivity?: ComposerAgentActivityFact;
  private status?: ComposerStatusFact;
  private permission?: 'manual' | 'yolo' | 'auto';
  private goal?: ComposerGoalFact | null;
  private modes?: SessionModes;
  private lastJson?: string;

  constructor(private readonly sessionId: string) {}

  hasFacts(): boolean {
    return (
      this.activity?.busy === true ||
      this.agentActivity?.turn !== undefined ||
      this.status !== undefined ||
      this.goal !== undefined ||
      this.modes !== undefined
    );
  }

  apply(patch: SessionFactsPatch): void {
    if (patch.activity !== undefined) this.activity = patch.activity;
    if (patch.agentActivity !== undefined) this.agentActivity = patch.agentActivity;
    if (patch.status !== undefined) this.status = { ...this.status, ...patch.status };
    if (patch.permission !== undefined) this.permission = patch.permission;
    if (patch.goal !== undefined) this.goal = patch.goal;
    this.modes = patch.modes;
  }

  compose(
    time: number | undefined,
    resolveStepId?: (engineTurnId: number, step: number) => string | undefined,
  ): SessionStateMessage | null {
    const timestamp = new Date(time ?? 0).toISOString();
    const turn = this.agentActivity?.turn;
    let phase: AgentPhase | undefined;
    if (turn) {
      const pendingApprovals = turn.pendingApprovals?.length ?? 0;
      if (pendingApprovals > 0 || this.activity?.pendingInteraction === 'approval') {
        phase = { kind: 'awaiting_approval', turn_id: turn.turnId, step: turn.step, since: turn.since };
      } else if (this.activity?.pendingInteraction === 'question') {
        phase = { kind: 'awaiting_question', turn_id: turn.turnId, step: turn.step, since: turn.since };
      } else {
        phase = {
          kind: 'running',
          turn_id: turn.turnId,
          step: turn.step,
          step_id: resolveStepId?.(turn.turnId, turn.step),
          since: turn.since,
        };
      }
    } else if (!this.activity?.busy) {
      phase = this.agentActivity ? { kind: 'idle' } : undefined;
    }
    let usage: SessionStateUsage | undefined;
    if (this.status?.usage) {
      usage = {
        by_model: mapByModel(this.status.usage.byModel),
        current_turn: toStepUsage(this.status.usage.currentTurn),
        total: toStepUsage(this.status.usage.total),
      };
    }
    const lifecycle = this.agentActivity?.lifecycle;
    const busy = this.activity?.busy ?? false;
    const msg: SessionStateMessage = {
      type: 'session.state',
      session_id: this.sessionId,
      timestamp,
      busy,
      main_turn_active: this.activity?.mainTurnActive ?? false,
      pending_interaction: this.activity?.pendingInteraction,
      last_turn_reason: this.activity?.lastTurnReason,
      activity: lifecycle === 'disposed' ? 'disposing' : busy || turn ? 'turn' : 'idle',
      phase,
      model: this.status?.model,
      thinking_effort: this.status?.thinkingEffort,
      permission: this.permission,
      usage,
      context_tokens: this.status?.contextTokens,
      max_context_tokens: this.status?.maxContextTokens,
      goal: this.goal
        ? {
            objective: this.goal.objective,
            status: this.goal.status,
            completion_criterion: this.goal.completionCriterion,
            budget_used: this.goal.budgetUsed,
            budget_limit: this.goal.budgetLimit,
          }
        : undefined,
      modes: this.modes,
    };
    const json = JSON.stringify(msg);
    if (json === this.lastJson) return null;
    this.lastJson = json;
    return msg;
  }
}

function mapByModel(byModel: Record<string, unknown> | undefined): Record<string, StepUsage> | undefined {
  if (!byModel) return undefined;
  const out: Record<string, StepUsage> = {};
  for (const [model, usage] of Object.entries(byModel)) {
    const mapped = toStepUsage(usage);
    if (mapped) out[model] = mapped;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
