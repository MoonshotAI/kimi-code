import type { Message, SystemMessage, ToolCall, UserMessage } from '#/llm/message';
import type { PolicyRegistry } from '#/llm/policy/registry';
import type { ToolExecutionHandler } from '#/tool/types';
import type { WaitOpts } from '#/utils/wait';
import { createActorLoop } from './loop-actor';
import type { LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { LoopHooks } from './contract/hook';
import type { RemindMessage } from './contract/inbox';
import type { TurnOutcome } from './contract/outcome';
import type { LoopLlmRequester, LoopRequestRuntime } from './request';
import type { LoopState } from './state';
import type { WaitForTasks } from './tool/tasks';
import type { ToolCompletionFactory } from './tool/outcome';

export interface LoopToolContext {
  readonly origin: 'loop';
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
  readonly toolContext?: (turnId: number) => Omit<LoopToolContext, 'origin' | 'turnId'>;
  readonly hook?: Partial<LoopHooks>;
  readonly input?: LoopInput;
  readonly abortGraceMs?: number;
  readonly completionMessage?: ToolCompletionFactory;
  readonly shouldQueueTaskNotification?: (taskId: string) => boolean;
  readonly onListenerError?: (error: unknown, event: LoopEmitted) => void;
}

export interface Loop {
  readonly state: LoopState;
  readonly historyRevision: number;
  readonly executor: LoopToolExecutor;
  readonly waitForTasks: WaitForTasks;
  readonly policy: PolicyRegistry;
  setRequester(requester: LoopLlmRequester | undefined): void;
  setContext(messages: Message[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined;
  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined;
  /**
   * Queues a user message at the tail of the normal inbox and emits
   * `prompt.submitted`. Releases the intake hold (`state.held`), so an idle
   * loop with no unsettled detached completions immediately schedules a new
   * turn; a queued normal message takes priority over queued notify messages.
   *
   * Returns `undefined` once the loop is closed and does not accept the
   * message. Throws `TypeError` when `message` is not a user message.
   */
  submit(message: UserMessage): LoopAck<'prompt.submitted'> | undefined;
  /**
   * Queues a user message at the tail of the notify inbox and emits
   * `prompt.notified`. Releases the intake hold but never interrupts the
   * active turn: the turn ends with a `done` outcome (cause `notify`) when it
   * reaches its `continuing` host hook (a resumed turn yields at `starting`
   * instead), and the queued notify messages then start a new turn. When more
   * notify messages are queued behind the one that starts that turn, the turn
   * is `promptOnly` — it only appends its message and runs no steps, and the
   * last queued notify starts the turn that runs steps over the full history.
   *
   * Returns `undefined` once the loop is closed and does not accept the
   * message. Throws `TypeError` when `message` is not a user message.
   */
  notify(message: UserMessage): LoopAck<'prompt.notified'> | undefined;
  /**
   * Queues messages in the remind inbox and emits `prompt.reminded` for each.
   * Does not release the intake hold and never wakes the scheduler: queued
   * reminders are merged into the initial pending of the next turn that is
   * not `promptOnly`, or flushed straight into history by
   * {@link Loop.flushReminders}.
   *
   * Returns the last acknowledgement, or `undefined` once the loop is closed
   * or when called with no messages. Throws `TypeError` when any argument is
   * not a message.
   */
  remind(...messages: readonly RemindMessage[]): LoopAck<'prompt.reminded'> | undefined;
  /**
   * Queues a user message like {@link Loop.notify} and additionally
   * interrupts the active turn's in-flight work: the current step's LLM
   * request is cancelled when the step is still in `stepStarting` or
   * `requesting` and the response has not started streaming tool calls, and
   * the interrupted turn then ends early with a `done` outcome (cause
   * `steered`) without running the regular step-ending hooks. When the turn
   * is past that point (or idle), the message simply waits in the notify
   * inbox as with `notify`.
   *
   * Returns `undefined` once the loop is closed and does not accept the
   * message. Throws `TypeError` when `message` is not a user message.
   */
  sendNow(message: UserMessage): LoopAck<'prompt.notified'> | undefined;
  /**
   * Queues a user message like {@link Loop.notify}, forcing
   * `promptOnly: true` — the message is appended to history without running
   * steps — but keeps the intake hold parked: the notification does not wake
   * the scheduler and is consumed only after another input (`submit`,
   * `notify`, `sendNow`, `start`, …) releases the hold. Emits
   * `prompt.notified`.
   *
   * Returns `undefined` once the loop is closed and does not accept the
   * message. Throws `TypeError` when `message` is not a user message.
   */
  recordNotification(message: UserMessage): LoopAck<'prompt.notified'> | undefined;

  /**
   * Releases the intake hold (`state.held`), allowing the scheduler to pick
   * up queued inbox input. The loop is created held, so input supplied via
   * `CreateLoopOptions.input.inbox` (or parked by `recordNotification`) is
   * not scheduled until `start` or another intake-releasing call. No-op once
   * the loop is closed.
   */
  start(): void;
  /**
   * Continues the interrupted turn recovered from `input.unfinished` when it
   * is resumable (see {@link Loop.continue}); no-op otherwise.
   */
  resume(): void;
  reset(prepare: () => Promise<LoopInput>): Promise<void>;
  close(): Promise<void>;
  
  /**
   * Advances the loop once it is idle and detached completions have settled
   * (the call is retried automatically while completions are pending):
   *
   * 1. When an interrupted turn is resumable, activates a `resume` turn that
   *    re-enters it at its recorded step.
   * 2. Otherwise, when no inbox input is queued and history can continue
   *    (tail is a user or tool message — or `force` is set), activates a
   *    fresh `continue` turn with no new input.
   * 3. Otherwise releases the intake hold so queued inbox input is scheduled.
   *
   * No-op once the loop is closed.
   */
  continue(options?: { readonly force?: boolean }): void;
  flushReminders(): void;
  /**
   * Moves the named messages from the normal inbox to the notify inbox and
   * emits `prompt.steered` with the messages that actually moved (unknown
   * ids are ignored). When anything moved, releases the intake hold and
   * interrupts the active turn's in-flight request as {@link Loop.sendNow}
   * does.
   *
   * Returns `undefined` once the loop is closed. Throws `TypeError` when
   * `promptIds` is not an array of strings.
   */
  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined;
  /**
   * Upgrades already-queued messages to immediate delivery: moves the named
   * messages from the normal inbox to the notify inbox (emitting
   * `prompt.steered` for the moved ones), releases the intake hold, and
   * interrupts the active turn's in-flight request as {@link Loop.sendNow}
   * does. Validation is all-or-nothing: the call is a no-op when any id is
   * duplicated or absent from both inboxes.
   */
  sendNowQueued(promptIds: readonly string[]): void;
  /**
   * Removes the queued message(s) carrying `promptId` from both the normal
   * and the notify inbox and emits `prompt.canceled` (`canceled` reports
   * whether anything matched). Does not affect a turn that has already
   * consumed the message, does not release the intake hold, and does not
   * interrupt the active turn.
   *
   * Returns `undefined` once the loop is closed. Throws `TypeError` when
   * `promptId` is not a string.
   */
  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined;
  abort(reason?: unknown, options?: { readonly continue?: boolean }): void;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string, text?: string, completion?: ToolCompletionFactory): void;
  operation<T>(create: (runtime: LoopRequestRuntime) => T): T;
  subscribe(listener: (event: LoopEmitted) => void): () => void;
  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>>;
  /**
   * Runs one turn for `message` and resolves with its outcome. Unlike
   * {@link Loop.submit}, the message bypasses the inbox and becomes the
   * turn's initial input directly (queued reminders are drained into the
   * same batch); `prompt.submitted` is still emitted. Requires the loop to
   * be idle; rejects with an `Error` otherwise (and with a `TypeError` for a
   * non-user message) instead of throwing synchronously.
   *
   * Aborting `opts.signal` aborts the turn: its uncommitted input is
   * returned to the inbox and the intake hold is kept. An already-aborted
   * signal resolves immediately with an `aborted` outcome.
   */
  runTurn(message: UserMessage, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome>;
  waitForIdle(): Promise<void>;
}

export function createLoop(options: CreateLoopOptions): Loop {
  return createActorLoop(options);
}
