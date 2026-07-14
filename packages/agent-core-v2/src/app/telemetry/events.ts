/**
 * `telemetry` domain (L1) — telemetry event registry.
 *
 * Central registry of every business event emitted through
 * `ITelemetryService.track2`: each entry pairs the event's property type
 * (the compile-time contract enforced at call sites) with review metadata
 * (owner, purpose, per-property comment) whose keys must match the property
 * type exactly. Registered names are the raw event names, before the
 * transport's `kfc_` server prefix. Naming conventions: events and
 * properties are snake_case; durations/counts/sizes carry a unit suffix
 * (`_ms` / `_count` / `_bytes`); never register user content or file paths
 * as properties. App-scoped, self-contained — property unions are declared
 * locally instead of imported from business domains.
 */

import type { TelemetryPrimitive } from './telemetry';

export interface TelemetryEventMeta {
  readonly owner: string;
  readonly comment: string;
  readonly properties: Readonly<Record<string, string>>;
}

export interface TelemetryEventDefinition<P> {
  readonly meta: TelemetryEventMeta;
  readonly _properties?: P;
}

export function defineTelemetryEvent<P>(
  meta: TelemetryEventMeta & { readonly properties: { [K in keyof P]-?: string } },
): TelemetryEventDefinition<P> {
  return { meta };
}

export type StrictPropertyCheck<T, E> = string extends keyof T
  ? E extends T
    ? E
    : never
  : T extends E
    ? E extends T
      ? E
      : never
    : never;

export interface TurnStartedEvent {
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
}

export interface TurnInterruptedEvent {
  at_step: number;
  mode: 'agent' | 'plan';
  interrupt_reason: 'user_cancelled' | 'aborted' | 'max_steps' | 'error' | 'filtered' | 'blocked';
  provider_type?: string;
  protocol?: string;
}

export interface TurnEndedEvent {
  reason: 'completed' | 'cancelled' | 'failed';
  duration_ms: number;
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
}

export type ToolCallOutcome = 'success' | 'error' | 'cancelled';

export interface ToolCallEvent {
  turn_id: number;
  tool_call_id: string;
  tool_name: string;
  outcome: ToolCallOutcome;
  duration_ms: number;
  dup_type: 'normal' | 'same_step' | 'cross_step';
  error_type?: 'cancelled' | 'error';
}

export interface ApiErrorEvent {
  error_type: string;
  model: string;
  alias?: string;
  retryable: boolean;
  duration_ms: number;
  status_code?: number;
  provider_type?: string;
  protocol?: string;
  input_tokens?: number;
}

export interface SkillInvokedEvent {
  skill_name: string;
  trigger: 'user-slash' | 'model-tool' | 'nested-skill';
}

export interface FlowInvokedEvent {
  flow_name: string;
}

export interface InputSteerEvent {
  parts: number;
}

export interface CancelEvent {
  from: 'streaming' | 'compacting';
}

export interface ConversationUndoEvent {
  count: number;
}

export interface YoloToggleEvent {
  enabled: boolean;
}

export interface AfkToggleEvent {
  enabled: boolean;
}

export type TelemetryPermissionMode = 'manual' | 'yolo' | 'auto';

export interface PermissionPolicyDecisionEvent {
  policy_name: string;
  tool_name: string;
  permission_mode: TelemetryPermissionMode;
  decision: 'approve' | 'deny' | 'ask';
  [key: string]: TelemetryPrimitive;
}

export interface PermissionApprovalResultEvent {
  policy_name: string | null;
  tool_name: string;
  permission_mode: TelemetryPermissionMode;
  result: 'error' | 'approved_for_session' | 'approved' | 'rejected' | 'cancelled';
  approval_surface: string;
  duration_ms: number;
  session_cache_written: boolean;
  has_feedback: boolean;
}

export interface PlanSubmittedEvent {
  has_options: boolean;
}

export interface PlanResolvedEvent {
  outcome:
    | 'approved'
    | 'dismissed'
    | 'rejected_and_exited'
    | 'revise'
    | 'rejected'
    | 'auto_approved';
  chosen_option?: string;
  has_feedback?: boolean;
}

export interface PlanEnterResolvedEvent {
  outcome: 'auto_approved';
}

export interface CompactionFinishedEvent {
  source: 'manual' | 'auto';
  tokens_before: number;
  tokens_after: number;
  duration_ms: number;
  compacted_count: number;
  dropped_count?: number;
  retry_count: number;
  round: number;
  thinking_effort: string;
  input_tokens?: number;
  output_tokens?: number;
  input_cache_read?: number;
  input_cache_creation?: number;
}

export interface CompactionFailedEvent {
  source: 'manual' | 'auto';
  tokens_before: number;
  duration_ms: number;
  round: number;
  retry_count: number;
  thinking_effort: string;
  error_type: string;
}

export interface ContextProjectionRepairedEvent {
  reordered: number;
  synthesized: number;
  dropped_orphan: number;
  duplicate_calls_dropped: number;
  duplicate_results_dropped: number;
  leading_dropped: number;
  assistants_merged: number;
  whitespace_dropped: number;
}

export interface BackgroundTaskCreatedEvent {
  kind: 'bash' | 'agent' | 'question';
}

export interface BackgroundTaskCompletedEvent {
  kind: 'agent' | 'process' | 'question';
  duration_ms: number | null;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
}

export interface ModelSwitchEvent {
  model: string;
}

export interface ThinkingToggleEvent {
  enabled: boolean;
  effort: string;
  from: string;
}

export interface QuestionDismissedEvent {}

export interface QuestionAnsweredEvent {
  answered: number;
  method?: 'enter' | 'space' | 'number_key';
}

export type TelemetryGoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetProperties {
  has_token_budget: boolean;
  has_turn_budget: boolean;
  has_wall_clock_budget: boolean;
}

export interface GoalCreatedEvent {
  actor: TelemetryGoalActor;
  replace: boolean;
}

export interface GoalBudgetSetEvent extends GoalBudgetProperties {
  actor: TelemetryGoalActor;
}

export interface GoalContinuedEvent {
  turns_used: number;
}

export interface GoalClearedEvent {
  actor: TelemetryGoalActor;
}

export interface GoalStatusChangedEvent extends GoalBudgetProperties {
  actor: TelemetryGoalActor;
  status: 'active' | 'paused' | 'blocked' | 'complete';
  turns_used: number;
  tokens_used: number;
  wall_clock_ms: number;
}

export interface ToolCallDedupDetectedEvent {
  turn_id: number;
  step_no: number;
  tool_call_id: string;
  tool_name: string;
  dup_type: 'same_step' | 'cross_step';
  args_hash: string;
}

export interface ToolCallRepeatEvent {
  tool_name: string;
  repeat_count: number;
  action: 'none' | 'r1' | 'r2' | 'r3' | 'stop';
}

export interface GrepToolRgFallbackEvent {
  source?: 'share-bin-cached' | 'vendor' | 'share-bin-downloaded';
  outcome: 'resolved' | 'failed';
}

export interface GlobToolRgFallbackEvent {
  source?: 'share-bin-cached' | 'vendor' | 'share-bin-downloaded';
  outcome: 'resolved' | 'failed';
}

export interface FsGrepNodeFallbackEvent {
  reason: 'rg_missing';
}

export interface SubagentCreatedEvent {
  subagent_name: string;
  run_in_background: boolean;
}

export interface McpConnectedEvent {
  server_count: number;
  total_count: number;
}

export interface McpFailedEvent {
  failed_count: number;
  total_count: number;
}

export interface CronMissedEvent {
  count: number;
}

export interface CronScheduledEvent {
  recurring: boolean;
}

export interface CronDeletedEvent {
  task_id: string;
}

export interface CronFiredEvent {
  recurring: boolean;
  coalesced_count: number;
  stale: boolean;
  buffered: boolean;
}

export interface ImageCompressEvent {
  source: string;
  outcome:
    | 'compressed'
    | 'passthrough_fast'
    | 'passthrough_guard'
    | 'passthrough_unsupported'
    | 'passthrough_unhelpful'
    | 'passthrough_error';
  input_mime: string;
  output_mime: string;
  original_bytes: number;
  final_bytes: number;
  original_width: number;
  original_height: number;
  final_width: number;
  final_height: number;
  exif_transposed: boolean;
  duration_ms: number;
}

export interface ImageCropEvent {
  source: string;
  ok: boolean;
  error_kind?:
    | 'empty'
    | 'unsupported_format'
    | 'region_invalid'
    | 'too_large'
    | 'out_of_bounds'
    | 'budget'
    | 'decode_failed';
  resized?: boolean;
  original_width?: number;
  original_height?: number;
  region_area_ratio?: number;
  final_bytes?: number;
  duration_ms: number;
}

export interface VideoUploadEvent {
  model?: string;
  provider_type?: string;
  protocol?: string;
  mime_type: string;
  size_bytes: number;
  outcome: 'success' | 'error';
  duration_ms: number;
  error_type?: string;
}

export interface SessionStartedEvent {
  resumed: boolean;
}

export interface SessionLoadFailedEvent {
  reason: string;
}

export interface FirstLaunchEvent {}

export interface ExitEvent {
  duration_ms: number;
}

export const telemetryEventDefinitions = {
  turn_started: defineTelemetryEvent<TurnStartedEvent>({
    owner: 'kimi-code',
    comment: 'A turn starts running.',
    properties: {
      mode: 'Agent mode the turn runs in',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
    },
  }),
  turn_interrupted: defineTelemetryEvent<TurnInterruptedEvent>({
    owner: 'kimi-code',
    comment: 'A running turn is interrupted.',
    properties: {
      at_step: 'Step index the turn reached before interruption',
      mode: 'Agent mode the turn ran in',
      interrupt_reason: 'Why the turn was interrupted',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
    },
  }),
  turn_ended: defineTelemetryEvent<TurnEndedEvent>({
    owner: 'kimi-code',
    comment: 'A turn ends, unconditionally.',
    properties: {
      reason: 'How the turn ended',
      duration_ms: 'Turn wall-clock time in milliseconds',
      mode: 'Agent mode the turn ran in',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
    },
  }),
  tool_call: defineTelemetryEvent<ToolCallEvent>({
    owner: 'kimi-code',
    comment: 'A tool call finishes execution.',
    properties: {
      turn_id: 'Turn index within the session',
      tool_call_id: 'Provider-assigned tool call id',
      tool_name: 'Registered tool name',
      outcome: 'Execution outcome',
      duration_ms: 'Wall-clock execution time in milliseconds',
      dup_type: 'Whether the call was a duplicate within the same step or across steps',
      error_type: 'Error category when the call failed',
    },
  }),
  api_error: defineTelemetryEvent<ApiErrorEvent>({
    owner: 'kimi-code',
    comment: 'An LLM API request fails.',
    properties: {
      error_type: 'Classified error category',
      model: 'Model id the request targeted',
      alias: 'Model alias the request targeted',
      retryable: 'Whether the error is retryable',
      duration_ms: 'Request wall-clock time in milliseconds',
      status_code: 'HTTP status code when available',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
      input_tokens: "Current turn's accumulated total input tokens",
    },
  }),
  skill_invoked: defineTelemetryEvent<SkillInvokedEvent>({
    owner: 'kimi-code',
    comment: 'A skill is invoked.',
    properties: {
      skill_name: 'Skill name',
      trigger: 'How the skill was triggered',
    },
  }),
  flow_invoked: defineTelemetryEvent<FlowInvokedEvent>({
    owner: 'kimi-code',
    comment: 'A flow-type skill is invoked.',
    properties: { flow_name: 'Flow name' },
  }),
  input_steer: defineTelemetryEvent<InputSteerEvent>({
    owner: 'kimi-code',
    comment: 'The user steers input while a turn is running.',
    properties: { parts: 'Number of input parts' },
  }),
  cancel: defineTelemetryEvent<CancelEvent>({
    owner: 'kimi-code',
    comment: 'The user cancels ongoing work.',
    properties: { from: 'What was running when cancelled' },
  }),
  conversation_undo: defineTelemetryEvent<ConversationUndoEvent>({
    owner: 'kimi-code',
    comment: 'The user undoes conversation entries.',
    properties: { count: 'Number of entries undone' },
  }),
  yolo_toggle: defineTelemetryEvent<YoloToggleEvent>({
    owner: 'kimi-code',
    comment: 'Yolo permission mode is toggled.',
    properties: { enabled: 'Whether yolo mode is now enabled' },
  }),
  afk_toggle: defineTelemetryEvent<AfkToggleEvent>({
    owner: 'kimi-code',
    comment: 'AFK (auto) permission mode is toggled.',
    properties: { enabled: 'Whether auto mode is now enabled' },
  }),
  permission_policy_decision: defineTelemetryEvent<PermissionPolicyDecisionEvent>({
    owner: 'kimi-code',
    comment: 'A permission policy evaluates a tool call.',
    properties: {
      policy_name: 'Name of the deciding policy',
      tool_name: 'Tool being gated',
      permission_mode: 'Active permission mode',
      decision: 'Policy decision',
    },
  }),
  permission_approval_result: defineTelemetryEvent<PermissionApprovalResultEvent>({
    owner: 'kimi-code',
    comment: 'A permission approval prompt resolves.',
    properties: {
      policy_name: 'Name of the asking policy, null when unknown',
      tool_name: 'Tool being approved',
      permission_mode: 'Active permission mode',
      result: 'How the approval resolved',
      approval_surface: 'UI surface that presented the approval',
      duration_ms: 'Time the approval took in milliseconds',
      session_cache_written: 'Whether a session approval rule was cached',
      has_feedback: 'Whether the user attached feedback',
    },
  }),
  plan_submitted: defineTelemetryEvent<PlanSubmittedEvent>({
    owner: 'kimi-code',
    comment: 'A plan is submitted for review.',
    properties: { has_options: 'Whether the plan offered selectable options' },
  }),
  plan_resolved: defineTelemetryEvent<PlanResolvedEvent>({
    owner: 'kimi-code',
    comment: 'A submitted plan is resolved.',
    properties: {
      outcome: 'How the plan was resolved',
      chosen_option: 'Label of the option the user chose',
      has_feedback: 'Whether the user attached revision feedback',
    },
  }),
  plan_enter_resolved: defineTelemetryEvent<PlanEnterResolvedEvent>({
    owner: 'kimi-code',
    comment: 'A request to enter plan mode is resolved.',
    properties: { outcome: 'How the request was resolved' },
  }),
  compaction_finished: defineTelemetryEvent<CompactionFinishedEvent>({
    owner: 'kimi-code',
    comment: 'Context compaction completes.',
    properties: {
      source: 'Whether compaction was triggered manually or automatically',
      tokens_before: 'Token count before compaction',
      tokens_after: 'Token count after compaction',
      duration_ms: 'Compaction wall-clock time in milliseconds',
      compacted_count: 'Number of entries compacted',
      dropped_count: 'Number of entries dropped',
      retry_count: 'Number of retries attempted',
      round: 'Compaction round index',
      thinking_effort: 'Thinking effort level in effect',
      input_tokens: 'Total input tokens (other + cache read + cache creation)',
      output_tokens: 'Output tokens',
      input_cache_read: 'Cache-read input tokens',
      input_cache_creation: 'Cache-creation input tokens',
    },
  }),
  compaction_failed: defineTelemetryEvent<CompactionFailedEvent>({
    owner: 'kimi-code',
    comment: 'Context compaction fails.',
    properties: {
      source: 'Whether compaction was triggered manually or automatically',
      tokens_before: 'Token count before compaction',
      duration_ms: 'Wall-clock time until failure in milliseconds',
      round: 'Compaction round index',
      retry_count: 'Number of retries attempted',
      thinking_effort: 'Thinking effort level in effect',
      error_type: 'Error class name',
    },
  }),
  context_projection_repaired: defineTelemetryEvent<ContextProjectionRepairedEvent>({
    owner: 'kimi-code',
    comment: 'The context projector repairs the outgoing request to keep it wire-valid.',
    properties: {
      reordered: 'Tool results moved back next to their call',
      synthesized: 'Placeholder results invented for lost ones',
      dropped_orphan: 'Results with no matching call dropped',
      duplicate_calls_dropped: 'Tool calls with an already-seen id dropped',
      duplicate_results_dropped: 'Second results for an already-answered id dropped',
      leading_dropped: 'Leading non-user messages dropped',
      assistants_merged: 'Consecutive assistant messages merged',
      whitespace_dropped: 'Whitespace-only text blocks dropped',
    },
  }),
  background_task_created: defineTelemetryEvent<BackgroundTaskCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A background task is created.',
    properties: { kind: 'Task kind, process tasks reported as bash' },
  }),
  background_task_completed: defineTelemetryEvent<BackgroundTaskCompletedEvent>({
    owner: 'kimi-code',
    comment: 'A background task reaches a terminal state.',
    properties: {
      kind: 'Task kind',
      duration_ms: 'Task wall-clock time in milliseconds, null when unknown',
      status: 'Terminal task status',
    },
  }),
  model_switch: defineTelemetryEvent<ModelSwitchEvent>({
    owner: 'kimi-code',
    comment: 'The active model is bound or switched.',
    properties: { model: 'Model alias' },
  }),
  thinking_toggle: defineTelemetryEvent<ThinkingToggleEvent>({
    owner: 'kimi-code',
    comment: 'Thinking effort is toggled.',
    properties: {
      enabled: 'Whether thinking is now enabled',
      effort: 'New thinking effort level',
      from: 'Previous thinking effort level',
    },
  }),
  question_dismissed: defineTelemetryEvent<QuestionDismissedEvent>({
    owner: 'kimi-code',
    comment: 'A user question prompt is dismissed.',
    properties: {},
  }),
  question_answered: defineTelemetryEvent<QuestionAnsweredEvent>({
    owner: 'kimi-code',
    comment: 'A user question prompt is answered.',
    properties: {
      answered: 'Number of questions answered',
      method: 'Input method used to answer',
    },
  }),
  goal_created: defineTelemetryEvent<GoalCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A goal is created.',
    properties: {
      actor: 'Who created the goal',
      replace: 'Whether the goal replaces an existing one',
    },
  }),
  goal_budget_set: defineTelemetryEvent<GoalBudgetSetEvent>({
    owner: 'kimi-code',
    comment: 'A goal budget is set.',
    properties: {
      actor: 'Who set the budget',
      has_token_budget: 'Whether a token budget was set',
      has_turn_budget: 'Whether a turn budget was set',
      has_wall_clock_budget: 'Whether a wall-clock budget was set',
    },
  }),
  goal_continued: defineTelemetryEvent<GoalContinuedEvent>({
    owner: 'kimi-code',
    comment: 'A goal continues into another turn.',
    properties: { turns_used: 'Turns consumed so far' },
  }),
  goal_cleared: defineTelemetryEvent<GoalClearedEvent>({
    owner: 'kimi-code',
    comment: 'A goal is cleared.',
    properties: { actor: 'Who cleared the goal' },
  }),
  goal_status_changed: defineTelemetryEvent<GoalStatusChangedEvent>({
    owner: 'kimi-code',
    comment: 'A goal changes status.',
    properties: {
      actor: 'Who changed the status',
      status: 'New goal status',
      turns_used: 'Turns consumed so far',
      tokens_used: 'Tokens consumed so far',
      wall_clock_ms: 'Wall-clock time consumed so far in milliseconds',
      has_token_budget: 'Whether a token budget was set',
      has_turn_budget: 'Whether a turn budget was set',
      has_wall_clock_budget: 'Whether a wall-clock budget was set',
    },
  }),
  tool_call_dedup_detected: defineTelemetryEvent<ToolCallDedupDetectedEvent>({
    owner: 'kimi-code',
    comment: 'A duplicate tool call is detected.',
    properties: {
      turn_id: 'Turn index within the session',
      step_no: 'Step index within the turn',
      tool_call_id: 'Provider-assigned tool call id',
      tool_name: 'Registered tool name',
      dup_type: 'Whether the duplicate is within the same step or across steps',
      args_hash: 'Hash of the tool call arguments',
    },
  }),
  tool_call_repeat: defineTelemetryEvent<ToolCallRepeatEvent>({
    owner: 'kimi-code',
    comment: 'A repeated tool call streak is detected.',
    properties: {
      tool_name: 'Registered tool name',
      repeat_count: 'Length of the repeat streak',
      action: 'Intervention action taken',
    },
  }),
  grep_tool_rg_fallback: defineTelemetryEvent<GrepToolRgFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The grep tool falls back when resolving ripgrep.',
    properties: {
      source: 'Where ripgrep was resolved from',
      outcome: 'Whether the fallback resolved or failed',
    },
  }),
  glob_tool_rg_fallback: defineTelemetryEvent<GlobToolRgFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The glob tool falls back when resolving ripgrep.',
    properties: {
      source: 'Where ripgrep was resolved from',
      outcome: 'Whether the fallback resolved or failed',
    },
  }),
  fs_grep_node_fallback: defineTelemetryEvent<FsGrepNodeFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The fs grep path falls back to the node implementation.',
    properties: { reason: 'Why the fallback was taken' },
  }),
  subagent_created: defineTelemetryEvent<SubagentCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A subagent run is created.',
    properties: {
      subagent_name: 'Profile name of the subagent',
      run_in_background: 'Whether the subagent runs in the background',
    },
  }),
  mcp_connected: defineTelemetryEvent<McpConnectedEvent>({
    owner: 'kimi-code',
    comment: 'MCP servers connect at session start.',
    properties: {
      server_count: 'Number of servers connected',
      total_count: 'Total number of configured servers',
    },
  }),
  mcp_failed: defineTelemetryEvent<McpFailedEvent>({
    owner: 'kimi-code',
    comment: 'MCP servers fail to connect at session start.',
    properties: {
      failed_count: 'Number of servers that failed',
      total_count: 'Total number of configured servers',
    },
  }),
  cron_missed: defineTelemetryEvent<CronMissedEvent>({
    owner: 'kimi-code',
    comment: 'Cron tasks fire late after being slept through.',
    properties: { count: 'Number of tasks that missed their fire time' },
  }),
  cron_scheduled: defineTelemetryEvent<CronScheduledEvent>({
    owner: 'kimi-code',
    comment: 'A cron task is scheduled.',
    properties: { recurring: 'Whether the task repeats' },
  }),
  cron_deleted: defineTelemetryEvent<CronDeletedEvent>({
    owner: 'kimi-code',
    comment: 'A cron task is deleted.',
    properties: { task_id: 'Cron task id' },
  }),
  cron_fired: defineTelemetryEvent<CronFiredEvent>({
    owner: 'kimi-code',
    comment: 'A cron task fires.',
    properties: {
      recurring: 'Whether the task repeats',
      coalesced_count: 'How many ideal fires collapsed into this delivery',
      stale: 'Whether the task fired past its staleness threshold',
      buffered: 'Whether the fire was buffered while a turn was running',
    },
  }),
  image_compress: defineTelemetryEvent<ImageCompressEvent>({
    owner: 'kimi-code',
    comment: 'An image is compressed before being sent to the model.',
    properties: {
      source: 'Where the image came from',
      outcome: 'Compression outcome',
      input_mime: 'Input MIME type',
      output_mime: 'Output MIME type',
      original_bytes: 'Input size in bytes',
      final_bytes: 'Output size in bytes',
      original_width: 'Input width in pixels',
      original_height: 'Input height in pixels',
      final_width: 'Output width in pixels',
      final_height: 'Output height in pixels',
      exif_transposed: 'Whether EXIF orientation was applied',
      duration_ms: 'Compression wall-clock time in milliseconds',
    },
  }),
  image_crop: defineTelemetryEvent<ImageCropEvent>({
    owner: 'kimi-code',
    comment: 'An image is cropped to a region before being sent to the model.',
    properties: {
      source: 'Where the image came from',
      ok: 'Whether the crop succeeded',
      error_kind: 'Failure category when the crop failed',
      resized: 'Whether the crop was resized',
      original_width: 'Input width in pixels',
      original_height: 'Input height in pixels',
      region_area_ratio: 'Cropped region area relative to the original',
      final_bytes: 'Output size in bytes',
      duration_ms: 'Crop wall-clock time in milliseconds',
    },
  }),
  video_upload: defineTelemetryEvent<VideoUploadEvent>({
    owner: 'kimi-code',
    comment: 'A video is uploaded for the model.',
    properties: {
      model: 'Model the video is uploaded for',
      provider_type: 'Provider protocol type',
      protocol: 'Upload protocol',
      mime_type: 'Video MIME type',
      size_bytes: 'Video size in bytes',
      outcome: 'Upload outcome',
      duration_ms: 'Upload wall-clock time in milliseconds',
      error_type: 'Error class name when the upload failed',
    },
  }),
  session_started: defineTelemetryEvent<SessionStartedEvent>({
    owner: 'kimi-code',
    comment: 'A session becomes active (created, forked, or resumed).',
    properties: { resumed: 'Whether the session was resumed from disk' },
  }),
  session_load_failed: defineTelemetryEvent<SessionLoadFailedEvent>({
    owner: 'kimi-code',
    comment: 'A session resume fails.',
    properties: { reason: 'Error code, error name, or unknown' },
  }),
  first_launch: defineTelemetryEvent<FirstLaunchEvent>({
    owner: 'kimi-code',
    comment: 'The CLI runs for the first time on this device.',
    properties: {},
  }),
  exit: defineTelemetryEvent<ExitEvent>({
    owner: 'kimi-code',
    comment: 'A CLI run exits.',
    properties: { duration_ms: 'Run wall-clock time in milliseconds' },
  }),
} as const;

export type TelemetryEventRegistry = typeof telemetryEventDefinitions;

export type TelemetryEventName = keyof TelemetryEventRegistry;

export type TelemetryEventProperties<K extends TelemetryEventName> =
  TelemetryEventRegistry[K] extends TelemetryEventDefinition<infer P> ? P : never;
