/**
 * `Loop` interface and `createLoop` entry: the options a host supplies (tool executor, requester,
 * hooks, restored input) and the operations it can call on a running loop.
 */
import type { Message, SystemMessage, ToolCall, UserMessage } from '#/llm/message';
import type { PolicyRegistry } from '#/llm/policy/registry';
import type { ToolExecutionHandler } from '#/tool/runtime';
import type { WaitOpts } from '#/utils/wait';
import { createActorLoop } from './loop-actor';
import type { LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookRegistration } from './contract/hook';
import type { RemindMessage } from './contract/inbox';
import type { TurnOutcome } from './contract/outcome';
import type { HookRegistry } from './hook/registry';
import type { LoopLlmRequester, LoopRequestRuntime } from './request';
import type { LoopState } from './state';
import type { WaitForTasks } from './tool/tasks';
import type { ToolCompletionFactory } from './tool/outcome';

export interface LoopToolContext {
  readonly turnId: number;
  readonly step?: number;
  readonly requestId?: string;
  readonly steerSignal?: AbortSignal;
  readonly metadata?: unknown;
  readonly remind?: (message: SystemMessage | UserMessage) => void;
  readonly onForegroundTaskStart?: (taskId: string) => void;
}

export interface LoopToolExecutor {
  execute(call: ToolCall, context: LoopToolContext): ToolExecutionHandler;
}

export interface CreateLoopOptions {
  readonly requester?: LoopLlmRequester;
  readonly executor: LoopToolExecutor;
  readonly toolContext?: (turnId: number) => Omit<LoopToolContext, 'turnId'>;
  readonly hooks?: readonly HookRegistration[];
  readonly input?: LoopInput;
  readonly abortGraceMs?: number;
  readonly completionMessage?: ToolCompletionFactory;
  readonly onListenerError?: (error: unknown, event: LoopEmitted) => void;
}

export interface Loop {
  readonly state: LoopState;
  readonly historyRevision: number;
  readonly executor: LoopToolExecutor;
  readonly waitForTasks: WaitForTasks;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  submit(message: UserMessage): LoopAck<'prompt.submitted'> | undefined;
  notify(message: UserMessage): LoopAck<'prompt.notified'> | undefined;
  remind(...messages: readonly RemindMessage[]): LoopAck<'prompt.reminded'> | undefined;
  flushReminders(): void;
  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined;
  sendNow(message: UserMessage): LoopAck<'prompt.notified'> | undefined;
  sendNow(promptIds: readonly string[]): void;
  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined;
  start(): void;
  resume(): void;
  continue(options?: { readonly force?: boolean }): void;
  abort(reason?: unknown, options?: { readonly continue?: boolean }): void;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string, text?: string, completion?: ToolCompletionFactory): void;
  reset(prepare: () => Promise<LoopInput>): Promise<void>;
  setRequester(requester: LoopLlmRequester | undefined): void;
  operation<T>(create: (runtime: LoopRequestRuntime) => T): T;
  setContext(messages: Message[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined;
  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined;
  subscribe(listener: (event: LoopEmitted) => void): () => void;
  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>>;
  runTurn(message: UserMessage, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export function createLoop(options: CreateLoopOptions): Loop {
  return createActorLoop(options);
}
