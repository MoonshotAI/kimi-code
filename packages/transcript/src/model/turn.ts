import type { TranscriptFrame } from './frame';
import type { AttachmentId, StepId, TaskId, TurnId } from './ids';

/**
 * What triggered this turn. Drives `inputRenderers` at the view layer. The
 * union is closed; per-origin detail rides in `payload` (open content).
 */
export type TurnOrigin =
  | { kind: 'user'; payload?: unknown }
  | { kind: 'cron'; taskId?: TaskId; payload?: unknown }
  | { kind: 'task'; taskId: TaskId; payload?: unknown }
  | { kind: 'hook'; payload?: unknown }
  | { kind: 'compaction'; payload?: unknown }
  | { kind: 'side'; payload?: unknown }
  | { kind: 'other'; payload?: unknown };

export type TurnState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StepState = 'running' | 'completed' | 'interrupted' | 'failed';

export interface TranscriptUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly cost?: number;
}

/**
 * Token usage of one LLM step. Same shape as the engine's `TokenUsage` wire
 * payload — the server copies it through opaquely.
 */
export interface StepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

/** LLM latency breakdown of one step; the wire may carry any subset. */
export interface StepTiming {
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
}

/**
 * Retry detail of a failed step attempt. The engine runs each retry as a
 * fresh step ordinal, so `turn.step.retrying` is the failed attempt's
 * terminal signal: the projection marks that step interrupted and keeps this
 * annotation on its header as historical detail (which attempt failed, what
 * is scheduled next).
 */
export interface StepRetry {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface TranscriptTurn {
  readonly kind: 'turn';
  readonly turnId: TurnId;
  /** Per-agent monotonic ordinal; also the pagination cursor anchor. */
  readonly ordinal: number;
  readonly state: TurnState;
  readonly origin: TurnOrigin;
  /** The raw prompt that opened the turn (user text, cron prompt, …). */
  readonly prompt?: string;
  /** Attachments carried by the turn-opening input (entities in `attachments`). */
  readonly attachmentIds?: readonly AttachmentId[];
  readonly steps: TranscriptStep[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly usage?: TranscriptUsage;
  /** Wall-clock duration of the turn, set on terminal upserts (`turn.ended`). */
  readonly durationMs?: number;
  /**
   * Terminal error message (`turn.ended.error`); the structured payload
   * already rides the 'error' notice marker.
   */
  readonly error?: string;
}

export interface TranscriptStep {
  readonly kind: 'step';
  readonly stepId: StepId;
  readonly turnId: TurnId;
  readonly ordinal: number;
  readonly state: StepState;
  readonly frames: TranscriptFrame[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  /** Token usage of this step's LLM call (`turn.step.completed`). */
  readonly usage?: StepUsage;
  /** Provider finish reason (`finishReason ?? rawFinishReason ?? providerFinishReason`). */
  readonly finishReason?: string;
  readonly timing?: StepTiming;
  readonly retry?: StepRetry;
  /** `turn.step.interrupted` reason / message. */
  readonly endReason?: string;
  readonly endMessage?: string;
}
