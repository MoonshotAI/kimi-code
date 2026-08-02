/**
 * Wire types — local mirror of the retired `agent-core` RPC/business shapes
 * that the SDK exposes to consumers. Type-only: no runtime logic. These keep
 * the SDK's public wire contract stable while the engine is Rust.
 *
 * Sources: agent-core rpc/core-api.ts, agent/context/types.ts,
 * agent/background/*, agent/goal, agent/cron, mcp/global-config.
 */

import type { Message, ModelCapability, ProviderConfig } from '@moonshot-ai/kosong';

import type { McpServerConfig } from './config-schema';

// ── Background tasks ─────────────────────────────────────────────

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

// ── Context messages ─────────────────────────────────────────────

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: string | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type ContextMessage = Message & {
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly toolCallDisplays?: Record<string, unknown>;
  readonly note?: string;
};

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

export type AgentType = 'main' | 'sub' | 'independent';

export interface AgentConfigData {
  readonly cwd: string;
  readonly provider?: ProviderConfig;
  readonly modelAlias?: string;
  readonly modelCapabilities: ModelCapability;
  readonly profileName?: string;
  readonly thinkingEffort: string;
  readonly systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingEffort: string;
  systemPrompt: string;
}>;

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: unknown;
  readonly swarmMode?: boolean | undefined;
  readonly usage: unknown;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly BackgroundTaskInfo[];
}

// ── Goals ────────────────────────────────────────────────────────

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
  | 'budget_limited'
  | 'usage_limited';

export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

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
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
  readonly blockedStreak?: number;
  readonly createdAt: number;
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

export type GoalChangeKind = 'created' | 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

// ── Compaction ─────────────────────────────────────────────────

export interface CompactionResult {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

// ── Permission ─────────────────────────────────────────────────

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface PermissionData {
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
}

export interface ApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

// ── Replay records ─────────────────────────────────────────────

export type AgentReplayRecordPayload =
  | { readonly type: 'message'; readonly message: ContextMessage }
  | {
      readonly type: 'compaction';
      readonly result?: CompactionResult | 'cancelled';
      readonly instruction?: string;
    }
  | {
      readonly type: 'goal_updated';
      readonly snapshot: GoalSnapshot;
      readonly change: GoalChange | { readonly kind: 'created' };
    }
  | { readonly type: 'plan_updated'; readonly enabled: boolean }
  | { readonly type: 'config_updated'; readonly config: AgentConfigUpdateData }
  | { readonly type: 'permission_updated'; readonly mode: PermissionMode }
  | {
      readonly type: 'approval_result';
      readonly record: PermissionApprovalResultRecord;
    };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

// ── Cron / MCP / skills / tools / shell ─────────────────────────

export interface CronTaskSnapshot {
  readonly id: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly lastFiredAt: number | undefined;
  readonly nextFireAt: number | null;
}

export interface GetCronTasksResult {
  readonly tasks: readonly CronTaskSnapshot[];
}

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'builtin' | 'user' | 'extra' | 'project';
  readonly type?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly isSubSkill?: boolean | undefined;
}

export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}

export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

export interface ConfigDiagnostics {
  readonly warnings: readonly string[];
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string | undefined;
  readonly sessionLastActivity?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
  readonly sessionLogPath?: string | undefined;
  readonly globalLogPath?: string | undefined;
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export type GlobalMcpServerConfig = McpServerConfig & { readonly name: string };

export interface GlobalMcpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

// ── Session metadata / resume ────────────────────────────────────

export interface AgentMeta {
  readonly [key: string]: unknown;
}

export interface SessionMeta {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly isCustomTitle: boolean;
  readonly lastPrompt?: string;
  readonly forkedFrom?: string;
  readonly workDir?: string;
  readonly additionalDirs?: string[];
  readonly agents: Record<string, AgentMeta>;
  readonly custom: Record<string, unknown>;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
}
