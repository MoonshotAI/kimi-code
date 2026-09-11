import { assign, raise, setup } from '#/xstate2';

import { emptyResponseError } from '#/llm/empty-response';
import type { LlmErrorMessage } from '#/llm/errors';
import { NO_FINISH, type FinishInfo } from '#/llm/finish-reason';
import {
  createMessageAccumulator,
  createToolMessage,
  salvageInterruptedMessage,
  type AssistantMessage,
  type Message,
  type StreamedMessagePart,
  type SystemMessage,
  type ToolCall,
  type ToolMessage,
  type UserMessage,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { createRequestActor, type LlmEvent, type MessageResolver } from '#/llm/requester/actor';
import type {
  LlmRecovery,
  LlmRecoveryContext,
  LlmRecoveryProposal,
  LlmRecoveryRecord,
} from '#/llm/requester/recovery';
import type { LlmRequestConfig, LlmRequester } from '#/llm/requester/requester';
import {
  readRetryAfterMs,
  resolveMaxAttempts,
  retryBackoffDelay,
  retryErrorFields,
  shouldRetry,
  type LlmRetryOptions,
} from '#/llm/requester/retry';
import { ToolCallIdNormalizer } from '#/llm/toolCallIdNormalizer';
import { emptyUsage, type TokenUsage } from '#/llm/usage';
import type { ToolResult } from '#/tool/executor';
import type { ToolOutput } from '#/tool/machine';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';

import { MaxStepsExceededError } from './errors';
import { estimateUsedContextTokens } from './context-usage';

export interface EntryMeta {
  source?: string;
  key?: string;
}

export type SystemMeta = EntryMeta;

export type UserMeta = EntryMeta;

export type ToolMeta = EntryMeta;

export interface AssistantMeta extends EntryMeta {
  model?: { provider: string; model: string };
  usage: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

export type AssistantMetaInput = Omit<AssistantMeta, 'usage'> & { usage?: TokenUsage };

export interface HistoryEntry<T extends Message, F extends EntryMeta> {
  message: T;
  meta: F;
}

export type SystemEntry = HistoryEntry<SystemMessage, SystemMeta>;

export type UserEntry = HistoryEntry<UserMessage, UserMeta>;

export type ToolEntry = HistoryEntry<ToolMessage, ToolMeta>;

export type AssistantEntry = HistoryEntry<AssistantMessage, AssistantMeta>;

export type HistoryMessage = SystemEntry | UserEntry | AssistantEntry | ToolEntry;

export function createUserEntry(message: UserMessage, meta: UserMeta = {}): UserEntry {
  return { message, meta };
}

export function createSystemEntry(message: SystemMessage, meta: SystemMeta = {}): SystemEntry {
  return { message, meta };
}

export function createToolEntry(message: ToolMessage, meta: ToolMeta = {}): ToolEntry {
  return { message, meta };
}

export function createAssistantEntry(
  message: AssistantMessage,
  meta: AssistantMeta,
): AssistantEntry {
  return { message, meta };
}

export function toInputMessages(history: readonly HistoryMessage[]): Message[] {
  return history.map((entry) => entry.message);
}

export interface HistoryAccumulator {
  push(part: StreamedMessagePart): StreamedMessagePart;
  rollback(): void;
  pushUsage(usage: Partial<TokenUsage>): void;
  pushHeaders(headers: Record<string, string>): void;
  pushFinish(finish: FinishInfo): void;
  pushMessageId(messageId: string): void;
  finish(meta?: AssistantMetaInput): AssistantEntry;
}

export function createHistoryAccumulator(
  meta?: AssistantMetaInput,
  toolCallIds?: ToolCallIdNormalizer,
): HistoryAccumulator {
  const inner = createMessageAccumulator();
  const response = toolCallIds?.beginResponse();
  let usage: TokenUsage | undefined;
  let headers: Record<string, string> | undefined;
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  return {
    push: (part) => {
      if (response !== undefined && part.type === 'function') {
        const id = response.remapStreamedId(part.id, part._streamIndex);
        if (id !== part.id) {
          const remapped = { ...part, id, rawId: part.rawId ?? part.id };
          inner.push(remapped);
          return remapped;
        }
      }
      inner.push(part);
      return part;
    },
    rollback: () => {
      response?.rollback();
    },
    pushUsage: (value) => {
      usage = {
        inputOther: value.inputOther ?? usage?.inputOther ?? 0,
        output: value.output ?? usage?.output ?? 0,
        inputCacheRead: value.inputCacheRead ?? usage?.inputCacheRead ?? 0,
        inputCacheCreation: value.inputCacheCreation ?? usage?.inputCacheCreation ?? 0,
        raw: value.raw !== undefined ? { ...usage?.raw, ...value.raw } : usage?.raw,
      };
    },
    pushHeaders: (value) => {
      headers = value;
    },
    pushFinish: (value) => {
      finish = value;
    },
    pushMessageId: (value) => {
      messageId = value;
    },
    finish: (extra = {}) =>
      createAssistantEntry(inner.finish(), {
        ...meta,
        ...extra,
        usage: usage ?? extra.usage ?? meta?.usage ?? emptyUsage(),
        headers,
        finish,
        messageId,
      }),
  };
}

function modelMeta(model: LlmModel): AssistantMetaInput {
  return { model: { provider: model.provider, model: model.model } };
}

export interface TurnInput {
  request: LlmRequestConfig;
  history: readonly HistoryMessage[];
  maxSteps?: number;
  parentSignal?: AbortSignal;
}

export type TurnToolEvent =
  | { type: 'tool.detached'; toolCallId: string; text: string }
  | { type: 'tool.done'; toolCallId: string; result: ToolResult }
  | { type: 'tool.failed'; toolCallId: string; error: unknown }
  | { type: 'tool.aborted'; toolCallId: string };

export type TurnEvent =
  | LlmEvent
  | TurnToolEvent
  | { type: 'turn.notify'; messages: HistoryMessage[] }
  | { type: 'turn.abort' }
  | {
      type: 'turn.failure.triaged';
      cause: Extract<LlmEvent, { type: 'llm.failed.remote' }>;
      proposal?: LlmRecoveryProposal & LlmRecoveryRecord;
    };

export type TurnLlmEvent =
  | Exclude<LlmEvent, { type: 'llm.done' }>
  | { type: 'llm.done'; entry: AssistantEntry };

export type TurnSignal =
  | { type: 'step.started'; step: number }
  | { type: 'turn.spawn_tools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' }
  | { type: 'turn.reminders_consumed'; reminders: HistoryMessage[] };

export type TurnOutput =
  | { type: 'done'; produced: HistoryMessage[] }
  | { type: 'failed'; error: unknown; produced: HistoryMessage[] }
  | { type: 'aborted'; produced: HistoryMessage[] };

export interface TurnMachineContext {
  input: TurnInput;
  produced: HistoryMessage[];
  accumulator: HistoryAccumulator;
  toolCallIds: ToolCallIdNormalizer;
  llmScope: AbortScope;
  pendingToolCalls: ToolCall[];
  outcomes: Record<string, ToolOutput>;
  steps: number;
  step: number;
  attempt: number;
  delayMs: number;
  appliedRecoveries: LlmRecoveryRecord[];
  recoveryMessages?: readonly Message[];
  outcome?: 'done' | 'failed' | 'aborted';
  error?: unknown;
}

function toolOutcomeEntry(toolCall: ToolCall, output: ToolOutput): ToolEntry {
  if (output.type === 'failed') {
    const text = output.error instanceof Error ? output.error.message : String(output.error);
    return createToolEntry(createToolMessage(toolCall.id, text), { source: 'tool' });
  }
  if (output.type === 'aborted') {
    return createToolEntry(createToolMessage(toolCall.id, 'aborted'), { source: 'tool' });
  }
  return createToolEntry(createToolMessage(toolCall.id, output.result.content), {
    source: 'tool',
  });
}

function asyncAckOutcome(toolCall: ToolCall, text: string): ToolOutput {
  return {
    type: 'succeeded',
    result: {
      content: [
        { type: 'text', text: text === '' ? `async running: ${toolCall.name}` : text },
      ],
    },
  };
}

function collectToolOutcomes(
  context: TurnMachineContext,
): Pick<TurnMachineContext, 'produced' | 'pendingToolCalls' | 'outcomes'> {
  return {
    produced: [
      ...context.produced,
      ...context.pendingToolCalls.map((toolCall) =>
        toolOutcomeEntry(toolCall, context.outcomes[toolCall.id] as ToolOutput),
      ),
    ],
    pendingToolCalls: [],
    outcomes: {},
  };
}

function abortOutcomes(context: TurnMachineContext): Record<string, ToolOutput> {
  const outcomes = { ...context.outcomes };
  for (const toolCall of context.pendingToolCalls) {
    if (outcomes[toolCall.id] === undefined) {
      outcomes[toolCall.id] = { type: 'aborted' };
    }
  }
  return outcomes;
}

function maxStepsExceeded(context: TurnMachineContext): boolean {
  const maxSteps = context.input.maxSteps;
  return maxSteps !== undefined && maxSteps > 0 && context.steps >= maxSteps;
}

function baseMessages(context: TurnMachineContext): readonly Message[] {
  return toInputMessages([...context.input.history, ...context.produced]);
}

function attemptMessages(context: TurnMachineContext): readonly Message[] {
  return context.recoveryMessages ?? baseMessages(context);
}

function proposeRecovery(
  recovery: LlmRecovery | undefined,
  ctx: LlmRecoveryContext,
): (LlmRecoveryProposal & LlmRecoveryRecord) | undefined {
  if (recovery === undefined) return undefined;
  const proposal = recovery.propose(ctx);
  if (proposal === undefined) return undefined;
  if (proposal.messages !== undefined && proposal.messages === ctx.messages) return undefined;
  return proposal;
}

function llmRetryingEvent(
  retry: LlmRetryOptions | undefined,
  attempt: number,
  delayMs: number,
  error: LlmErrorMessage,
): Extract<LlmEvent, { type: 'llm.retrying' }> {
  return {
    type: 'llm.retrying',
    failedAttempt: attempt,
    nextAttempt: attempt + 1,
    maxAttempts: resolveMaxAttempts(retry),
    delayMs,
    ...retryErrorFields(error),
  };
}

function llmRecoveringEvent(
  record: LlmRecoveryRecord,
  error: LlmErrorMessage,
): Extract<LlmEvent, { type: 'llm.recovering' }> {
  return {
    type: 'llm.recovering',
    strategy: record.strategy,
    action: record.action,
    ...retryErrorFields(error),
  };
}

function emptyErrorOf(context: TurnMachineContext): LlmErrorMessage<'empty_response'> | null {
  const entry = context.accumulator.finish();
  return emptyResponseError(
    entry.message,
    context.input.request.model,
    entry.meta.finish ?? NO_FINISH,
  );
}

export interface CreateTurnMachineOptions {
  readonly recovery?: LlmRecovery;
  readonly retry?: LlmRetryOptions;
  readonly abortGraceMs?: number;
  readonly messageResolvers?: readonly MessageResolver[];
}

export function createTurnMachine(
  requester: LlmRequester,
  options?: CreateTurnMachineOptions,
) {
  const recovery = options?.recovery;
  const retry = options?.retry;
  const abortGraceMs = options?.abortGraceMs ?? 2_500;
  return setup({
    types: {
      input: {} as TurnInput,
      context: {} as TurnMachineContext,
      events: {} as TurnEvent,
      output: {} as TurnOutput,
    },
    actors: {
      llmActor: createRequestActor(requester, options?.messageResolvers),
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      signalParent: ({ self }, params: TurnSignal) => {
        self._parent?.send(params);
      },
      signalRemindersConsumed: ({ self, event }) => {
        if (event.type !== 'turn.notify') return;
        const reminders = event.messages.filter((entry) => entry.meta.source === 'reminder');
        if (reminders.length === 0) return;
        self._parent?.send({ type: 'turn.reminders_consumed', reminders });
      },
      sendToParent: ({ self }, params: TurnLlmEvent) => {
        self._parent?.send(params);
      },
      salvageAborted: assign(({ context }) => {
        const partial = context.accumulator.finish({ source: 'salvaged' });
        const salvaged = salvageInterruptedMessage(partial.message);
        return {
          outcome: 'aborted' as const,
          produced:
            salvaged === null
              ? context.produced
              : [...context.produced, { message: salvaged, meta: partial.meta }],
        };
      }),
      collectAborted: assign(({ context }) =>
        collectToolOutcomes({ ...context, outcomes: abortOutcomes(context) }),
      ),
    },
    delays: {
      retryDelay: ({ context }) => context.delayMs,
      abortGrace: abortGraceMs,
    },
  }).createMachine({
    id: 'turn',
    initial: 'thinking',
    context: ({ input }) => {
      const toolCallIds = new ToolCallIdNormalizer();
      toolCallIds.seedFrom(toInputMessages(input.history));
      return {
        input,
        produced: [],
        accumulator: createHistoryAccumulator(modelMeta(input.request.model), toolCallIds),
        toolCallIds,
        llmScope: createAbortScope(),
        pendingToolCalls: [],
        outcomes: {},
        steps: 1,
        step: 0,
        attempt: 1,
        delayMs: 0,
        appliedRecoveries: [],
      };
    },
    states: {
      thinking: {
        entry: [
          assign({
            accumulator: ({ context }) =>
              createHistoryAccumulator(modelMeta(context.input.request.model), context.toolCallIds),
            llmScope: ({ context }) =>
              context.input.parentSignal !== undefined
                ? withAbort(context.input.parentSignal)
                : createAbortScope(),
            step: ({ context }) => context.step + 1,
          }),
          {
            type: 'signalParent',
            params: ({ context }) => ({ type: 'step.started' as const, step: context.step }),
          },
        ],
        invoke: {
          src: 'llmActor',
          input: ({ context }) => {
            const entries = [...context.input.history, ...context.produced];
            return {
              config: context.input.request,
              signal: context.llmScope.signal,
              content: {
                messages: attemptMessages(context),
                usedContextTokens: estimateUsedContextTokens(entries, {
                  systemPrompt: context.input.request.systemPrompt,
                  tools: context.input.request.tools,
                }),
              },
            };
          },
          onError: {
            target: 'failed',
            actions: assign({
              outcome: 'failed' as const,
              error: ({ event }) => event.error,
            }),
          },
        },
        on: {
          'llm.sent': {
            actions: [
              {
                type: 'sendToParent',
                params: ({ context }) => ({
                  type: 'llm.sent' as const,
                  recovery: context.appliedRecoveries.at(-1),
                }),
              },
              ({ context }) => {
                context.accumulator.rollback();
                context.accumulator = createHistoryAccumulator(
                  modelMeta(context.input.request.model),
                  context.toolCallIds,
                );
              },
            ],
          },
          'llm.streaming.headers': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushHeaders(event.headers);
              },
            ],
          },
          'llm.streaming.part': {
            actions: [
              ({ context, event, self }) => {
                const part = context.accumulator.push(event.part);
                self._parent?.send({ ...event, part });
              },
            ],
          },
          'llm.streaming.usage': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushUsage(event.usage);
              },
            ],
          },
          'llm.streaming.finish': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushFinish(event.finish);
              },
            ],
          },
          'llm.streaming.message_id': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushMessageId(event.messageId);
              },
            ],
          },
          'llm.done': [
            {
              guard: ({ context }) =>
                context.accumulator.finish().message.toolCalls.length > 0,
              target: 'acting',
              actions: [
                {
                  type: 'sendToParent',
                  params: ({ context }) => ({
                    type: 'llm.done' as const,
                    entry: context.accumulator.finish({ source: 'llm' }),
                  }),
                },
                assign(({ context }) => {
                  const entry = context.accumulator.finish({ source: 'llm' });
                  return {
                    produced: [...context.produced, entry],
                    pendingToolCalls: [...entry.message.toolCalls],
                  };
                }),
              ],
            },
            {
              guard: ({ context }) => emptyErrorOf(context) !== null,
              actions: [
                raise(({ context }) => ({
                  type: 'llm.failed.remote' as const,
                  error: emptyErrorOf(context) as LlmErrorMessage<'empty_response'>,
                })),
              ],
            },
            {
              target: 'done',
              actions: [
                {
                  type: 'sendToParent',
                  params: ({ context }) => ({
                    type: 'llm.done' as const,
                    entry: context.accumulator.finish({ source: 'llm' }),
                  }),
                },
                assign({
                  produced: ({ context }) => [
                    ...context.produced,
                    context.accumulator.finish({ source: 'llm' }),
                  ],
                }),
              ],
            },
          ],
          'llm.failed.syntax': {
            target: 'failed',
            actions: [
              'forwardToParent',
              assign({
                outcome: 'failed' as const,
                error: ({ event }) => event.error,
              }),
            ],
          },
          'llm.failed.remote': {
            actions: raise(({ context, event }) => ({
              type: 'turn.failure.triaged' as const,
              cause: event,
              proposal: proposeRecovery(recovery, {
                error: event.error,
                messages: baseMessages(context),
                applied: context.appliedRecoveries,
                credentials: context.input.request.credentials,
              }),
            })),
          },
          'turn.failure.triaged': [
            {
              guard: ({ event }) => event.proposal !== undefined,
              target: 'thinking',
              reenter: true,
              actions: [
                ({ context, event }) => {
                  context.accumulator.rollback();
                  event.proposal?.prepare?.();
                },
                assign(({ context, event }) => {
                  const proposal = event.proposal as LlmRecoveryProposal & LlmRecoveryRecord;
                  return {
                    appliedRecoveries: [
                      ...context.appliedRecoveries,
                      { strategy: proposal.strategy, action: proposal.action },
                    ],
                    recoveryMessages: proposal.messages ?? context.recoveryMessages,
                    attempt: 1,
                  };
                }),
                {
                  type: 'sendToParent',
                  params: ({ context, event }) =>
                    llmRecoveringEvent(
                      context.appliedRecoveries.at(-1) as LlmRecoveryRecord,
                      event.cause.error,
                    ),
                },
              ],
            },
            {
              guard: ({ context, event }) =>
                shouldRetry(retry, context.attempt, event.cause.error),
              target: 'retrying',
              actions: [
                ({ context }) => {
                  context.accumulator.rollback();
                },
                assign({
                  delayMs: ({ context, event }) =>
                    readRetryAfterMs(event.cause.error) ??
                    retryBackoffDelay(context.attempt - 1),
                }),
                {
                  type: 'sendToParent',
                  params: ({ context, event }) =>
                    llmRetryingEvent(retry, context.attempt, context.delayMs, event.cause.error),
                },
              ],
            },
            {
              target: 'failed',
              actions: [
                { type: 'sendToParent', params: ({ event }) => event.cause },
                assign({
                  outcome: 'failed' as const,
                  error: ({ event }) => event.cause.rawError ?? event.cause.error,
                }),
              ],
            },
          ],
          'turn.abort': {
            target: 'aborted',
            actions: [
              ({ context }) => {
                context.llmScope.abort();
              },
              'salvageAborted',
            ],
          },
        },
      },
      retrying: {
        entry: assign({ attempt: ({ context }) => context.attempt + 1 }),
        after: {
          retryDelay: 'thinking',
        },
        on: {
          'turn.abort': {
            target: 'aborted',
            actions: assign({ outcome: 'aborted' as const }),
          },
        },
      },
      acting: {
        entry: {
          type: 'signalParent',
          params: ({ context }) => ({
            type: 'turn.spawn_tools' as const,
            toolCalls: context.pendingToolCalls,
          }),
        },
        initial: 'running',
        always: [
          {
            guard: ({ context }) =>
              context.outcome === 'aborted' &&
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'aborted',
            actions: assign(({ context }) => collectToolOutcomes(context)),
          },
          {
            guard: ({ context }) =>
              context.pendingToolCalls.every(
                (toolCall) => context.outcomes[toolCall.id] !== undefined,
              ),
            target: 'draining',
            actions: assign(({ context }) => collectToolOutcomes(context)),
          },
        ],
        on: {
          'tool.detached': {
            guard: ({ context, event }) => context.outcomes[event.toolCallId] === undefined,
            actions: assign(({ context, event }) => {
              const toolCall = context.pendingToolCalls.find(
                (call) => call.id === event.toolCallId,
              );
              if (toolCall === undefined) {
                return {};
              }
              return {
                outcomes: {
                  ...context.outcomes,
                  [event.toolCallId]: asyncAckOutcome(toolCall, event.text),
                },
              };
            }),
          },
          'tool.done': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'succeeded', result: event.result },
              }),
            }),
          },
          'tool.failed': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'failed', error: event.error },
              }),
            }),
          },
          'tool.aborted': {
            actions: assign({
              outcomes: ({ context, event }) => ({
                ...context.outcomes,
                [event.toolCallId]: { type: 'aborted' },
              }),
            }),
          },
        },
        states: {
          running: {
            on: {
              'turn.abort': {
                target: 'aborting',
                actions: assign({ outcome: 'aborted' as const }),
              },
            },
          },
          aborting: {
            after: {
              abortGrace: {
                target: '#turn.aborted',
                actions: 'collectAborted',
              },
            },
            on: {
              'turn.abort': {
                target: '#turn.aborted',
                actions: 'collectAborted',
              },
            },
          },
        },
      },
      draining: {
        entry: {
          type: 'signalParent',
          params: { type: 'turn.drain' },
        },
        on: {
          'turn.notify': [
            {
              guard: ({ context, event }) =>
                event.messages.length === 0 && maxStepsExceeded(context),
              target: 'failed',
              actions: assign(({ context }) => ({
                outcome: 'failed' as const,
                error: new MaxStepsExceededError(context.input.maxSteps as number),
              })),
            },
            {
              target: 'thinking',
              actions: [
                assign(({ context, event }) => ({
                  produced: [...context.produced, ...event.messages],
                  steps: event.messages.length > 0 ? 1 : context.steps + 1,
                  attempt: 1,
                  appliedRecoveries: [],
                  recoveryMessages: undefined,
                })),
                'signalRemindersConsumed',
              ],
            },
          ],
          'turn.abort': {
            target: 'aborted',
            actions: assign({ outcome: 'aborted' as const }),
          },
        },
      },
      done: { type: 'final' },
      failed: { type: 'final' },
      aborted: { type: 'final' },
    },
    output: ({ context }): TurnOutput =>
      context.outcome === 'failed'
        ? {
          type: 'failed',
          error: context.error,
          produced: context.produced,
        }
        : context.outcome === 'aborted'
          ? { type: 'aborted', produced: context.produced }
          : { type: 'done', produced: context.produced },
  });
}
