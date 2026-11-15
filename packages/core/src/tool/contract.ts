/**
 * Contract of the hook-aware tool executor (`createToolExecutor`): tool results, execution input,
 * handlers, the starting/permitting/ending hooks and their decisions, and runtime guards for tool
 * results and executor hosts.
 */
import type { ContentPart, ToolCall, ToolDescription } from '#/llm/message';

export interface Cause {
  readonly by?: string;
  readonly reason: string;
  readonly message?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ToolUpdate {
  key: string;
  text: string;
  percent?: number;
}

export interface ToolResult {
  content: ContentPart[];
  isError?: boolean;
  durationMs?: number;
  blocked?: Cause;
}

export interface ToolInput {
  toolCall: ToolCall;
  signal: AbortSignal;
}

export interface ToolDetachAck {
  text: string;
}

export type ToolDetachInput = string | ToolDetachAck;

export interface TaskWaitInput {
  taskId?: string;
  timeoutMs: number;
}

export interface TaskWaitOutcome {
  completed: string[];
  running: string[];
  unknown: string[];
  timedOut: boolean;
}

export type ToolHookPoint = 'tool.starting' | 'tool.permitting' | 'tool.ending';

export type ToolHookFailurePolicy = 'pause' | 'block';

export interface ToolStartingHookEvent {
  readonly toolCall: ToolCall;
  readonly turnId?: number;
  readonly step?: number;
  readonly signal: AbortSignal;
}

export type ToolPermittingHookEvent = ToolStartingHookEvent;

export interface ToolEndingHookEvent {
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
  readonly failed: boolean;
  readonly turnId?: number;
  readonly step?: number;
  readonly signal: AbortSignal;
}

export type ToolStartingDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: Cause; readonly result?: ToolResult }
  | { readonly skipPermitting: true };

export type ToolPermittingDecision =
  | { readonly toolCall: ToolCall }
  | { readonly blocked: Cause; readonly result?: ToolResult };

export type ToolEndingDecision = { readonly result?: ToolResult };

type ToolHook<E, D> = (event: E, signal: AbortSignal) => Promise<void | D> | void | D;

export interface ToolHooks {
  readonly 'tool.starting': ToolHook<ToolStartingHookEvent, ToolStartingDecision>;
  readonly 'tool.permitting': ToolHook<ToolPermittingHookEvent, ToolPermittingDecision>;
  readonly 'tool.ending': ToolHook<ToolEndingHookEvent, ToolEndingDecision>;
}

export type ToolHookRegistration = {
  [P in ToolHookPoint]: {
    readonly point: P;
    readonly hook: ToolHooks[P];
    readonly id?: string;
    readonly onFailure?: ToolHookFailurePolicy;
  };
}[ToolHookPoint];

export interface ToolHookInfo {
  readonly id: string;
  readonly point: ToolHookPoint;
  readonly onFailure: ToolHookFailurePolicy;
  readonly paused: boolean;
}

export interface ToolHookFailure {
  readonly hookId?: string;
  readonly error: unknown;
  readonly paused: boolean;
  readonly blocking: boolean;
}

export interface ToolExecutorHooks {
  add(registration: ToolHookRegistration): string;
  remove(id: string): void;
  list(): ToolHookInfo[];
}

export interface ToolExecuteInput extends ToolInput {
  turnId?: number;
  step?: number;
  onUpdate?: (update: ToolUpdate) => void;
  detach?: (input: ToolDetachInput) => void;
  waitForTasks?: (input: TaskWaitInput) => Promise<TaskWaitOutcome>;
  onAdjudicated?: (final: ToolCall, blocked?: Cause) => void;
  onHookFailure?: (point: ToolHookPoint, failure: ToolHookFailure) => void;
}

export interface ToolHandler {
  execute(input: ToolExecuteInput): Promise<ToolResult>;
}

export interface ToolDefinition extends ToolDescription, ToolHandler {}

export interface ToolExecutor extends Pick<ToolHandler, 'execute'> {
  readonly adjudicates?: true;
}

export interface ToolSchema<Args> {
  readonly jsonSchema: Record<string, unknown>;
  parse(value: unknown): Args | undefined;
}

export interface TypedToolInput<Args> extends ToolExecuteInput {
  args: Args;
}

export interface ExecutorPolicy {
  readonly maxResultChars?: number;
}

export interface RegisterOptions {
  readonly onIdle?: () => void;
}

export interface ToolExecutorHost extends ToolExecutor {
  readonly hooks: ToolExecutorHooks;
  register(definition: ToolDefinition, options?: RegisterOptions): () => void;
  register(name: string, handler: ToolHandler, options?: RegisterOptions): () => void;
  invalidate(name: string, reason: string): void;
  restore(name: string): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCause(value: unknown): value is Cause {
  return (
    isObject(value) &&
    typeof value['reason'] === 'string' &&
    (value['by'] === undefined || typeof value['by'] === 'string') &&
    (value['message'] === undefined || typeof value['message'] === 'string') &&
    (value['details'] === undefined || isObject(value['details']))
  );
}

export function isToolResult(value: unknown): value is ToolResult {
  return (
    isObject(value) &&
    Array.isArray(value['content']) &&
    value['content'].every((part) => isObject(part) && typeof part['type'] === 'string') &&
    (value['blocked'] === undefined || isCause(value['blocked']))
  );
}

export function isToolExecutorHost(value: object): value is ToolExecutorHost {
  const record = value as Record<string, unknown>;
  const hooks = record['hooks'];
  return (
    typeof record['execute'] === 'function' &&
    typeof record['register'] === 'function' &&
    typeof record['invalidate'] === 'function' &&
    typeof record['restore'] === 'function' &&
    isObject(hooks) &&
    typeof hooks['add'] === 'function' &&
    typeof hooks['remove'] === 'function' &&
    typeof hooks['list'] === 'function'
  );
}
