export type ConversationItemStatus = 'running' | 'ended';

export type ConversationOutcome = 'completed' | 'interrupted' | 'failed';

export type ConversationEndReason = 'user_cancelled' | 'aborted' | 'max_steps' | 'error' | 'filtered' | 'blocked';

export type ConversationContinuation = 'turn' | 'background' | 'none';

export interface ConversationError {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly status_code?: number;
  readonly request_id?: string;
  readonly retryable?: boolean;
}

export interface ConversationUsage {
  readonly input_other: number;
  readonly output: number;
  readonly input_cache_read: number;
  readonly input_cache_creation: number;
}

export interface ConversationStep {
  readonly index: number;
  readonly outcome: ConversationOutcome;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly finish_reason?: string;
  readonly usage?: ConversationUsage;
}

export interface ConversationRetry {
  readonly attempt: number;
  readonly next_attempt: number;
  readonly max_attempts: number;
  readonly delay_ms: number;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly status_code?: number;
  };
}

export interface ConversationRequestTiming {
  readonly first_token_ms?: number;
  readonly stream_ms?: number;
  readonly request_build_ms?: number;
  readonly server_first_token_ms?: number;
  readonly server_decode_ms?: number;
  readonly client_consume_ms?: number;
  readonly client_blocked_ms?: number;
}

export interface ConversationRequestDebug {
  readonly finish_reason?: string;
  readonly usage?: ConversationUsage;
  readonly timing?: ConversationRequestTiming;
}

interface ConversationItemBase {
  readonly item_id: string;
  readonly step_index?: number;
  readonly debug?: ConversationRequestDebug;
  readonly status: ConversationItemStatus;
  readonly outcome?: ConversationOutcome;
  readonly created_at: string;
}

export type ConversationOrigin =
  | { readonly kind: 'user' }
  | { readonly kind: 'skill'; readonly name: string; readonly path?: string; readonly args?: string }
  | { readonly kind: 'plugin_command'; readonly plugin_id: string; readonly command: string; readonly args?: string }
  | {
      readonly kind: 'cron';
      readonly job_id: string;
      readonly schedule: string;
      readonly recurring: boolean;
      readonly coalesced_count: number;
      readonly stale: boolean;
    }
  | { readonly kind: 'hook'; readonly hook_event: string }
  | { readonly kind: 'goal' }
  | { readonly kind: 'retry' }
  | { readonly kind: 'system' };

export interface ConversationAttachment {
  readonly kind: 'image' | 'video' | 'audio' | 'file';
  readonly file_id?: string;
  readonly url?: string;
  readonly name?: string;
  readonly media_type?: string;
  readonly size?: number;
  readonly ordinal: number;
}

export interface ConversationSkill {
  readonly name: string;
  readonly path?: string;
  readonly args?: string;
}

export interface UserMessageItem extends ConversationItemBase {
  readonly type: 'user_message';
  readonly prompt_ids: readonly string[];
  readonly placement: 'opener' | 'steer';
  readonly origin: ConversationOrigin;
  readonly text: string;
  readonly attachments: readonly ConversationAttachment[];
  readonly skills: readonly ConversationSkill[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AssistantMessageItem extends ConversationItemBase {
  readonly type: 'assistant_message';
  readonly text: string;
}

export interface ReasoningItem extends ConversationItemBase {
  readonly type: 'reasoning';
  readonly text: string;
  readonly started_at: string;
  readonly duration_ms?: number;
}

export interface ConversationMedia {
  readonly kind: 'image' | 'video' | 'audio';
  readonly file_id?: string;
  readonly url?: string;
  readonly media_type?: string;
}

export interface ToolProgress {
  readonly percent?: number;
  readonly status?: string;
  readonly custom_kind?: string;
  readonly custom_data?: unknown;
}

export interface AgentRef {
  readonly agent_id: string;
  readonly role: 'child' | 'member';
  readonly swarm_index?: number;
  readonly task_id?: string;
}

export interface PlanReviewDisplay {
  readonly kind: 'plan_review';
  readonly plan: string;
  readonly path?: string;
  readonly options: readonly { readonly label: string; readonly description: string }[];
  readonly review: {
    readonly state: 'pending' | 'approved' | 'rejected' | 'cancelled';
    readonly selected_option?: string;
    readonly feedback?: string;
  };
}

export interface ToolCallItem extends ConversationItemBase {
  readonly type: 'tool_call';
  readonly name: string;
  readonly stage?: 'input' | 'awaiting_approval' | 'executing';
  readonly input?: unknown;
  readonly input_text?: string;
  readonly fields?: Readonly<Record<string, unknown>>;
  readonly display?: unknown;
  readonly output?: string;
  readonly media?: readonly ConversationMedia[];
  readonly error?: string;
  readonly note?: string;
  readonly progress?: ToolProgress;
  readonly task_id?: string;
  readonly interaction_id?: string;
  readonly agent_refs?: readonly AgentRef[];
  readonly started_at: string;
  readonly ended_at?: string;
}

export interface NotificationItem extends ConversationItemBase {
  readonly type: 'notification';
  readonly notification_id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly notification_type: string;
  readonly source: { readonly kind: string; readonly id: string };
  readonly task_id?: string;
  readonly agent_id?: string;
  readonly output?: {
    readonly file?: string;
    readonly preview?: string;
    readonly bytes?: number;
    readonly truncated?: boolean;
  };
  readonly answer?: {
    readonly answers: Readonly<Record<string, string | true>>;
    readonly note?: string;
  };
}

export interface CompactionItem extends ConversationItemBase {
  readonly type: 'system';
  readonly kind: 'compaction';
  readonly trigger: 'auto' | 'manual';
  readonly instruction?: string;
  readonly tokens_before?: number;
  readonly tokens_after?: number;
  readonly compacted_count?: number;
  readonly summary?: string;
  readonly error?: ConversationError;
}

export interface ForkBoundaryItem extends ConversationItemBase {
  readonly type: 'system';
  readonly kind: 'fork_boundary';
  readonly source: 'btw' | 'fork';
  readonly forked_from: { readonly agent_id: string };
}

export type SystemItem = CompactionItem | ForkBoundaryItem;

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | ToolCallItem
  | NotificationItem
  | SystemItem;

export interface ConversationTurnHeader {
  readonly turn_id: string;
  readonly ordinal: number;
  readonly kind: 'agent' | 'system';
  readonly status: ConversationItemStatus;
  readonly outcome?: ConversationOutcome;
  readonly end_reason?: ConversationEndReason;
  readonly continuation?: ConversationContinuation;
  readonly error?: ConversationError;
  readonly retry?: ConversationRetry;
  readonly turn_number?: number;
  readonly started_at: string;
  readonly ended_at?: string;
  readonly duration_ms?: number;
  readonly usage?: ConversationUsage;
  readonly steps: readonly ConversationStep[];
}

export interface ConversationTurn extends ConversationTurnHeader {
  readonly items: readonly ConversationItem[];
}

export interface ConversationTurnsPage {
  readonly turns: readonly ConversationTurn[];
  readonly has_more: boolean;
}

export type ItemDeltaField = 'text' | 'input_text' | 'output';

export type ConversationEventFrame =
  | { readonly type: 'turn.started' | 'turn.ended'; readonly turn: ConversationTurnHeader }
  | { readonly type: 'turn.updated'; readonly turn_id: string; readonly step?: ConversationStep; readonly retry?: ConversationRetry }
  | { readonly type: 'item.started' | 'item.ended'; readonly turn_id: string; readonly item: ConversationItem }
  | { readonly type: 'item.updated'; readonly turn_id: string; readonly item_id: string; readonly set: Partial<ToolCallItem> }
  | {
      readonly type: 'item.delta';
      readonly turn_id: string;
      readonly item_id: string;
      readonly field: ItemDeltaField;
      readonly delta: string;
    }
  | { readonly type: 'item.removed'; readonly turn_id: string; readonly item_id: string }
  | { readonly type: 'turns.removed'; readonly turn_ids: readonly string[] };

export interface ConversationNotice {
  readonly level: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly detail?: string;
  readonly code?: string;
}

export interface ConversationLoadError {
  readonly code: number;
  readonly msg: string;
}

export type ConversationFrame =
  | ({ readonly type: 'turns' } & ConversationTurnsPage)
  | ({ readonly type: 'turns.failed' } & ConversationLoadError)
  | ConversationEventFrame
  | ({ readonly type: 'notice' } & ConversationNotice);

export const CONVERSATION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'turns',
  'turns.removed',
  'turns.failed',
  'turn.started',
  'turn.updated',
  'turn.ended',
  'item.started',
  'item.updated',
  'item.ended',
  'item.delta',
  'item.removed',
  'notice',
]);
