// Client-side types mirroring the server API contract.
// Kept in sync manually — the server owns the source of truth.

export type WireRecordType =
  // File-header (line 1) and startup baseline (line 2) — vis splices
  // these back into the timeline so the Wire tab shows every line of
  // wire.jsonl, including the system_prompt.
  | 'metadata'
  | 'session_initialized'
  | 'turn_begin'
  | 'turn_end'
  | 'user_message'
  | 'tool_result'
  | 'compaction'
  | 'system_prompt_changed'
  | 'tools_changed'
  | 'system_reminder'
  | 'notification'
  // Atomic streaming records (replace assistant_message + tool_call_dispatched).
  | 'step_begin'
  | 'step_end'
  | 'content_part'
  | 'tool_call'
  | 'tool_denied'
  | 'skill_invoked'
  | 'skill_completed'
  | 'approval_request'
  | 'approval_response'
  | 'team_mail'
  | 'subagent_spawned'
  | 'subagent_completed'
  | 'subagent_failed'
  | 'ownership_changed'
  | 'context_edit'
  | 'context_cleared';

export type WireCategory =
  | 'conversation'
  | 'config'
  | 'lifecycle'
  | 'subagent'
  | 'approval'
  | 'ephemeral'
  | 'meta'
  | 'tools';

// Discriminated union — loosely typed so we can dispatch on .type without
// needing server-synchronized exact interfaces in the client. The server's
// own `types.ts` has the precise field types.
export interface VisWireRecordBase {
  type: WireRecordType;
  seq: number;
  time: number;
  [key: string]: unknown;
}

export type VisWireRecord = VisWireRecordBase;

export interface WireFileMetadata {
  type: 'metadata';
  protocol_version: string;
  created_at: number;
  kimi_version?: string;
  producer?: {
    kind: 'python' | 'typescript';
    name: string;
    version: string;
  };
}

// ──────────── Session ────────────

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
  [key: string]: unknown;
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

// ──────────── Wire ────────────

export interface WireResponse {
  session_id: string;
  agent_id: string | null;
  files_read: string[];
  health: 'ok' | 'broken';
  broken_reason?: string;
  warnings: string[];
  records: VisWireRecord[];
}

// ──────────── Context ────────────

export type MessageOrigin =
  | { kind: 'user' }
  | { kind: 'assistant' }
  | { kind: 'tool'; tool_call_id: string }
  | { kind: 'system_reminder'; seq: number }
  | { kind: 'notification'; seq: number; notification_id: string; severity: string };

export interface ContentPart {
  type: 'text' | 'think' | 'image_url' | 'video_url';
  [key: string]: unknown;
}

export interface ToolCallEntry {
  type: 'function';
  id: string;
  name: string; arguments: string | null;
}

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

// ──────────── Subagents ────────────

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

// ──────────── Category mapping ────────────

export const TYPE_CATEGORY: Record<WireRecordType, WireCategory> = {
  metadata: 'meta',
  session_initialized: 'config',
  turn_begin: 'conversation',
  turn_end: 'conversation',
  user_message: 'conversation',
  tool_result: 'conversation',
  compaction: 'conversation',
  system_prompt_changed: 'config',
  tools_changed: 'config',
  system_reminder: 'ephemeral',
  notification: 'meta',
  step_begin: 'conversation',
  step_end: 'conversation',
  content_part: 'conversation',
  tool_call: 'tools',
  tool_denied: 'approval',
  skill_invoked: 'tools',
  skill_completed: 'tools',
  approval_request: 'approval',
  approval_response: 'approval',
  team_mail: 'meta',
  subagent_spawned: 'subagent',
  subagent_completed: 'subagent',
  subagent_failed: 'subagent',
  ownership_changed: 'lifecycle',
  context_edit: 'lifecycle',
  context_cleared: 'lifecycle',
};

// Context-effect marker — `true` if the record mutates the live context,
// `false` if it is telemetry-only, `'conditional'` for records that depend
// on per-record fields (notification targets, system_reminder delivery, …).
export const TYPE_CTX_EFFECT: Record<WireRecordType, boolean | 'conditional'> = {
  // File header — purely informational, not a context event.
  metadata: false,
  // Startup baseline — seeds system_prompt / model / active_tools that
  // the projector uses as the context floor.
  session_initialized: true,
  turn_begin: false,
  turn_end: false,
  user_message: true,
  tool_result: true,
  compaction: true,
  system_prompt_changed: true,
  tools_changed: true,
  system_reminder: 'conditional',
  notification: 'conditional',
  // Streaming atoms together rebuild an assistant message → context-affecting.
  step_begin: true,
  step_end: false,
  content_part: true,
  tool_call: true,
  tool_denied: false,
  skill_invoked: false,
  skill_completed: false,
  approval_request: false,
  approval_response: false,
  team_mail: false,
  subagent_spawned: false,
  subagent_completed: false,
  subagent_failed: false,
  ownership_changed: false,
  context_edit: true,
  context_cleared: true,
};
