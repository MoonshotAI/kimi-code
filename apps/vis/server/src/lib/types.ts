// Vis-local mirror of the core WireRecord interfaces. Copied so the
// `VisWireRecord` union stays structurally equal to the core `WireRecord`
// union; the sole cast lives in `lib/wire-loader.ts` and is safe because
// these interfaces are field-for-field compatible.
//
// Plus the vis-specific response types consumed by `server/src/routes/*`
// and the `web/` SPA.

// ── Supporting types (subset of core helpers) ────────────────────────────

export interface TextPart {
  type: 'text';
  text: string;
}
export interface ImageURLPart {
  type: 'image_url';
  image_url: { url: string };
}
export interface VideoURLPart {
  type: 'video_url';
  video_url: { url: string };
}
export type UserInputPart = TextPart | ImageURLPart | VideoURLPart;

export interface TokenUsage {
  input: number;
  output: number;
  cache_read?: number | undefined;
  cache_write?: number | undefined;
}

// ── File metadata header ────────────────────────────────────────────────

export interface WireFileMetadata {
  type: 'metadata';
  protocol_version: string;
  created_at: number;
  kimi_version?: string | undefined;
  /** Implementation that wrote the wire file. Present on TS-native sessions. */
  producer?: WireProducer | undefined;
}

/** Implementation that wrote the wire file (Python migration vs native TS). */
export interface WireProducer {
  kind: 'python' | 'typescript';
  name: string;
  version: string;
}

// ── Vis-synthetic timeline records ─────────────────────────────────────
// `replayWire()` strips the file header (line 1) and session_initialized
// (line 2) out of `records[]` and exposes them separately. To make the
// Wire tab show EVERYTHING that lives in wire.jsonl, we splice them back
// in as synthetic timeline records, with `seq`/`time` synthesised where
// the on-disk record lacks them.

export interface MetadataRecord {
  type: 'metadata';
  /** Synthetic: 0 (placed just before session_initialized). */
  seq: number;
  /** Synthetic: mirrors `created_at`. */
  time: number;
  protocol_version: string;
  created_at: number;
  kimi_version?: string | undefined;
  producer?: WireProducer | undefined;
  /** Vis-only: which wire file this header came from (useful across archives). */
  file_name?: string | undefined;
}

// ── session_initialized ───────────────────────────────────────────────
// Line 2 of every TS-native wire.jsonl. Carries startup baseline that
// the projector reads as authoritative — extracted by replayWire out of
// `records[]` onto `ReplayResult.sessionInitialized`.

interface SessionInitializedCommonFields {
  type: 'session_initialized';
  seq: number;
  time: number;
  system_prompt: string;
  active_tools: string[];
  model?: string | undefined;
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | undefined;
  plan_mode?: boolean | undefined;
  workspace_dir?: string | undefined;
  thinking_level?: string | undefined;
}

export interface SessionInitializedMainRecord extends SessionInitializedCommonFields {
  agent_type: 'main';
  session_id: string;
}

export interface SessionInitializedSubRecord extends SessionInitializedCommonFields {
  agent_type: 'sub';
  agent_id: string;
  agent_name?: string | undefined;
  parent_session_id: string;
  parent_agent_id?: string | undefined;
  parent_tool_call_id: string;
  run_in_background: boolean;
}

export interface SessionInitializedIndependentRecord extends SessionInitializedCommonFields {
  agent_type: 'independent';
  agent_id: string;
  agent_name?: string | undefined;
}

export type SessionInitializedRecord =
  | SessionInitializedMainRecord
  | SessionInitializedSubRecord
  | SessionInitializedIndependentRecord;

// ── Record branches ──────────────────────────────────────────────────

export interface TurnBeginRecord {
  type: 'turn_begin';
  seq: number;
  time: number;
  turn_id: string;
  agent_type: 'main' | 'sub' | 'independent';
  user_input?: string | undefined;
  input_kind: 'user' | 'system_trigger';
  trigger_source?: string | undefined;
}

export interface TurnEndRecord {
  type: 'turn_end';
  seq: number;
  time: number;
  turn_id: string;
  agent_type: 'main' | 'sub' | 'independent';
  success: boolean;
  reason: 'done' | 'cancelled' | 'error' | 'interrupted';
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
        cost_usd?: number | undefined;
      }
    | undefined;
  synthetic?: boolean | undefined;
}

export interface UserMessageRecord {
  type: 'user_message';
  seq: number;
  time: number;
  turn_id: string;
  content: string | readonly UserInputPart[];
  uuid?: string | undefined;
}

// ── Atomic streaming records (replaces assistant_message) ─────────────
// Each LLM step is a sequence: step_begin → (content_part|tool_call)* → step_end.
// An "assistant message" is reconstructed by coalescing these atoms by step_uuid.

export interface StepBeginRecord {
  type: 'step_begin';
  seq: number;
  time: number;
  /** Unique id for this step (anchor for its content_part / tool_call atoms). */
  uuid: string;
  turn_id: string;
  step: number;
}

export interface StepEndRecord {
  type: 'step_end';
  seq: number;
  time: number;
  uuid: string;
  turn_id: string;
  step: number;
  usage?:
    | {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens?: number | undefined;
        cache_write_tokens?: number | undefined;
      }
    | undefined;
  finish_reason?: string | undefined;
}

export interface ContentPartRecord {
  type: 'content_part';
  seq: number;
  time: number;
  uuid: string;
  turn_id: string;
  step: number;
  /** Anchors to the step_begin.uuid that opened this step. */
  step_uuid: string;
  role: 'assistant';
  /** Inner key is `kind` (not `type`) to avoid outer-union collision. */
  part:
    | { kind: 'text'; text: string }
    | { kind: 'think'; think: string; encrypted?: string | undefined };
}

export interface ToolResultRecord {
  type: 'tool_result';
  seq: number;
  time: number;
  turn_id: string;
  tool_call_id: string;
  output: unknown;
  is_error?: boolean | undefined;
  synthetic?: boolean | undefined;
  uuid?: string | undefined;
  parent_uuid?: string | undefined;
}

export interface CompactionRecord {
  type: 'compaction';
  seq: number;
  time: number;
  summary: string;
  pre_compact_tokens: number;
  post_compact_tokens: number;
  uuid?: string | undefined;
}

export interface SystemPromptChangedRecord {
  type: 'system_prompt_changed';
  seq: number;
  time: number;
  new_prompt: string;
}

export interface ToolsChangedRecord {
  type: 'tools_changed';
  seq: number;
  time: number;
  operation: 'register' | 'remove' | 'set_active';
  tools: string[];
}

export interface SystemReminderRecord {
  type: 'system_reminder';
  seq: number;
  time: number;
  content: string;
  consumed_at_turn?: number | undefined;
}

export interface NotificationRecord {
  type: 'notification';
  seq: number;
  time: number;
  data: {
    id: string;
    category: 'task' | 'agent' | 'system' | 'team';
    type: string;
    source_kind: string;
    source_id: string;
    title: string;
    body: string;
    severity: 'info' | 'success' | 'warning' | 'error';
    payload?: Record<string, unknown> | undefined;
    targets: Array<'llm' | 'wire' | 'shell'>;
    dedupe_key?: string | undefined;
    delivered_at?:
      | {
          llm?: number | undefined;
          wire?: number | undefined;
          shell?: number | undefined;
        }
      | undefined;
    envelope_id?: string | undefined;
    // background_task notifications attach streamed tail output that the
    // live projector renders into a <task-notification> block.
    tail_output?: string | undefined;
  };
}

// First-class tool-call record (was once telemetry-only under a different name).
export interface ToolCallRecord {
  type: 'tool_call';
  seq: number;
  time: number;
  uuid: string;
  turn_id: string;
  step: number;
  /** Anchors to the step_begin.uuid that opened this step. */
  step_uuid: string;
  data: {
    tool_call_id: string;
    tool_name: string;
    args: unknown;
    description?: string | undefined;
    display?: ApprovalDisplay;
  };
}

export interface ToolDeniedRecord {
  type: 'tool_denied';
  seq: number;
  time: number;
  turn_id: string;
  step: number;
  data: {
    tool_call_id: string;
    tool_name: string;
    rule_id: string;
    reason: string;
  };
}

export type McpApprovalReason = 'elicitation' | 'auth' | 'tool_call';

export type ApprovalSource =
  | { kind: 'loop'; agent_id: string }
  | { kind: 'subagent'; agent_id: string; subagent_type?: string | undefined }
  | { kind: 'turn'; turn_id: string }
  | { kind: 'session'; session_id: string }
  | { kind: 'mcp'; server_id: string; reason: McpApprovalReason };

// `ApprovalDisplay` is `ToolInputDisplay` in core. We intentionally keep the
// shape opaque here — vis only passes it through to the UI.
export type ApprovalDisplay = unknown;

export type SkillInvocationTrigger = 'user-slash' | 'model-tool' | 'nested-skill';

export interface SkillInvokedRecord {
  type: 'skill_invoked';
  seq: number;
  time: number;
  turn_id: string;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  data: {
    skill_name: string;
    execution_mode: 'inline' | 'fork';
    original_input: string;
    sub_agent_id?: string | undefined;
    invocation_trigger?: SkillInvocationTrigger | undefined;
    query_depth?: number | undefined;
  };
}

export interface SkillCompletedRecord {
  type: 'skill_completed';
  seq: number;
  time: number;
  turn_id: string;
  agent_type?: 'main' | 'sub' | 'independent' | undefined;
  data: {
    skill_name: string;
    execution_mode: 'inline' | 'fork';
    success: boolean;
    error?: string | undefined;
    sub_agent_id?: string | undefined;
    invocation_trigger?: SkillInvocationTrigger | undefined;
    query_depth?: number | undefined;
  };
}

export interface ApprovalRequestRecord {
  type: 'approval_request';
  seq: number;
  time: number;
  turn_id: string;
  step: number;
  data: {
    request_id: string;
    tool_call_id: string;
    tool_name: string;
    action: string;
    display: ApprovalDisplay;
    source: ApprovalSource;
  };
}

export interface ApprovalResponseRecord {
  type: 'approval_response';
  seq: number;
  time: number;
  turn_id: string;
  step: number;
  data: {
    request_id: string;
    response: 'approved' | 'rejected' | 'cancelled';
    feedback?: string | undefined;
    selected_label?: string | undefined;
    synthetic?: boolean | undefined;
  };
}

export interface TeamMailRecord {
  type: 'team_mail';
  seq: number;
  time: number;
  data: {
    mail_id: string;
    reply_to?: string | undefined;
    from_agent: string;
    to_agent: string;
    content: string;
    summary?: string | undefined;
  };
}

export interface SubagentSpawnedRecord {
  type: 'subagent_spawned';
  seq: number;
  time: number;
  uuid?: string | undefined;
  data: {
    agent_id: string;
    agent_name?: string | undefined;
    parent_tool_call_id: string;
    parent_agent_id?: string | undefined;
    parent_tool_call_uuid?: string | undefined;
    run_in_background: boolean;
  };
}

export interface SubagentCompletedRecord {
  type: 'subagent_completed';
  seq: number;
  time: number;
  uuid?: string | undefined;
  parent_uuid?: string | undefined;
  data: {
    agent_id: string;
    parent_tool_call_id: string;
    result_summary: string;
    usage?: TokenUsage | undefined;
  };
}

export interface SubagentFailedRecord {
  type: 'subagent_failed';
  seq: number;
  time: number;
  uuid?: string | undefined;
  parent_uuid?: string | undefined;
  data: {
    agent_id: string;
    parent_tool_call_id: string;
    error: string;
  };
}

export interface OwnershipChangedRecord {
  type: 'ownership_changed';
  seq: number;
  time: number;
  old_owner: string | null;
  new_owner: string;
}

export interface ContextEditRecord {
  type: 'context_edit';
  seq: number;
  time: number;
  operation: 'edit_message' | 'delete_message' | 'rewind' | 'insert_message' | 'replace_message';
  target_seq?: number | undefined;
  to_turn?: number | undefined;
  after_seq?: number | undefined;
  new_content?: string | undefined;
  new_role?: 'user' | 'assistant' | 'system' | undefined;
  cascade?: boolean | undefined;
}

export interface ContextClearedRecord {
  type: 'context_cleared';
  seq: number;
  time: number;
}

// ── Union ─────────────────────────────────────────────────────────────

export type VisWireRecord =
  | MetadataRecord
  | SessionInitializedRecord
  | TurnBeginRecord
  | TurnEndRecord
  | UserMessageRecord
  | ToolResultRecord
  | CompactionRecord
  | SystemPromptChangedRecord
  | ToolsChangedRecord
  | SystemReminderRecord
  | NotificationRecord
  | StepBeginRecord
  | StepEndRecord
  | ContentPartRecord
  | ToolCallRecord
  | ToolDeniedRecord
  | SkillInvokedRecord
  | SkillCompletedRecord
  | ApprovalRequestRecord
  | ApprovalResponseRecord
  | TeamMailRecord
  | SubagentSpawnedRecord
  | SubagentCompletedRecord
  | SubagentFailedRecord
  | OwnershipChangedRecord
  | ContextEditRecord
  | ContextClearedRecord;

// ── Vis-specific response types ─────────────────────────────────────────

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

export interface DeleteSessionResponse {
  session_id: string;
  deleted: true;
}

export interface ClearSessionsResponse {
  deleted_count: number;
  failed: Array<{ session_id: string; error: string }>;
}

export interface SessionState {
  session_id: string;
  title?: string;
  isCustomTitle?: boolean;
  customTitle?: string;
  lastPrompt?: string;
  last_prompt?: string;
  model?: string;
  last_turn_id?: string;
  last_turn_time?: number;
  turn_count?: number;
  created_at: number;
  updated_at: number;
  workspace_dir?: string;
  auto_approve_actions?: string[];
  permission_mode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  thinking_level?: string;
  custom_title?: string;
  plan_mode?: boolean;
  plan_slug?: string;
  tags?: string[];
  description?: string;
  archived?: boolean;
  color?: string;
  last_exit_code?: 'clean' | 'dirty';
  /** Implementation that wrote this session. Vis only surfaces sessions
   *  with `kind === 'typescript'`. */
  producer?: WireProducer;
}

export interface SessionSummary {
  session_id: string;
  title: string | null;
  last_prompt: string | null;
  created_at: number;
  updated_at: number;
  last_turn_time: number | null;
  model: string | null;
  permission_mode: string | null;
  last_exit_code: 'clean' | 'dirty' | null;
  custom_title: string | null;
  tags: string[];
  archived: boolean;
  workspace_dir: string | null;
  wire_protocol_version: string | null;
  wire_record_count: number;
  archive_count: number;
  subagent_count: number;
  health: 'ok' | 'broken' | 'missing_wire';
}

export interface SessionDetail {
  session_id: string;
  title: string | null;
  last_prompt: string | null;
  state: SessionState;
  subagent_ids: string[];
  archive_files: string[];
  tool_result_ids: string[];
  wire_metadata: WireFileMetadata | null;
}

export interface WireResponse {
  session_id: string;
  agent_id: string | null;
  files_read: string[];
  health: 'ok' | 'broken';
  broken_reason?: string;
  warnings: string[];
  records: VisWireRecord[];
}

export interface ContentPart {
  type: 'text' | 'think' | 'image_url' | 'video_url';
  [key: string]: unknown;
}

export interface ToolCallEntry {
  type: 'function';
  id: string;
  name: string; arguments: string | null;
}

export type MessageOrigin =
  | { kind: 'user' }
  | { kind: 'assistant' }
  | { kind: 'tool'; tool_call_id: string }
  | { kind: 'system_reminder'; seq: number }
  | { kind: 'notification'; seq: number; notification_id: string; severity: string };

export interface AnnotatedMessage {
  seq: number;
  message: {
    role: 'user' | 'assistant' | 'tool';
    content: ContentPart[];
    tool_calls: ToolCallEntry[];
    tool_call_id?: string;
  };
  origin: MessageOrigin;
  is_ephemeral: boolean;
  out_of_context: boolean;
  persisted_output_path?: string;
}

export interface ProjectedStateSummary {
  model: string | null;
  system_prompt: string | null;
  active_tools: string[];
  last_seq: number;
  token_count: number;
  permission_mode: string | null;
  plan_mode: boolean;
  /** Token breakdown, summed from every `step_end.usage` in the session.
   *  Provides the 4-segment bar shown at the top of the Context tab.
   *  Zero when no step_ends have been observed (e.g. pre-protocol session). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface ContextResponse {
  session_id: string;
  agent_id: string | null;
  annotated_messages: AnnotatedMessage[];
  projected_state: ProjectedStateSummary;
}

export interface SubagentNode {
  agent_id: string;
  agent_name: string | null;
  subagent_type: string | null;
  run_in_background: boolean;
  parent_agent_id: string | null;
  depth: number;
  status: 'running' | 'completed' | 'failed' | 'killed' | 'lost' | 'unknown';
  success: boolean | null;
  result_summary: string | null;
  error: string | null;
  spawn_seq: number;
  spawn_time: number;
  children: SubagentNode[];
}

export interface SubagentTreeResponse {
  session_id: string;
  tree: SubagentNode[];
}

export interface SubagentMetaResponse {
  agent_id: string;
  session_id: string;
  meta_json: {
    agent_id: string;
    subagent_type: string;
    status: string;
    description: string;
    parent_tool_call_id: string;
    created_at: number;
    updated_at: number;
  } | null;
  spawned_record: {
    agent_name?: string;
    parent_tool_call_id: string;
    parent_agent_id?: string;
    run_in_background: boolean;
    seq: number;
    time: number;
  } | null;
  completed_record: {
    parent_tool_call_id: string;
    result_summary: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens?: number;
      cache_write_tokens?: number;
    };
    seq: number;
    time: number;
  } | null;
  failed_record: {
    parent_tool_call_id: string;
    error: string;
    seq: number;
    time: number;
  } | null;
  depth: number;
}

export interface ToolResultFileResponse {
  tool_call_id: string;
  session_id: string;
  size_bytes: number;
  content: string;
}
