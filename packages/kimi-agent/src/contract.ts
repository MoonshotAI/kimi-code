/**
 * contract.ts — Rust agent engine public contract.
 *
 * Standalone type definitions that decouple consumers from the deprecated
 * `@moonshot-ai/agent-core` (v1) and `@moonshot-ai/agent-core-v2` packages.
 *
 * Every type here is defined independently with NO imports from those packages,
 * so consumers can import from `@moonshot-ai/kimi-agent/contract` without
 * pulling in the deprecated v1/v2 dependency trees.
 */

// ─── Turn loop types ───────────────────────────────────────────────────────

export type LoopStepStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'tool_use'
  | 'filtered'
  | 'paused'
  | 'unknown';

export type LoopTerminalStepStopReason = Exclude<LoopStepStopReason, 'tool_use'>;

export type LoopTurnStopReason = LoopTerminalStepStopReason | 'aborted';

export interface TurnResult {
  readonly stopReason: LoopTurnStopReason;
  readonly steps: number;
  readonly usage: TokenUsage;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly total: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

export type ContentPart = import('@moonshot-ai/kosong').ContentPart;

export type ToolCall = import('@moonshot-ai/kosong').ToolCall;

export type LoopMessageBuilder = () =>
  | import('@moonshot-ai/kosong').Message[]
  | Promise<import('@moonshot-ai/kosong').Message[]>;

export interface RunTurnInput {
  readonly turnId: string;
  readonly llm: LLM;
  readonly buildMessages: LoopMessageBuilder;
  readonly buildMessagesStrict?: LoopMessageBuilder | undefined;
  readonly buildMessagesMediaDegraded?: LoopMessageBuilder | undefined;
  readonly buildMessagesMediaStripped?: LoopMessageBuilder | undefined;
  readonly dispatchEvent: (event: unknown) => void;
  readonly tools?: readonly ExecutableTool[] | undefined;
}

export interface LLM {
  readonly model: string;
  readonly provider: string;
  chat(params: LLMChatParams): Promise<LLMChatResponse>;
}

export interface LLMChatParams {
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly ToolInfo[] | undefined;
}

export interface LLMMessage {
  readonly role: string;
  readonly content: string;
  readonly toolCalls?: readonly ToolCall[] | undefined;
  readonly toolCallId?: string | undefined;
}

export interface LLMChatResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: string;
}

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface ExecutableTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  resolveExecution(args: unknown): ToolExecution;
}

export interface ToolExecution {
  readonly description: string;
  readonly execute: () => Promise<string>;
  readonly approvalRule?: string | undefined;
}

// ─── Error types ───────────────────────────────────────────────────────────

/** A Kimi-specific error. */
export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details?: unknown;

  constructor(code: KimiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = details;
  }
}

/** Kimi error codes. */
export const ErrorCodes = {
  UNKNOWN: 'unknown',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  NOT_FOUND: 'not_found',
  INVALID_INPUT: 'invalid_input',
  PERMISSION: 'permission',
  CONFIG: 'config',
  MODEL: 'model',
  TOOL: 'tool',
  SESSION: 'session',
  INTERNAL: 'internal',
  CANCELLED: 'cancelled',
} as const;

export type KimiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

// ─── Minimal shared types ──────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly title?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface KimiConfig {
  readonly path: string;
  readonly model?: string;
  readonly systemPrompt?: string;
  readonly experimentalFlags?: Record<string, boolean>;
}

export interface ContextMessage {
  readonly role: string;
  readonly content: readonly ContentPart[];
}

// ─── RunTurnOverride ───────────────────────────────────────────────────────

export type RunTurnOverride = (
  input: RunTurnInput,
) => Promise<TurnResult>;

// ─── Session-owned agent surface (phase-D thin-client protocol) ─────────
// Wire shapes of the engine's `session/*` JSON-RPC methods. The engine owns
// sessions, agents, goal driving, and persistence; the client installs
// `host/*` handlers and renders from `session.*` lifecycle events.

export interface SessionCreateRequest {
  readonly session_id?: string;
  readonly homedir?: string;
  readonly system_prompt?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly goal_enabled?: boolean;
}

export interface SessionCreateResponse {
  readonly session_id: string;
}

export interface SessionPromptRequest {
  readonly session_id: string;
  /** Content parts on the context wire shape. */
  readonly input: readonly { type: 'text'; text: string }[];
}

export interface SessionPromptResponse {
  /** Debug spelling of the Rust `LoopTurnStopReason` (e.g. `"EndTurn"`). */
  readonly stop_reason: string;
  readonly steps: number;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly total_tokens: number;
  };
}

export interface SessionLoadResponse {
  readonly found: boolean;
}

/** Lifecycle events on the fire-and-forget `host/event` channel. */
export type SessionLifecycleEvent =
  | {
      readonly type: 'session.turn.started';
      readonly session_id: string | null;
      readonly turn_id: number;
    }
  | {
      readonly type: 'session.turn.ended';
      readonly session_id: string | null;
      readonly turn_id: number;
      readonly stop_reason: string;
      readonly steps: number;
    }
  | {
      readonly type: 'session.goal.updated';
      readonly session_id: string | null;
      /** Debug spelling of `GoalStatus`, or `"none"` after a clear. */
      readonly status: string;
    };

/**
 * Streaming events on the same channel, emitted only in native-LLM mode
 * (the engine talks to the provider directly and forwards deltas; in
 * host-proxy mode the host executes `host/llm_chat` itself and already
 * owns the token stream). `session_id` is stamped on by the session-owned
 * agent so multi-session clients can route the stream; it is absent on the
 * host-driven `agent/run_turn` path.
 */
export type SessionStreamEvent =
  | {
      readonly type: 'llm.step.begin';
      readonly model: string;
      readonly session_id?: string | null;
    }
  | {
      readonly type: 'llm.delta';
      readonly part: { readonly type: 'text' | 'think'; readonly text?: string; readonly think?: string };
      readonly session_id?: string | null;
    }
  | {
      readonly type: 'llm.step.end';
      readonly content: string;
      readonly session_id?: string | null;
      readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
    };