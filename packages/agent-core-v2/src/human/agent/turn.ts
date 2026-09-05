import { assign, setup } from '#/xstate2';

import type { FinishInfo } from '#/llm/finish-reason';
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
import type { createLlmMachine, LlmEvent } from '#/llm/requester/machine';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import { emptyUsage, type TokenUsage } from '#/llm/usage';
import type { ToolResult } from '#/tool/executor';
import type { ToolOutput } from '#/tool/machine';

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
  push(part: StreamedMessagePart): void;
  pushUsage(usage: Partial<TokenUsage>): void;
  pushHeaders(headers: Record<string, string>): void;
  pushFinish(finish: FinishInfo): void;
  pushMessageId(messageId: string): void;
  finish(meta?: AssistantMetaInput): AssistantEntry;
}

export function createHistoryAccumulator(meta?: AssistantMetaInput): HistoryAccumulator {
  const inner = createMessageAccumulator();
  let usage: TokenUsage | undefined;
  let headers: Record<string, string> | undefined;
  let finish: FinishInfo | undefined;
  let messageId: string | undefined;
  return {
    push: (part) => inner.push(part),
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
}

export type TurnToolEvent =
  | { type: 'tool.async'; toolCallId: string; text: string }
  | { type: 'tool.done'; toolCallId: string; result: ToolResult }
  | { type: 'tool.failed'; toolCallId: string; error: unknown }
  | { type: 'tool.aborted'; toolCallId: string };

export type TurnEvent =
  | LlmEvent
  | TurnToolEvent
  | { type: 'turn.notifications'; messages: HistoryMessage[] }
  | { type: 'turn.abort' };

export type TurnLlmEvent =
  | Exclude<LlmEvent, { type: 'llm.done' }>
  | { type: 'llm.done'; entry: AssistantEntry };

export type TurnSignal =
  | { type: 'turn.spawnTools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' }
  | { type: 'turn.remindersConsumed'; reminders: HistoryMessage[] };

export type TurnOutput =
  | { type: 'done'; produced: HistoryMessage[] }
  | { type: 'failed'; error: unknown; produced: HistoryMessage[] }
  | { type: 'aborted'; produced: HistoryMessage[] };

export interface TurnMachineContext {
  input: TurnInput;
  produced: HistoryMessage[];
  accumulator: HistoryAccumulator;
  pendingToolCalls: ToolCall[];
  outcomes: Record<string, ToolOutput>;
  steps: number;
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

export function createTurnMachine(llmActor: ReturnType<typeof createLlmMachine>) {
  return setup({
    types: {
      input: {} as TurnInput,
      context: {} as TurnMachineContext,
      events: {} as TurnEvent,
      output: {} as TurnOutput,
    },
    actors: {
      llmActor,
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      signalParent: ({ self }, params: TurnSignal) => {
        self._parent?.send(params);
      },
      signalRemindersConsumed: ({ self, event }) => {
        if (event.type !== 'turn.notifications') return;
        const reminders = event.messages.filter((entry) => entry.meta.source === 'reminder');
        if (reminders.length === 0) return;
        self._parent?.send({ type: 'turn.remindersConsumed', reminders });
      },
      sendToParent: ({ self }, params: TurnLlmEvent) => {
        self._parent?.send(params);
      },
    },
  }).createMachine({
    id: 'turn',
    initial: 'thinking',
    context: ({ input }) => ({
      input,
      produced: [],
      accumulator: createHistoryAccumulator(modelMeta(input.request.model)),
      pendingToolCalls: [],
      outcomes: {},
      steps: 0,
    }),
    states: {
      thinking: {
        entry: assign({
          steps: ({ context }) => context.steps + 1,
          accumulator: ({ context }) => createHistoryAccumulator(modelMeta(context.input.request.model)),
        }),
        invoke: {
          src: 'llmActor',
          input: ({ context }) => {
            const entries = [...context.input.history, ...context.produced];
            return {
              config: context.input.request,
              content: {
                messages: toInputMessages(entries),
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
            actions: ['forwardToParent'],
          },
          'llm.headers': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushHeaders(event.headers);
              },
            ],
          },
          'llm.delta': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.push(event.part);
              },
            ],
          },
          'llm.retrying': {
            actions: [
              'forwardToParent',
              assign({
                accumulator: ({ context }) =>
                  createHistoryAccumulator(modelMeta(context.input.request.model)),
              }),
            ],
          },
          'llm.recovering': {
            actions: [
              'forwardToParent',
              assign({
                accumulator: ({ context }) =>
                  createHistoryAccumulator(modelMeta(context.input.request.model)),
              }),
            ],
          },
          'llm.usage': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushUsage(event.usage);
              },
            ],
          },
          'llm.finish': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushFinish(event.finish);
              },
            ],
          },
          'llm.message-id': {
            actions: [
              'forwardToParent',
              ({ context, event }) => {
                context.accumulator.pushMessageId(event.messageId);
              },
            ],
          },
          'llm.done': [
            {
              guard: ({ context }) => context.accumulator.finish().message.toolCalls.length > 0,
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
            target: 'failed',
            actions: [
              'forwardToParent',
              assign({
                outcome: 'failed' as const,
                error: ({ event }) => event.error,
              }),
            ],
          },
          'turn.abort': {
            target: 'aborted',
            actions: assign(({ context }) => {
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
          },
        },
      },
      acting: {
        entry: {
          type: 'signalParent',
          params: ({ context }) => ({
            type: 'turn.spawnTools' as const,
            toolCalls: context.pendingToolCalls,
          }),
        },
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
          'tool.async': {
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
          'turn.abort': [
            {
              guard: ({ context }) => context.outcome === 'aborted',
              target: 'aborted',
              actions: assign(({ context }) =>
                collectToolOutcomes({ ...context, outcomes: abortOutcomes(context) }),
              ),
            },
            {
              actions: assign({ outcome: 'aborted' as const }),
            },
          ],
        },
      },
      draining: {
        entry: {
          type: 'signalParent',
          params: { type: 'turn.drain' },
        },
        on: {
          'turn.notifications': [
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
                  steps: event.messages.length > 0 ? 0 : context.steps,
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
