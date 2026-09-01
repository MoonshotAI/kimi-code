// apps/vis/server/src/lib/agent-record-types.ts
// Single source of truth: engine shapes come from agent-core-v2 directly.
// Do NOT add local interfaces that duplicate upstream shapes — the only
// exceptions are the legacy records below, which v2 never writes but old
// (v1-written / pre-migration) wires still contain on disk.

export type {
  ContextMessage,
  LoopRecordedEvent,
  Message,
  ContentPart,
  ToolCall,
  TokenUsage,
  PermissionMode,
  PromptOrigin,
  CronTask,
} from '@moonshot-ai/agent-core-v2';
export { WIRE_PROTOCOL_VERSION } from '@moonshot-ai/agent-core-v2/wire/migration/migration';
export type {
  AgentTaskInfo as BackgroundTaskInfo,
  AgentTaskStatus as BackgroundTaskStatus,
} from '@moonshot-ai/agent-core-v2';
export type { SubagentTaskInfo as AgentBackgroundTaskInfo } from '@moonshot-ai/agent-core-v2';
export type { ProcessTaskInfo as ProcessBackgroundTaskInfo } from '@moonshot-ai/agent-core-v2/agent/tools/os/bash/process-task';
export type { QuestionTaskInfo as QuestionBackgroundTaskInfo } from '@moonshot-ai/agent-core-v2/agent/tools/ask-user-question/question-background-task';

import type {
  AgentTaskInfo as BackgroundTaskInfo,
  CronAddPayload,
  CronCursorPayload,
  CronDeletePayload,
  CronTask,
  FullCompactionBegin,
  FullCompactionCancel,
  FullCompactionComplete,
  GoalClear,
  GoalCreate,
  GoalForked,
  GoalUpdate,
  InteractionRequestEvent,
  InteractionResolvedEvent,
  InterruptionReminderRecorded,
  LlmRequest,
  LlmToolsSnapshot,
  McpToolsDiscovered,
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  PlanRevision,
  PluginSessionStartEvent,
  PromptAborted,
  PromptAccepted,
  PromptCompleted,
  PromptSteered,
  TaskStarted,
  TaskTerminated,
  TaskWaitDelivered,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  ToolsRegisterUserTool,
  ToolsUnregisterUserTool,
} from '@moonshot-ai/agent-core-v2';
import type {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompactionPayload,
  ContextClear,
  ContextUndo,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextEvents';
import type { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type { TurnStepInterrupted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { TurnStepRetrying } from '@moonshot-ai/agent-core-v2/agent/stepRetry/stepRetryService';
import type { UsageRecord } from '@moonshot-ai/agent-core-v2/agent/usage/usageOps';
import type {
  ConfigUpdate,
  ProfileBind,
  ToolsResetActiveTools,
  ToolsSetActiveTools,
} from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import type { PermissionSetMode } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionModeOps';
import type { PermissionRecordApprovalResult } from '@moonshot-ai/agent-core-v2/agent/permissionRules/permissionRulesOps';
import type { RuntimeSetBinding } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/runtimeBindingOps';
import type { SwarmModeEnter, SwarmModeExit } from '@moonshot-ai/agent-core-v2/features/swarm/swarmOps';
import type { TowerModeEnter, TowerModeExit } from '@moonshot-ai/agent-core-v2/features/tower/towerOps';
import type {
  StaleGuardCleared,
  StaleGuardRecorded,
} from '@moonshot-ai/agent-core-v2/features/staleGuard/staleGuardOps';
import type { ToolsUpdateStore } from '@moonshot-ai/agent-core-v2/features/todo/todoOps';

/** A wire record with v2's literal `type` discriminant restored. v2 declares
 *  records as Event2 class + payload interface mergings whose `type` field is
 *  the widened `string`; intersecting with the literal keeps the union below
 *  discriminated. `time` stays optional because pre-1.5 wires may lack it. */
type WireRecordOf<T extends string, E> = E extends unknown
  ? Omit<E, 'type' | 'time' | 'serialize'> & { readonly type: T; readonly time?: number }
  : never;

/** v1-only durable record: dropped from v2 (`token_counting.*` carries the
 *  context-window fill now), but old wires still contain it. */
export interface ContextUpdateTokenCountRecord {
  readonly type: 'context.update_token_count';
  readonly tokenCount: number;
  readonly time?: number;
}

/** v1-only durable record: v2 has no micro-compaction, but old wires still
 *  contain it. */
export interface MicroCompactionApplyRecord {
  readonly type: 'micro_compaction.apply';
  readonly cutoff: number;
  readonly time?: number;
}

/** The wire file header record. Declared locally (rather than via v2's
 *  `WireMetadataRecord`) so the union member keeps concrete field types —
 *  the upstream interface carries an index signature that would widen
 *  `protocol_version` / `created_at` to `unknown`. */
export interface WireMetadataHeader {
  readonly type: 'metadata';
  readonly protocol_version: string;
  readonly created_at: number;
  readonly time?: number;
}

/**
 * The wire record union vis projects: every durable record kind v2 can write
 * (the wire-manifest inventory) plus the v1-only legacy kinds above, which
 * survive in old wires unchanged (the migration chain never drops records).
 * The union keeps the context projector's exhaustiveness check covering every
 * record a wire file can hold.
 */
export type AgentRecord =
  | WireMetadataHeader
  | WireRecordOf<'config.update', ConfigUpdate>
  | WireRecordOf<'context.append_loop_event', ContextAppendLoopEvent>
  | WireRecordOf<'context.append_message', ContextAppendMessage>
  | WireRecordOf<'context.apply_compaction', ContextApplyCompactionPayload>
  | WireRecordOf<'context.clear', ContextClear>
  | WireRecordOf<'context.undo', ContextUndo>
  | WireRecordOf<'cron.add', CronAddPayload>
  | WireRecordOf<'cron.cursor', CronCursorPayload>
  | WireRecordOf<'cron.delete', CronDeletePayload>
  | WireRecordOf<'forked', GoalForked>
  | WireRecordOf<'full_compaction.begin', FullCompactionBegin>
  | WireRecordOf<'full_compaction.cancel', FullCompactionCancel>
  | WireRecordOf<'full_compaction.complete', FullCompactionComplete>
  | WireRecordOf<'goal.clear', GoalClear>
  | WireRecordOf<'goal.create', GoalCreate>
  | WireRecordOf<'goal.update', GoalUpdate>
  | WireRecordOf<'interaction.request', InteractionRequestEvent>
  | WireRecordOf<'interaction.resolved', InteractionResolvedEvent>
  | WireRecordOf<'interruptionReminder.recorded', InterruptionReminderRecorded>
  | WireRecordOf<'llm.request', LlmRequest>
  | WireRecordOf<'llm.tools_snapshot', LlmToolsSnapshot>
  | WireRecordOf<'mcp.tools_discovered', McpToolsDiscovered>
  | WireRecordOf<'permission.record_approval_result', PermissionRecordApprovalResult>
  | WireRecordOf<'permission.set_mode', PermissionSetMode>
  | WireRecordOf<'plan_mode.cancel', PlanModeCancel>
  | WireRecordOf<'plan_mode.enter', PlanModeEnter>
  | WireRecordOf<'plan_mode.exit', PlanModeExit>
  | WireRecordOf<'plan.revision', PlanRevision>
  | WireRecordOf<'plugin.session_start', PluginSessionStartEvent>
  | WireRecordOf<'profile.bind', ProfileBind>
  | WireRecordOf<'prompt.aborted', PromptAborted>
  | WireRecordOf<'prompt.accepted', PromptAccepted>
  | WireRecordOf<'prompt.completed', PromptCompleted>
  | WireRecordOf<'prompt.steered', PromptSteered>
  | WireRecordOf<'runtime.set_binding', RuntimeSetBinding>
  | WireRecordOf<'staleGuard.cleared', StaleGuardCleared>
  | WireRecordOf<'staleGuard.recorded', StaleGuardRecorded>
  | WireRecordOf<'swarm_mode.enter', SwarmModeEnter>
  | WireRecordOf<'swarm_mode.exit', SwarmModeExit>
  | WireRecordOf<'task.started', TaskStarted>
  | WireRecordOf<'task.terminated', TaskTerminated>
  | WireRecordOf<'task.waitDelivered', TaskWaitDelivered>
  | WireRecordOf<'token_counting.measured', TokenCountingMeasured>
  | WireRecordOf<'token_counting.rebased', TokenCountingRebased>
  | WireRecordOf<'token_counting.truncated', TokenCountingTruncated>
  | WireRecordOf<'token_counting.turn_recorded', TokenCountingTurnRecorded>
  | WireRecordOf<'tools.register_user_tool', ToolsRegisterUserTool>
  | WireRecordOf<'tools.reset_active_tools', ToolsResetActiveTools>
  | WireRecordOf<'tools.set_active_tools', ToolsSetActiveTools>
  | WireRecordOf<'tools.unregister_user_tool', ToolsUnregisterUserTool>
  | WireRecordOf<'tools.update_store', ToolsUpdateStore>
  | WireRecordOf<'tower_mode.enter', TowerModeEnter>
  | WireRecordOf<'tower_mode.exit', TowerModeExit>
  | WireRecordOf<'turn.cancel', TurnCancel>
  | WireRecordOf<'turn.ended', TurnEnded>
  | WireRecordOf<'turn.prompt', TurnPrompt>
  | WireRecordOf<'turn.steer', TurnSteer>
  | WireRecordOf<'turn.step.interrupted', TurnStepInterrupted>
  | WireRecordOf<'turn.step.retrying', TurnStepRetrying>
  | WireRecordOf<'usage.record', UsageRecord>
  | ContextUpdateTokenCountRecord
  | MicroCompactionApplyRecord;

/** Extract one record kind from the union. */
export type AgentRecordOf<K extends AgentRecord['type']> = Extract<
  AgentRecord,
  { readonly type: K }
>;

/**
 * `manifest.json` shape inside a `/export-debug-zip` bundle. Structural
 * mirror of the engine's `ExportSessionManifest`, which is not re-exported
 * from the package entry. All fields optional-tolerant because the manifest
 * comes from another machine / kimi-code version.
 */
export interface ImportManifest {
  sessionId?: string;
  exportedAt?: string;
  kimiCodeVersion?: string;
  wireProtocolVersion?: string;
  os?: string;
  nodejsVersion?: string;
  sessionFirstActivity?: string;
  sessionLastActivity?: string;
  title?: string;
  workspaceDir?: string;
  sessionLogPath?: string;
  globalLogPath?: string;
  installSource?: string;
  shellEnv?: unknown;
}

/** vis-side bookkeeping for one imported bundle, written to
 *  `imported/<importId>/import-meta.json`. */
export interface ImportInfo {
  /** vis-generated id (`imp_…`); also the session id the UI addresses. */
  importId: string;
  /** ISO time the zip was imported into vis. */
  importedAt: string;
  /** Original uploaded file name, when known. */
  originalName: string | null;
  /** Parsed `manifest.json`, when present and readable. */
  manifest: ImportManifest | null;
}

// ── vis-only DTOs ──────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code:
    | 'NOT_FOUND'
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'READ_ERROR'
    | 'PARSE_ERROR'
    | 'DELETE_ERROR';
}

export type SessionHealth =
  | 'ok'
  | 'broken_state'
  | 'broken_main_wire'
  | 'missing_main_wire';

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  title: string | null;
  lastPrompt: string | null;
  isCustomTitle: boolean;
  createdAt: number;
  updatedAt: number;
  agentCount: number;
  mainAgentExists: boolean;
  mainWireRecordCount: number;
  wireProtocolVersion: string | null;
  health: SessionHealth;
  /** True for sessions imported from a debug zip (under `<home>/imported/`). */
  imported: boolean;
  /** Export/import provenance for imported sessions; null for local ones. */
  importMeta: ImportInfo | null;
}

export interface AgentInfo {
  agentId: string;
  type: 'main' | 'sub' | 'independent';
  parentAgentId: string | null;
  homedir: string;
  wireExists: boolean;
  wireRecordCount: number;
  wireProtocolVersion: string | null;
  /** Per-item swarm work label persisted by the engine for swarm-spawned
   *  sub-agents (`AgentMeta.swarmItem`, or `AgentMeta.labels.swarmItem` on
   *  v2-written sessions). `null` when the agent is not a swarm item or when
   *  the value cannot be recovered (e.g. disk-only inventory of a session
   *  with a corrupt `state.json`). */
  swarmItem: string | null;
}

export interface SessionDetail {
  sessionId: string;
  /** Canonical on-disk session directory. Routes derive agent wire paths
   *  from this rather than the mutable `homedir` field inside `state.json`,
   *  which can drift after fork/rename. */
  sessionDir: string;
  workDir: string;
  state: unknown; // 原样透传，前端按 state.json 真实形状渲染
  agents: AgentInfo[];
  /** True for sessions imported from a debug zip. */
  imported: boolean;
  /** Export/import provenance for imported sessions; null for local ones. */
  importMeta: ImportInfo | null;
}

/** One line of `wire.jsonl` after vis has parsed (and possibly migrated)
 *  it. `lineNo` is internal plumbing — used as a stable React key, for
 *  "jump to line" navigation, and for pairing events — and MUST NOT be
 *  rendered as part of the record body. The detail panel surfaces it via
 *  the row header, not inside the JSON view. */
export interface WireEntry {
  /** 1-indexed line number in the underlying `wire.jsonl` file. */
  lineNo: number;
  /** The record as projected by vis: JSON-parsed AND run through the
   *  upstream migration chain. Every consumer reads from this. */
  data: AgentRecord;
  /** The record exactly as written on disk: `JSON.parse` of the line,
   *  with NO migration and NO vis annotations. Equal to `data` for
   *  current-protocol records; diverges when a migration applied (e.g.
   *  nested `toolCalls[*].function.name` → flat `name` on v1.0 wires).
   *  Used by the detail panel to show "as written vs as projected". */
  raw: unknown;
}

export interface WireResponse {
  sessionId: string;
  agentId: string;
  protocolVersion: string;
  metadata: { protocolVersion: string; createdAt: number };
  records: readonly WireEntry[];
  warnings: string[];
}

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

export interface AgentTreeResponse {
  sessionId: string;
  tree: AgentNode[];
}

// ── background tasks & cron ─────────────────────────────────────────────────

/** A persisted background task plus vis-derived `output.log` metadata.
 *  `task` is the normalized engine shape; the size/exists fields let the
 *  UI badge how much output a task produced and offer a "view log" affordance
 *  without first fetching the (potentially large) log body. */
export interface BackgroundTaskEntry {
  task: BackgroundTaskInfo;
  /** Which agent persisted this task — tasks live under the spawning agent's
   *  homedir (`<session>/agents/<agentId>/tasks`), not the session root. */
  agentId: string;
  /** Total byte size of the task's `output.log` (0 when absent). */
  outputSizeBytes: number;
  /** Whether an `output.log` file exists for this task. */
  outputExists: boolean;
}

export interface BackgroundTasksResponse {
  sessionId: string;
  tasks: BackgroundTaskEntry[];
}

/** One byte-window of a task's `output.log`. Byte-level (not line-level)
 *  paging mirrors how the log is stored on disk, so arbitrarily large logs
 *  can be paged without loading the whole file. */
export interface TaskOutputResponse {
  sessionId: string;
  taskId: string;
  /** Byte offset this window starts at. */
  offset: number;
  /** Byte offset immediately after this window; pass as the next `offset`
   *  to page forward without drift. */
  nextOffset: number;
  /** Total byte size of the log on disk. */
  size: number;
  /** UTF-8 decoded window content. */
  content: string;
  /** True when this window reaches the end of the log. */
  eof: boolean;
}

export interface CronTasksResponse {
  sessionId: string;
  cron: CronTask[];
}

// ── imported sessions & logs ────────────────────────────────────────────────

/** Result of importing a debug zip. */
export interface ImportResult {
  /** The `imp_…` id the UI uses to address the imported session. */
  sessionId: string;
  importMeta: ImportInfo;
}

/** One parsed line of a diagnostic log. */
export interface LogLine {
  /** 1-indexed line number in the source log. */
  lineNo: number;
  /** ISO timestamp parsed from the line prefix, or null if unparseable. */
  time: string | null;
  /** Log level (INFO / WARN / ERROR / DEBUG / …), uppercased, or null. */
  level: string | null;
  /** The human message between the level and the structured fields. */
  message: string;
  /** Parsed trailing `key=value` fields. */
  fields: Record<string, string>;
  /** The original line, verbatim. */
  raw: string;
}

export interface LogsResponse {
  sessionId: string;
  which: 'session' | 'global';
  /** Which logs exist on disk for this session. */
  available: { session: boolean; global: boolean };
  lines: LogLine[];
  /** True when the log was longer than the served cap and got truncated. */
  truncated: boolean;
}
