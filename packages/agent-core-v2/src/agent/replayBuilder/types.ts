import type { AgentTaskInfo } from '#/agent/task/task';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import type { AgentConfigData, AgentConfigUpdateData } from '#/agent/profile/profile';
import type { AgentContextData, ContextMessage } from '#/agent/contextMemory/types';
import type { GoalChange, GoalSnapshot } from '#/features/goal/types';
import type { PermissionApprovalResultRecord } from '#/agent/permissionRules/permissionRules';
import type { PermissionData, PermissionMode } from '#/agent/permissionPolicy/types';
import type { PlanData } from '#/features/plan/plan';
import type { ToolInfo } from '#/tool/toolContract';
import type { UsageStatus } from '#/agent/usage/usage';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

type AgentType = 'main' | 'sub';

export type AgentReplayRecordPayload =
  | { type: 'message'; message: ContextMessage }
  | { type: 'compaction'; result?: CompactionResult | 'cancelled'; instruction?: string }
  | {
      type: 'goal_updated';
      snapshot: GoalSnapshot;
      change: GoalChange | { readonly kind: 'created' };
    }
  | { type: 'plan_updated'; enabled: boolean }
  | { type: 'config_updated'; config: AgentConfigUpdateData }
  | { type: 'permission_updated'; mode: PermissionMode }
  | { type: 'approval_result'; record: PermissionApprovalResultRecord };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData;
  readonly swarmMode?: boolean | undefined;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly tasks: readonly AgentTaskInfo[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
