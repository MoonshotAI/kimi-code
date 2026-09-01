import type { TelemetryPrimitive } from './telemetry';

export interface TelemetryEventMeta {
  readonly owner: string;
  readonly comment: string;
  readonly properties: Readonly<Record<string, string>>;
}

export interface AgentTelemetryEventContext {
  agent_id: string;
}

export const agentTelemetryContextProperties: {
  readonly [K in keyof AgentTelemetryEventContext]-?: string;
} = {
  agent_id: 'Agent id (main or subagent scope id)',
};

export type TelemetryEventContext = 'none' | 'agent';

export interface TelemetryEventDefinition<P, C extends TelemetryEventContext = 'none'> {
  readonly context: C;
  readonly meta: TelemetryEventMeta;
  readonly _properties?: P;
}

export function defineTelemetryEvent<P>(
  meta: TelemetryEventMeta & { readonly properties: { [K in keyof P]-?: string } },
): TelemetryEventDefinition<P> {
  return { context: 'none', meta };
}

export function defineAgentTelemetryEvent<P>(
  meta: TelemetryEventMeta & { readonly properties: { [K in keyof P]-?: string } },
): TelemetryEventDefinition<P, 'agent'> {
  return { context: 'agent', meta };
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
  turn_id: number;
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
}

export interface TurnInterruptedEvent {
  turn_id: number;
  at_step: number;
  mode: 'agent' | 'plan';
  interrupt_reason: 'user_cancelled' | 'aborted' | 'max_steps' | 'error' | 'filtered' | 'blocked';
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
  trace_id?: string;
}

export interface TurnEndedEvent {
  turn_id: number;
  reason: 'completed' | 'cancelled' | 'failed';
  duration_ms: number;
  mode: 'agent' | 'plan';
  error_type?: string;
  provider_type?: string;
  protocol?: string;
  thinking_effort?: string;
  trace_id?: string;
}

export interface PromptCacheProbeEvent {
  source: 'fork';
  turn_id: number;
  provider_type?: string;
  protocol?: string;
  input_tokens: number;
  input_cache_read: number;
  input_cache_creation: number;
  output_tokens: number;
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
  trace_id?: string;
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
  turn_id?: number;
  request_kind?: string;
  step_no?: number;
  trace_id?: string;
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
  trace_id?: string;
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
  turn_id: number;
  tool_call_id: string;
  policy_name: string;
  tool_name: string;
  permission_mode: TelemetryPermissionMode;
  decision: 'approve' | 'deny' | 'ask';
  [key: string]: TelemetryPrimitive;
}

export interface PermissionApprovalResultEvent {
  turn_id: number;
  tool_call_id: string;
  policy_name: string | null;
  tool_name: string;
  permission_mode: TelemetryPermissionMode;
  result: 'error' | 'approved_for_session' | 'approved' | 'rejected' | 'cancelled';
  approval_surface: string;
  duration_ms: number;
  session_cache_written: boolean;
  has_feedback: boolean;
  trace_id?: string;
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
  turn_id?: number;
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
  trace_id?: string;
}

export interface CompactionFailedEvent {
  turn_id?: number;
  source: 'manual' | 'auto';
  tokens_before: number;
  duration_ms: number;
  round: number;
  retry_count: number;
  thinking_effort: string;
  error_type: string;
  trace_id?: string;
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
  vacuous_dropped: number;
}

export interface BackgroundTaskCreatedEvent {
  task_id: string;
  kind: 'bash' | 'agent' | 'question';
}

export interface BackgroundTaskCompletedEvent {
  task_id: string;
  kind: 'agent' | 'process' | 'question';
  duration_ms: number | null;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
}

export interface WaitForCompletedEvent {
  outcome: 'completed' | 'timed_out' | 'task_not_found' | 'aborted';
  timeout_ms: number;
  waited_ms: number;
  has_task_id: boolean;
  extra_completed_count: number;
}

export interface ModelSwitchEvent {
  model: string;
}

export interface ThinkingToggleEvent {
  enabled: boolean;
  effort: string;
  from: string;
}

export interface QuestionDismissedEvent {
  trace_id?: string;
}

export interface QuestionAnsweredEvent {
  answered: number;
  method?: 'enter' | 'space' | 'number_key';
  trace_id?: string;
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
  turn_id?: number;
  step_no: number;
  tool_call_id: string;
  tool_name: string;
  dup_type: 'same_step' | 'cross_step';
  args_hash: string;
  trace_id?: string;
}

export interface ToolCallRepeatEvent {
  turn_id?: number;
  tool_name: string;
  repeat_count: number;
  action: 'none' | 'r1' | 'r2' | 'r3' | 'stop';
  trace_id?: string;
}

export interface ToolCallTurnRepeatEvent {
  turn_id?: number;
  step_no: number;
  tool_call_id: string;
  tool_name: string;
  turn_repeat_count: number;
  args_hash: string;
  trace_id?: string;
}

export interface AgentsMdReminderShownEvent {
  turn_id: number;
  tool_name: string;
  reminded_count: number;
  trace_id?: string;
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

export interface FsSuggestNodeFallbackEvent {
  reason: 'rg_missing' | 'rg_error';
}

export interface SubagentCreatedEvent {
  subagent_name: string;
  run_in_background: boolean;
  fork: boolean;
  agent_id: string;
  parent_agent_id: string;
  parent_tool_call_id: string;
  model?: string;
  model_source?: 'forced' | 'primary_override' | 'inherited' | 'secondary_pool';
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
  agent_id?: string;
}

export interface CronDeletedEvent {
  task_id: string;
  agent_id?: string;
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
  experimental_flags: string;
}

export interface SessionLoadFailedEvent {
  reason: string;
}

export interface WireRepairEvent {
  kind: 'corrupted' | 'truncated';
  outcome: 'repaired' | 'failed';
  dropped_count: number;
  backup_created: boolean;
}

export interface FirstLaunchEvent {}

export interface ExitEvent {
  duration_ms: number;
}

export interface OauthLoginFinishedEvent {
  provider: string;
  status: 'authenticated' | 'cancelled' | 'expired' | 'denied';
  duration_ms: number;
}

export interface OauthModelsRefreshFinishedEvent {
  changed_count: number;
  unchanged_count: number;
  failed_count: number;
}

export interface AuthEnsureReadyFailedEvent {
  reason: 'provisioning_required' | 'model_not_resolved' | 'token_missing' | 'unexpected';
  has_model_override: boolean;
}

export interface ShellCommandFinishedEvent {
  duration_ms: number;
  is_error: boolean;
  backgrounded: boolean;
}

export interface AgentCreateFailedEvent {
  agent_id: string;
  stage: string;
  error_type: string;
}

export interface SessionEndedEvent {
  reason: 'exit' | 'archive';
}

export interface WebFetchFallbackEvent {
  error_type: string;
  used_api_key: boolean;
}

export interface MediaResolveFallbackEvent {
  kind: 'image' | 'video';
  reason: 'unsupported' | 'read_failed' | 'upload_failed' | 'invalid';
  model?: string;
}

export interface LlmRequestProjectionFallbackEvent {
  projection: 'media-degraded' | 'media-stripped' | 'strict';
  error_type: string;
  model?: string;
  turn_id?: number;
}

export interface SessionIndexDegradedEvent {
  reason: string;
  degraded_count: number;
  error_type?: string;
}

export interface SessionIndexProjectedEvent {
  duration_ms: number;
  session_count: number;
  generation: number;
}

export interface SessionIndexMirrorGiveUpEvent {
  pending_count: number;
  consecutive_failures: number;
}

export interface WorkspaceTrustChangedEvent {
  trusted: boolean;
}

export interface WorkspaceTrustReadFailedEvent {
  error_type: string;
}

export const telemetryEventDefinitions = {
  turn_started: defineAgentTelemetryEvent<TurnStartedEvent>({
    owner: 'kimi-code',
    comment: 'A turn starts running.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      mode: 'Agent mode the turn runs in',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
      thinking_effort: 'Effective thinking effort the turn runs with',
    },
  }),
  turn_interrupted: defineAgentTelemetryEvent<TurnInterruptedEvent>({
    owner: 'kimi-code',
    comment: 'A running turn is interrupted.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      at_step: 'Step index the turn reached before interruption',
      mode: 'Agent mode the turn ran in',
      interrupt_reason: 'Why the turn was interrupted',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
      thinking_effort: 'Effective thinking effort the turn ran with',
      trace_id:
        'Trace id of the most recent LLM request in this turn (the failed request when the turn errored); absent for non-Kimi protocols',
    },
  }),
  turn_ended: defineAgentTelemetryEvent<TurnEndedEvent>({
    owner: 'kimi-code',
    comment: 'A turn ends, unconditionally.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      reason: 'How the turn ended',
      duration_ms: 'Turn wall-clock time in milliseconds',
      mode: 'Agent mode the turn ran in',
      error_type: 'Classified error category when reason is failed',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
      thinking_effort: 'Effective thinking effort the turn ran with',
      trace_id:
        'Trace id of the most recent LLM request in this turn; absent for non-Kimi protocols',
    },
  }),
  prompt_cache_probe: defineAgentTelemetryEvent<PromptCacheProbeEvent>({
    owner: 'kimi-code',
    comment:
      'An agent whose first request is expected to hit the prompt cache reports that request\'s cache usage.',
    properties: {
      source: 'Why a cache hit was expected for this request',
      turn_id: 'Per-agent turn index of the probed request',
      provider_type: 'Provider protocol type',
      protocol: 'Request protocol',
      input_tokens: 'Total input tokens of the probed request (other + cache read + cache creation)',
      input_cache_read: 'Cache-read input tokens of the probed request',
      input_cache_creation: 'Cache-creation input tokens of the probed request',
      output_tokens: 'Output tokens of the probed request',
    },
  }),
  tool_call: defineAgentTelemetryEvent<ToolCallEvent>({
    owner: 'kimi-code',
    comment: 'A tool call finishes execution.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      tool_call_id: 'Provider-assigned tool call id',
      tool_name: 'Registered tool name',
      outcome: 'Execution outcome',
      duration_ms: 'Wall-clock execution time in milliseconds',
      dup_type: 'Whether the call was a duplicate within the same step or across steps',
      error_type: 'Error category when the call failed',
      trace_id:
        'Trace id of the LLM request that produced this tool call; absent for non-Kimi protocols',
    },
  }),
  api_error: defineAgentTelemetryEvent<ApiErrorEvent>({
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
      turn_id: 'Per-agent turn index when the request belongs to a turn; omitted for out-of-turn operations',
      request_kind: "Request source vocabulary: 'turn' for turn requests, the operation's requestKind (e.g. 'full_compaction') otherwise",
      step_no: 'Step index within the turn, when the request belongs to a turn step',
      trace_id:
        'Trace id of the failed request, from its response headers or its error response; absent when the failure happened before any response headers arrived (network errors, local aborts), and for non-Kimi protocols',
    },
  }),
  skill_invoked: defineAgentTelemetryEvent<SkillInvokedEvent>({
    owner: 'kimi-code',
    comment: 'A skill is invoked.',
    properties: {
      skill_name: 'Skill name',
      trigger: 'How the skill was triggered',
    },
  }),
  flow_invoked: defineAgentTelemetryEvent<FlowInvokedEvent>({
    owner: 'kimi-code',
    comment: 'A flow-type skill is invoked.',
    properties: { flow_name: 'Flow name' },
  }),
  input_steer: defineAgentTelemetryEvent<InputSteerEvent>({
    owner: 'kimi-code',
    comment: 'The user steers input while a turn is running.',
    properties: {
      parts: 'Number of input parts',
    },
  }),
  cancel: defineAgentTelemetryEvent<CancelEvent>({
    owner: 'kimi-code',
    comment: 'The user cancels ongoing work.',
    properties: {
      from: 'What was running when cancelled',
      trace_id:
        'Trace id of the in-flight request, or of the most recent request between steps; absent for non-Kimi protocols',
    },
  }),
  conversation_undo: defineAgentTelemetryEvent<ConversationUndoEvent>({
    owner: 'kimi-code',
    comment: 'The user undoes conversation entries.',
    properties: {
      count: 'Number of entries undone',
    },
  }),
  yolo_toggle: defineAgentTelemetryEvent<YoloToggleEvent>({
    owner: 'kimi-code',
    comment: 'Yolo permission mode is toggled.',
    properties: { enabled: 'Whether yolo mode is now enabled' },
  }),
  afk_toggle: defineAgentTelemetryEvent<AfkToggleEvent>({
    owner: 'kimi-code',
    comment: 'AFK (auto) permission mode is toggled.',
    properties: { enabled: 'Whether auto mode is now enabled' },
  }),
  permission_policy_decision: defineAgentTelemetryEvent<PermissionPolicyDecisionEvent>({
    owner: 'kimi-code',
    comment: 'A permission policy evaluates a tool call.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      tool_call_id: 'Provider-assigned tool call id',
      policy_name: 'Name of the deciding policy',
      tool_name: 'Tool being gated',
      permission_mode: 'Active permission mode',
      decision: 'Policy decision',
    },
  }),
  permission_approval_result: defineAgentTelemetryEvent<PermissionApprovalResultEvent>({
    owner: 'kimi-code',
    comment: 'A permission approval prompt resolves.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      tool_call_id: 'Provider-assigned tool call id',
      policy_name: 'Name of the asking policy, null when unknown',
      tool_name: 'Tool being approved',
      permission_mode: 'Active permission mode',
      result: 'How the approval resolved',
      approval_surface: 'UI surface that presented the approval',
      duration_ms: 'Time the approval took in milliseconds',
      session_cache_written: 'Whether a session approval rule was cached',
      has_feedback: 'Whether the user attached feedback',
      trace_id:
        'Trace id of the LLM request that produced the gated tool call; absent for non-Kimi protocols',
    },
  }),
  plan_submitted: defineAgentTelemetryEvent<PlanSubmittedEvent>({
    owner: 'kimi-code',
    comment: 'A plan is submitted for review.',
    properties: {
      has_options: 'Whether the plan offered selectable options',
    },
  }),
  plan_resolved: defineAgentTelemetryEvent<PlanResolvedEvent>({
    owner: 'kimi-code',
    comment: 'A submitted plan is resolved.',
    properties: {
      outcome: 'How the plan was resolved',
      chosen_option: 'Label of the option the user chose',
      has_feedback: 'Whether the user attached revision feedback',
    },
  }),
  plan_enter_resolved: defineAgentTelemetryEvent<PlanEnterResolvedEvent>({
    owner: 'kimi-code',
    comment: 'A request to enter plan mode is resolved.',
    properties: {
      outcome: 'How the request was resolved',
    },
  }),
  compaction_finished: defineAgentTelemetryEvent<CompactionFinishedEvent>({
    owner: 'kimi-code',
    comment: 'Context compaction completes.',
    properties: {
      turn_id: 'Per-agent turn index when compaction ran inside a turn; omitted for manual compaction between turns',
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
      trace_id:
        'Trace id of the final compaction request round; absent for non-Kimi protocols',
    },
  }),
  compaction_failed: defineAgentTelemetryEvent<CompactionFailedEvent>({
    owner: 'kimi-code',
    comment: 'Context compaction fails.',
    properties: {
      turn_id: 'Per-agent turn index when compaction ran inside a turn; omitted for manual compaction between turns',
      source: 'Whether compaction was triggered manually or automatically',
      tokens_before: 'Token count before compaction',
      duration_ms: 'Wall-clock time until failure in milliseconds',
      round: 'Compaction round index',
      retry_count: 'Number of retries attempted',
      thinking_effort: 'Thinking effort level in effect',
      error_type: 'Error class name',
      trace_id:
        'Trace id of the failed compaction request, from its response headers or its error response; absent when the failure happened before any request or before response headers arrived (network errors), and for non-Kimi protocols',
    },
  }),
  context_projection_repaired: defineAgentTelemetryEvent<ContextProjectionRepairedEvent>({
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
      vacuous_dropped: 'Messages dropped because every recorded part serialized to nothing',
    },
  }),
  background_task_created: defineAgentTelemetryEvent<BackgroundTaskCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A background task is created.',
    properties: {
      task_id: 'Background task id; joins background_task_created with background_task_completed',
      kind: 'Task kind; process tasks retain the legacy bash value',
    },
  }),
  background_task_completed: defineAgentTelemetryEvent<BackgroundTaskCompletedEvent>({
    owner: 'kimi-code',
    comment: 'A background task reaches a terminal state.',
    properties: {
      task_id: 'Background task id; joins background_task_created with background_task_completed',
      kind: 'Task kind',
      duration_ms: 'Task wall-clock time in milliseconds, null when unknown',
      status: 'Terminal task status',
    },
  }),
  wait_for_completed: defineAgentTelemetryEvent<WaitForCompletedEvent>({
    owner: 'kimi-code',
    comment: 'A WaitFor tool call returns.',
    properties: {
      outcome:
        'How the wait ended: the waited task finished, the wait timed out, the task id was unknown, or the wait was aborted',
      timeout_ms: 'Timeout argument in milliseconds',
      waited_ms: 'Actual wall-clock wait time in milliseconds',
      has_task_id: 'Whether a specific task id was given',
      extra_completed_count: 'Number of additional tasks that finished within the wait window',
    },
  }),
  model_switch: defineAgentTelemetryEvent<ModelSwitchEvent>({
    owner: 'kimi-code',
    comment: 'The active model is bound or switched.',
    properties: { model: 'Model alias' },
  }),
  thinking_toggle: defineAgentTelemetryEvent<ThinkingToggleEvent>({
    owner: 'kimi-code',
    comment: 'Thinking effort is toggled.',
    properties: {
      enabled: 'Whether thinking is now enabled',
      effort: 'New thinking effort level',
      from: 'Previous thinking effort level',
    },
  }),
  question_dismissed: defineAgentTelemetryEvent<QuestionDismissedEvent>({
    owner: 'kimi-code',
    comment: 'A user question prompt is dismissed.',
    properties: {
      trace_id:
        'Trace id of the LLM request that produced the questioning tool call; absent for non-Kimi protocols',
    },
  }),
  question_answered: defineAgentTelemetryEvent<QuestionAnsweredEvent>({
    owner: 'kimi-code',
    comment: 'A user question prompt is answered.',
    properties: {
      answered: 'Number of questions answered',
      method: 'Input method used to answer',
      trace_id:
        'Trace id of the LLM request that produced the questioning tool call; absent for non-Kimi protocols',
    },
  }),
  goal_created: defineAgentTelemetryEvent<GoalCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A goal is created.',
    properties: {
      actor: 'Who created the goal',
      replace: 'Whether the goal replaces an existing one',
    },
  }),
  goal_budget_set: defineAgentTelemetryEvent<GoalBudgetSetEvent>({
    owner: 'kimi-code',
    comment: 'A goal budget is set.',
    properties: {
      actor: 'Who set the budget',
      has_token_budget: 'Whether a token budget was set',
      has_turn_budget: 'Whether a turn budget was set',
      has_wall_clock_budget: 'Whether a wall-clock budget was set',
    },
  }),
  goal_continued: defineAgentTelemetryEvent<GoalContinuedEvent>({
    owner: 'kimi-code',
    comment: 'A goal continues into another turn.',
    properties: { turns_used: 'Turns consumed so far' },
  }),
  goal_cleared: defineAgentTelemetryEvent<GoalClearedEvent>({
    owner: 'kimi-code',
    comment: 'A goal is cleared.',
    properties: { actor: 'Who cleared the goal' },
  }),
  goal_status_changed: defineAgentTelemetryEvent<GoalStatusChangedEvent>({
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
  tool_call_dedup_detected: defineAgentTelemetryEvent<ToolCallDedupDetectedEvent>({
    owner: 'kimi-code',
    comment: 'A duplicate tool call is detected.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session; omitted when no turn is active',
      step_no: 'Step index within the turn',
      tool_call_id: 'Provider-assigned tool call id',
      tool_name: 'Registered tool name',
      dup_type: 'Whether the duplicate is within the same step or across steps',
      args_hash: 'Hash of the tool call arguments',
      trace_id:
        'Trace id of the LLM request that produced the duplicate tool call; absent for non-Kimi protocols',
    },
  }),
  tool_call_repeat: defineAgentTelemetryEvent<ToolCallRepeatEvent>({
    owner: 'kimi-code',
    comment: 'A repeated tool call streak is detected.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session; omitted when no turn is active',
      tool_name: 'Registered tool name',
      repeat_count: 'Length of the repeat streak',
      action: 'Intervention action taken',
      trace_id:
        'Trace id of the LLM request that produced the repeated tool call; absent for non-Kimi protocols',
    },
  }),
  tool_call_turn_repeat: defineAgentTelemetryEvent<ToolCallTurnRepeatEvent>({
    owner: 'kimi-code',
    comment: 'A tool call reappears within the same turn.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session; omitted when no turn is active',
      step_no: 'Step index within the turn',
      tool_call_id: 'Provider-assigned tool call id',
      tool_name: 'Registered tool name',
      turn_repeat_count: 'Number of prior-step tool-call reappearances counted in the turn',
      args_hash: 'Hash of the tool call arguments',
      trace_id:
        'Trace id of the LLM request that produced the repeated tool call; absent for non-Kimi protocols',
    },
  }),
  agents_md_reminder_shown: defineAgentTelemetryEvent<AgentsMdReminderShownEvent>({
    owner: 'kimi-code',
    comment: 'An AGENTS.md discovery reminder is queued for context injection after a tool call.',
    properties: {
      turn_id: 'Per-agent turn index (main or subagent); pair with agent_id to locate a turn within a session',
      tool_name: 'Registered tool name whose execution discovered the file',
      reminded_count: 'Number of AGENTS.md paths listed in the reminder',
      trace_id:
        'Trace id of the LLM request that produced the tool call; absent for non-Kimi protocols',
    },
  }),
  grep_tool_rg_fallback: defineAgentTelemetryEvent<GrepToolRgFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The grep tool falls back when resolving ripgrep.',
    properties: {
      source: 'Where ripgrep was resolved from',
      outcome: 'Whether the fallback resolved or failed',
    },
  }),
  glob_tool_rg_fallback: defineAgentTelemetryEvent<GlobToolRgFallbackEvent>({
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
  fs_suggest_node_fallback: defineTelemetryEvent<FsSuggestNodeFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The fs suggest path falls back to the node implementation.',
    properties: { reason: 'Why the fallback was taken' },
  }),
  subagent_created: defineTelemetryEvent<SubagentCreatedEvent>({
    owner: 'kimi-code',
    comment: 'A subagent run is created.',
    properties: {
      subagent_name: 'Profile name of the subagent',
      run_in_background: 'Whether the subagent runs in the background',
      fork: 'Whether the subagent was forked with a snapshot of the parent conversation history',
      agent_id: 'Child agent id',
      parent_agent_id: 'Parent (caller) agent id',
      parent_tool_call_id: "Tool call id of the launching call in the parent agent; '' when not launched from a tool call",
      model: 'Model alias the subagent binds to (secondary-model choice or inherited caller model); omitted when no binding was resolved',
      model_source:
        "How the bound model was chosen: 'forced' = [secondary_model].force, 'primary_override' = explicit \"primary\" request, 'inherited' = caller's own model (no pool or fork), 'secondary_pool' = [secondary_model.models] pool pick; omitted when no binding resolution happened (e.g. resume)",
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
    properties: {
      recurring: 'Whether the task repeats',
      agent_id: 'Agent that scheduled the task; omitted for session-level scheduling',
    },
  }),
  cron_deleted: defineTelemetryEvent<CronDeletedEvent>({
    owner: 'kimi-code',
    comment: 'A cron task is deleted.',
    properties: {
      task_id: 'Cron task id',
      agent_id: 'Agent that deleted the task; omitted for session-level deletion (e.g. stale auto-removal)',
    },
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
  video_upload: defineAgentTelemetryEvent<VideoUploadEvent>({
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
    properties: {
      resumed: 'Whether the session was resumed from disk',
      experimental_flags:
        'Sorted comma-separated ids of enabled experimental flags, empty when none are enabled',
    },
  }),
  session_load_failed: defineTelemetryEvent<SessionLoadFailedEvent>({
    owner: 'kimi-code',
    comment: 'A session resume fails.',
    properties: { reason: 'Error code, error name, or unknown' },
  }),
  wire_repair: defineTelemetryEvent<WireRepairEvent>({
    owner: 'kimi-code',
    comment: 'A corrupted wire journal is truncated to its valid prefix and healed on disk.',
    properties: {
      kind: 'Corruption kind: unparseable middle line or torn final line',
      outcome: 'Whether the on-disk repair succeeded',
      dropped_count: 'Journal lines dropped from the corrupted tail',
      backup_created: 'Whether a first-time .bak backup of the corrupted file was created',
    },
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
  oauth_login_finished: defineTelemetryEvent<OauthLoginFinishedEvent>({
    owner: 'kimi-code',
    comment: 'An OAuth login flow reaches a terminal status.',
    properties: {
      provider: 'OAuth provider name',
      status: 'Terminal status of the login flow',
      duration_ms: 'Login flow wall-clock time in milliseconds',
    },
  }),
  oauth_models_refresh_finished: defineTelemetryEvent<OauthModelsRefreshFinishedEvent>({
    owner: 'kimi-code',
    comment: 'A refresh of the managed OAuth provider model catalog finishes.',
    properties: {
      changed_count: 'Number of models added or updated by the refresh',
      unchanged_count: 'Number of models left unchanged',
      failed_count: 'Number of models that failed to refresh',
    },
  }),
  auth_ensure_ready_failed: defineTelemetryEvent<AuthEnsureReadyFailedEvent>({
    owner: 'kimi-code',
    comment: 'Auth readiness check fails before a turn can start.',
    properties: {
      reason: 'Why auth is not ready',
      has_model_override: 'Whether a model override is configured',
    },
  }),
  shell_command_finished: defineAgentTelemetryEvent<ShellCommandFinishedEvent>({
    owner: 'kimi-code',
    comment: 'A shell command execution finishes; this path bypasses the tool executor.',
    properties: {
      duration_ms: 'Execution wall-clock time in milliseconds',
      is_error: 'Whether the execution ended with an error',
      backgrounded: 'Whether the command was sent to the background',
    },
  }),
  agent_create_failed: defineTelemetryEvent<AgentCreateFailedEvent>({
    owner: 'kimi-code',
    comment: 'Agent scope creation fails partway through.',
    properties: {
      agent_id: 'Id of the agent whose creation failed',
      stage: 'Creation stage the failure occurred in',
      error_type: 'Classified error category',
    },
  }),
  session_ended: defineTelemetryEvent<SessionEndedEvent>({
    owner: 'kimi-code',
    comment: 'A session is closed or archived.',
    properties: { reason: 'How the session ended' },
  }),
  web_fetch_fallback: defineTelemetryEvent<WebFetchFallbackEvent>({
    owner: 'kimi-code',
    comment: 'The managed fetch-url provider fails and the call silently falls back to the local fetcher.',
    properties: {
      error_type: 'Classified error category of the managed fetch failure',
      used_api_key: 'Whether a managed access token was obtained before the failure',
    },
  }),
  media_resolve_fallback: defineAgentTelemetryEvent<MediaResolveFallbackEvent>({
    owner: 'kimi-code',
    comment: 'A media part is silently degraded or replaced while resolving model input.',
    properties: {
      kind: 'Media kind being resolved',
      reason: 'Why the media could not be resolved as-is',
      model: 'Model the media was resolved for',
    },
  }),
  llm_request_projection_fallback: defineAgentTelemetryEvent<LlmRequestProjectionFallbackEvent>({
    owner: 'kimi-code',
    comment: 'A rejected LLM request is retried with a degraded context projection.',
    properties: {
      projection: 'Projection policy the request is degraded to',
      error_type: 'Classified error category of the rejection',
      model: 'Model that rejected the request',
      turn_id: 'Per-agent turn index; pair with agent_id to locate a turn within a session',
    },
  }),
  session_index_degraded: defineTelemetryEvent<SessionIndexDegradedEvent>({
    owner: 'kimi-code',
    comment: 'The session index read model degrades to the authoritative directory scan.',
    properties: {
      reason: 'Why the read model degraded',
      degraded_count: 'How many times the read model has degraded so far',
      error_type: 'Classified error category when degradation was caused by an error',
    },
  }),
  session_index_projected: defineTelemetryEvent<SessionIndexProjectedEvent>({
    owner: 'kimi-code',
    comment: 'The session index finishes projecting the sessions directory into the read model.',
    properties: {
      duration_ms: 'Projection wall-clock time in milliseconds',
      session_count: 'Number of sessions projected',
      generation: 'Read model generation after this projection',
    },
  }),
  session_index_mirror_give_up: defineTelemetryEvent<SessionIndexMirrorGiveUpEvent>({
    owner: 'kimi-code',
    comment: 'The session index mirror stops retrying after consecutive write failures.',
    properties: {
      pending_count: 'Number of queued mirror writes left pending',
      consecutive_failures: 'Number of consecutive write failures that triggered the give-up',
    },
  }),
  workspace_trust_changed: defineTelemetryEvent<WorkspaceTrustChangedEvent>({
    owner: 'kimi-code',
    comment: 'A workspace is trusted or untrusted.',
    properties: { trusted: 'Whether the workspace is now trusted' },
  }),
  workspace_trust_read_failed: defineTelemetryEvent<WorkspaceTrustReadFailedEvent>({
    owner: 'kimi-code',
    comment: 'Reading the workspace trust record fails and the workspace silently falls back to untrusted.',
    properties: { error_type: 'Classified error category' },
  }),
} as const;

export type TelemetryEventRegistry = typeof telemetryEventDefinitions;

export type TelemetryEventName = keyof TelemetryEventRegistry;

export type TelemetryEventPayload<K extends TelemetryEventName> =
  TelemetryEventRegistry[K] extends TelemetryEventDefinition<infer P, TelemetryEventContext>
    ? P
    : never;

export type TelemetryEventProperties<K extends TelemetryEventName> =
  TelemetryEventRegistry[K] extends TelemetryEventDefinition<infer P, infer C>
    ? P & (C extends 'agent' ? AgentTelemetryEventContext : object)
    : never;
