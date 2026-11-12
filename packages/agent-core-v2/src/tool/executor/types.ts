import type { ContentPart, ToolCall, ToolDescription } from '#human/llm/message';

export type { ToolCall, ToolDescription };

export type ToolPhase =
  | 'resolve'
  | 'parse'
  | 'starting'
  | 'validate'
  | 'permitting'
  | 'before-execute'
  | 'execute'
  | 'after-execute';

export type ToolFailureType = 'error' | 'timeout' | 'rejected' | 'invalid' | 'resolve' | 'output' | 'unknown';

export type ToolAbortType = 'stopped' | 'abandoned';

export interface ToolFailure {
  readonly outcome: 'failed';
  readonly type: ToolFailureType;
  readonly phase: ToolPhase;
  readonly reason: string;
  readonly data?: unknown;
}

export interface ToolAbort {
  readonly outcome: 'aborted';
  readonly type: ToolAbortType;
  readonly phase: ToolPhase;
  readonly reason: string;
  readonly data?: unknown;
}

export type ToolError = ToolFailure | ToolAbort;

export type ToolOutcome =
  | { readonly type: 'success' }
  | { readonly type: 'failed'; readonly error: ToolFailure }
  | { readonly type: 'aborted'; readonly error: ToolAbort };

export interface ToolResult {
  readonly toolCallId: string;
  readonly content: ContentPart[];
  readonly outcome: ToolOutcome;
}

export type ToolReturn =
  | { readonly content: ContentPart[]; readonly outcome?: 'success'; readonly stopTurn?: boolean; readonly stopTurnReason?: string }
  | {
      readonly content: ContentPart[];
      readonly outcome: 'failed';
      readonly subtype?: 'error' | 'timeout';
      readonly reason: string;
      readonly data?: unknown;
    };

export interface ToolAcknowledgement {
  readonly content: ContentPart[];
  readonly brief?: string;
}

export interface ToolDetachAck extends ToolAcknowledgement {
  readonly detached: true;
  readonly taskId: string;
  readonly toolCallId: string;
}

export type ToolExecutionResponse = ToolResult | ToolDetachAck;

export interface ToolOutputSnapshot {
  readonly totalBytes: number;
  readonly preview: string;
  readonly truncated: boolean;
  readonly path?: string;
  readonly error?: string;
}

export interface ToolOutput {
  readonly closed?: boolean;
  append(chunk: string): number | undefined;
  onAppend?(listener: (chunk: string, offset: number) => void): () => void;
  preview(maxBytes?: number): ToolOutputSnapshot;
  read(offset: number, maxBytes: number): Promise<string>;
  flush(): Promise<void>;
  close(): Promise<void>;
  error(): string | undefined;
}

export interface ToolOutputStore {
  open(taskId: string): ToolOutput;
}

export interface ToolTimeSpan {
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly elapsedMs: number;
}

export interface ToolTiming {
  readonly total: ToolTimeSpan;
  readonly execute: ToolTimeSpan | null;
}

export type ToolExecutionStatus = 'running' | 'stopping' | 'success' | 'failed' | 'aborted';

export interface ToolExecutionSnapshot<TFields extends object = object, TPrepared = unknown> {
  readonly id: string;
  readonly taskId: string;
  readonly name: string;
  readonly status: ToolExecutionStatus;
  readonly phase: ToolPhase;
  readonly args: unknown;
  readonly timing: ToolTiming;
  readonly detached: boolean;
  readonly fields: Readonly<Partial<TFields>>;
  readonly prepared?: TPrepared;
  readonly error?: ToolError;
  readonly stopReason?: string;
  readonly outputError?: string;
}

export interface ToolView<TFields extends object = object, TPrepared = unknown> {
  snapshot(): ToolExecutionSnapshot<TFields, TPrepared>;
  output(maxPreviewBytes?: number): ToolOutputSnapshot;
  fields(): Readonly<Partial<TFields>>;
}

export interface ToolPrepareContext<TArgs = unknown, TContext = unknown> {
  readonly call: ToolCall;
  readonly taskId: string;
  readonly args: TArgs;
  readonly context: TContext;
  readonly signal: AbortSignal;
}

export interface ToolDecisionContext<TArgs = unknown, TContext = unknown, TPrepared = unknown>
  extends ToolPrepareContext<TArgs, TContext> {
  readonly prepared: TPrepared;
}

export interface ToolExecuteContext<
  TArgs = unknown,
  TContext = unknown,
  TFields extends object = object,
  TPrepared = unknown,
> extends ToolDecisionContext<TArgs, TContext, TPrepared>, ToolView<TFields, TPrepared> {
  detach(reason?: unknown, acknowledgement?: ToolAcknowledgement): ToolDetachAck | undefined;
  onDetach(acknowledge: (reason: unknown) => ToolAcknowledgement): void;
  write(text: string): number | undefined;
  flush(): Promise<void>;
  set(fields: Partial<TFields>): void;
}

export interface ToolStoppingContext<TFields extends object = object, TPrepared = unknown>
  extends ToolView<TFields, TPrepared> {
  readonly reason: unknown;
  readonly abandon: (result?: ToolReturn) => void;
}

export interface AfterExecuteHookContext<TArgs = unknown, TContext = unknown, TPrepared = unknown>
  extends ToolDecisionContext<TArgs, TContext, TPrepared> {
  readonly fields: Readonly<Record<string, unknown>>;
  result: ToolResult;
  set(fields: Record<string, unknown>): void;
}

export type ToolHandlerEvent<TFields extends object = object, TPrepared = unknown> =
  | {
      readonly type: 'change';
      readonly previous: ToolExecutionSnapshot<TFields, TPrepared>;
      readonly snapshot: ToolExecutionSnapshot<TFields, TPrepared>;
    }
  | { readonly type: 'output'; readonly offset: number; readonly text: string };

export class ToolTimeoutError extends Error {
  override readonly name = 'ToolTimeoutError';

  constructor(readonly timeoutMs: number) {
    super(`Tool wait timed out after ${String(timeoutMs)}ms`);
  }
}

export interface ToolExecutionHandler<TFields extends object = object, TPrepared = unknown>
  extends ToolView<TFields, TPrepared>, PromiseLike<ToolExecutionResponse> {
  readonly taskId: string;
  wait(timeoutMs?: number, signal?: AbortSignal): Promise<ToolResult>;
  stop(reason?: unknown): Promise<ToolResult>;
  detach(reason?: unknown, acknowledgement?: ToolAcknowledgement): ToolDetachAck | undefined;
  observe(listener: (event: ToolHandlerEvent<TFields, TPrepared>) => void): () => void;
}

export type ToolExecutionEvent<TFields extends object = object, TPrepared = unknown, TContext = unknown> = {
  readonly call: ToolCall;
  readonly context: TContext;
  readonly handler: ToolExecutionHandler<TFields, TPrepared>;
} & ({ readonly type: 'created' } | ToolHandlerEvent<TFields, TPrepared>);

export interface ToolExecutorHook<TContext = unknown, TPrepared = unknown> {
  validating?(
    context: ToolPrepareContext<any, TContext>,
  ): ToolDecision | void;
  starting?(
    context: ToolDecisionContext<any, TContext, TPrepared>,
  ): ToolStartingDecision | void | Promise<ToolStartingDecision | void>;
  permitting?(
    context: ToolDecisionContext<any, TContext, TPrepared>,
  ): ToolDecision | void | Promise<ToolDecision | void>;
  beforeExecute?(context: ToolDecisionContext<any, TContext, TPrepared>): void | Promise<void>;
  afterExecute?(
    context: AfterExecuteHookContext<any, TContext, TPrepared>,
  ): ToolResult | void | Promise<ToolResult | void>;
  observe?(event: ToolExecutionEvent<any, TPrepared, TContext>): void;
}

export interface ToolCallRewrite {
  readonly args: unknown;
}

export interface ToolCallRejection {
  readonly reject: string;
  readonly data?: unknown;
  readonly result?: ToolReturn;
}

export type ToolDecision = ToolCallRewrite | ToolCallRejection;

export interface ToolPermitSkip {
  readonly skipPermitting: true;
  readonly args?: unknown;
}

export type ToolStartingDecision = ToolDecision | ToolPermitSkip;

export interface ToolExecutorPolicy<TContext = unknown, TPrepared = unknown> {
  readonly outputStore?: ToolOutputStore;
  readonly hook?: ToolExecutorHook<TContext, TPrepared>;
  readonly renderError?: (call: ToolCall, error: ToolError) => ContentPart[];
  readonly detached?: (
    call: ToolCall,
    snapshot: ToolExecutionSnapshot<any, TPrepared>,
    reason: unknown,
  ) => ToolAcknowledgement;
  readonly now?: () => number;
  readonly tick?: () => number;
}

export type ToolExecute<TArgs = unknown, TContext = unknown, TFields extends object = object, TPrepared = unknown> = (
  context: ToolExecuteContext<TArgs, TContext, TFields, TPrepared>,
) => ToolReturn | Promise<ToolReturn>;

export type ToolPreparation<TPrepared> =
  | { readonly type: 'execute'; readonly prepared: TPrepared }
  | { readonly type: 'synthetic'; readonly prepared: TPrepared; readonly result: ToolReturn };

export interface ExecutableTool<TArgs = unknown, TContext = unknown, TFields extends object = object, TPrepared = undefined>
  extends ToolDescription {
  prepare?(
    context: ToolPrepareContext<TArgs, TContext>,
  ): ToolPreparation<TPrepared> | Promise<ToolPreparation<TPrepared>>;
  execute?: ToolExecute<TArgs, TContext, TFields, TPrepared>;
  stopping?(context: ToolStoppingContext<TFields, TPrepared>): void;
}
