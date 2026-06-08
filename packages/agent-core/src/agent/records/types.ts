import type { ContentPart, TokenUsage } from '@moonshot-ai/kosong';

import type { LoopRecordedEvent } from '../../loop';
import type { GoalActor, GoalBudgetLimits, GoalStatus } from '../../session/goal';
import type { ToolStoreUpdate } from '../../tools/store';
import type { CompactionBeginData, CompactionResult } from '../compaction';
import type { AgentConfigUpdateData } from '../config';
import type { ContextMessage, PromptOrigin } from '../context';
import type { PermissionApprovalResultRecord, PermissionMode } from '../permission';
import type { UserToolRegistration } from '../tool';
import type { UsageRecordScope } from '../usage';

// Agent records are the ordered event log used to rebuild agent state on resume.
// Use records, not state.json, when correctness depends on the order in which
// state transitions happened. Each persisted record type must have explicit
// resume semantics in restoreAgentRecord; a write-only record is not persistence.
export interface AgentRecordEvents {
  metadata: {
    protocol_version: string;
    created_at: number;
    app_version?: string;
    resumed?: boolean;
  };

  'turn.prompt': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.steer': {
    input: readonly ContentPart[];
    origin: PromptOrigin;
  };
  'turn.cancel': { turnId?: number };

  'config.update': AgentConfigUpdateData;

  'permission.set_mode': {
    mode: PermissionMode;
  };
  'permission.record_approval_result': PermissionApprovalResultRecord;

  'full_compaction.begin': CompactionBeginData;

  'plan_mode.enter': {
    id: string;
  };
  'plan_mode.cancel': {
    id?: string;
  };
  'plan_mode.exit': {
    id?: string;
  };

  'tools.register_user_tool': UserToolRegistration;
  'tools.unregister_user_tool': {
    name: string;
  };
  'tools.set_active_tools': {
    names: readonly string[];
  };

  'usage.record': {
    model: string;
    usage: TokenUsage;
    usageScope?: UsageRecordScope | undefined;
  };

  'full_compaction.cancel': {};
  'full_compaction.complete': {};
  'micro_compaction.apply': { cutoff: number };

  'context.append_message': { message: ContextMessage };
  'context.append_loop_event': { event: LoopRecordedEvent };
  'context.clear': {};
  'context.apply_compaction': CompactionResult;
  'context.undo': { count: number };

  'tools.update_store': ToolStoreUpdate;

  // Goal-mode audit records. These are an audit trail only: replay MUST NOT
  // rebuild goal state from them — `state.json` (metadata.custom.goal) is the
  // source of truth.
  'goal.create': {
    goalId: string;
    objective: string;
    status: GoalStatus;
    actor: GoalActor;
    budgetLimits: GoalBudgetLimits;
  };
  'goal.update': {
    goalId: string;
    status: GoalStatus;
    actor: GoalActor;
    reason?: string;
    /** Usage counters at the transition, so resume can rebuild the completion card. */
    turnsUsed?: number;
    tokensUsed?: number;
    wallClockMs?: number;
  };
  'goal.account_usage': {
    goalId: string;
    /** Whether the delta came from token accounting or wall-clock accounting. */
    usageKind: 'token' | 'wall_clock';
    delta: number;
    agentId?: string;
    agentType?: string;
    source?: string;
    tokensUsed: number;
    wallClockMs: number;
  };
  'goal.continuation': {
    goalId: string;
    turnsUsed: number;
  };
  'goal.clear': {
    goalId: string;
    actor: GoalActor;
    reason?: string;
  };
}

export type AgentRecord = {
  [K in keyof AgentRecordEvents]: Readonly<AgentRecordEvents[K]> & {
    readonly type: K;
    readonly time?: number;
  };
}[keyof AgentRecordEvents];

export type AgentRecordOf<K extends keyof AgentRecordEvents> = Extract<
  AgentRecord,
  { readonly type: K }
>;

export interface AgentRecordPersistence {
  read(): AsyncIterable<AgentRecord>;
  append(input: AgentRecord): void;
  rewrite(records: readonly AgentRecord[]): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}
