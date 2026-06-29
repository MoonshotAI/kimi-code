// apps/vis/server/src/lib/agent-record-types.ts
// Single source of truth: everything below comes from agent-core directly.
// Do NOT add local interfaces that duplicate upstream shapes.

export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  AgentConfigUpdateData,
  CompactionBeginData,
  CompactionResult,
  PermissionApprovalResultRecord,
  PermissionMode,
  UsageRecordScope,
  ToolStoreUpdate,
  LoopRecordedEvent,
  ContextMessage,
  PromptOrigin,
  // Background-task shapes are part of agent-core's public surface, so the
  // visualizer tracks them directly instead of duplicating the union.
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  AgentBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
} from '@moonshot-ai/agent-core';
export { AGENT_WIRE_PROTOCOL_VERSION } from '@moonshot-ai/agent-core';
export type { Message, ContentPart, ToolCall, TokenUsage } from '@moonshot-ai/kosong';

// Local bindings for the upstream types referenced by the vis-only DTOs
// below. The `export type { … }` re-export above forwards the names to
// consumers but does NOT bring them into this module's scope.
import type { AgentRecord, BackgroundTaskInfo } from '@moonshot-ai/agent-core';

/**
 * Persistent representation of a cron task.
 *
 * Structural mirror of agent-core's `CronTask` (`tools/cron/types.ts`),
 * which is NOT re-exported from the package entry point. The shape is
 * tiny and frozen; `cron-store.test.ts` reads a fixture written in the
 * real on-disk format so the mirror cannot silently drift from disk.
 */
export interface CronTask {
  readonly id: string;
  readonly cron: string;
  readonly prompt: string;
  readonly createdAt: number;
  readonly recurring?: boolean;
  readonly lastFiredAt?: number;
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
}

export interface AgentInfo {
  agentId: string;
  type: 'main' | 'sub' | 'independent';
  parentAgentId: string | null;
  homedir: string;
  wireExists: boolean;
  wireRecordCount: number;
  wireProtocolVersion: string | null;
  /** Per-item swarm work label persisted by agent-core for swarm-spawned
   *  sub-agents (`AgentMeta.swarmItem`). `null` when the agent is not a
   *  swarm item or when the value cannot be recovered (e.g. disk-only
   *  inventory of a session with a corrupt `state.json`). */
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
 *  `task` is the normalized agent-core shape; the size/exists fields let the
 *  UI badge how much output a task produced and offer a "view log" affordance
 *  without first fetching the (potentially large) log body. */
export interface BackgroundTaskEntry {
  task: BackgroundTaskInfo;
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
