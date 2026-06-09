export const KIMI_EXT_CONVERSATION_RESET = 'kimi/conversation_reset';
export const KIMI_EXT_STEP_INTERRUPTED = 'kimi/step_interrupted';
export const KIMI_EXT_COMPACTION = 'kimi/compaction';
export const KIMI_EXT_SUBAGENT_EVENT = 'kimi/subagent_event';

export type KimiCompactionPhase = 'started' | 'completed' | 'cancelled' | 'blocked';
export type KimiCompactionTrigger = 'manual' | 'auto';

export type KimiSubagentPhase =
  | 'spawned'
  | 'started'
  | 'suspended'
  | 'completed'
  | 'failed'
  | 'child_event';

export interface KimiConversationResetNotification {
  sessionId: string;
}

export interface KimiStepInterruptedNotification {
  sessionId: string;
  turnId: number;
  step: number;
  stepId?: string;
  reason: string;
  message?: string;
}

export interface KimiCompactionResult {
  summary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface KimiCompactionNotification {
  sessionId: string;
  phase: KimiCompactionPhase;
  trigger?: KimiCompactionTrigger;
  instruction?: string;
  result?: KimiCompactionResult;
  message?: string;
}

export interface KimiTokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

export type KimiNestedContentPart =
  | { type: 'text'; text: string }
  | { type: 'think'; think: string; encrypted?: string | null };

export interface KimiNestedToolCall {
  type: 'function';
  id: string;
  function: {
    name: string;
    arguments?: string | null;
  };
  extras?: Record<string, unknown> | null;
}

export interface KimiNestedToolCallPart {
  tool_call_id: string;
  arguments_part?: string | null;
}

export interface KimiNestedToolResult {
  tool_call_id: string;
  return_value: {
    is_error: boolean;
    output: unknown;
    message: string;
    display?: unknown[];
    extras?: Record<string, unknown> | null;
  };
}

export interface KimiNestedStatusUpdate {
  context_usage?: number | null;
  context_tokens?: number | null;
  max_context_tokens?: number | null;
  token_usage?: {
    input_other: number;
    output: number;
    input_cache_read: number;
    input_cache_creation: number;
  } | null;
  message_id?: string | null;
}

export type KimiNestedDisplayEvent =
  | { type: 'StepBegin'; payload: { n: number } }
  | { type: 'ContentPart'; payload: KimiNestedContentPart }
  | { type: 'ToolCall'; payload: KimiNestedToolCall }
  | { type: 'ToolCallPart'; payload: KimiNestedToolCallPart }
  | { type: 'ToolResult'; payload: KimiNestedToolResult }
  | { type: 'StatusUpdate'; payload: KimiNestedStatusUpdate };

export interface KimiSubagentNotification {
  sessionId: string;
  parentToolCallId: string;
  parentToolCallUuid?: string;
  parentAgentId?: string;
  subagentId: string;
  subagentName?: string;
  description?: string;
  swarmIndex?: number;
  runInBackground?: boolean;
  phase: KimiSubagentPhase;
  reason?: string;
  resultSummary?: string;
  error?: string;
  usage?: KimiTokenUsage;
  contextTokens?: number;
  event?: KimiNestedDisplayEvent;
}
