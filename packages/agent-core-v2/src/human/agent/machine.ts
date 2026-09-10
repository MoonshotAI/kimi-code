import { assign, emit, enqueueActions, fromCallback, sendTo, setup } from '#/xstate2';

import { createUserMessage, type SystemMessage, type ToolCall, type UserMessage } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { ToolExecutor, ToolResult } from '#/tool/executor';
import { createToolMachine, type ToolEvent, type ToolOutput } from '#/tool/machine';
import type { ToolDefinition } from '#/tool/tool';

import { createWaitForTasks, type ToolActorRef } from './wait-for';
import { interruptReasonOf, type TurnInterruptReason } from './errors';
import {
  inputCancelled,
  inputDrained,
  inputNotified,
  inputReminded,
  inputSteered,
  inputSubmitted,
  messageAppended,
  notificationsDrained,
  queueDrained,
  turnEnded,
  turnStarted,
} from './events';
import { createSystemEntry, createUserEntry } from './turn';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';
import type { createTurnMachine, HistoryMessage, TurnLlmEvent, TurnOutput, UserEntry } from './turn';
import { storeActor } from '#/eventStore/actor';
import type { AgentEventStore, AgentStoreState, QueuedPrompt } from './slices';

export type { QueuedPrompt } from './slices';

export interface AgentInput {
  request: LlmRequestConfig;
  store: AgentEventStore;
}

export type AgentEvent =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'input.submit'; id?: string; message: UserMessage }
  | { type: 'input.notify'; message: UserMessage }
  | { type: 'input.remind'; key: string; message: UserMessage | SystemMessage }
  | { type: 'input.steer'; id: string }
  | { type: 'input.cancel'; id: string }
  | { type: 'input.abort' }
  | { type: 'turn.spawn_tools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' }
  | { type: 'turn.reminders_consumed'; reminders: HistoryMessage[] }
  | { type: 'step.started'; step: number }
  | { type: 'store.ready'; state: AgentStoreState; branch: string }
  | { type: 'store.changed'; state: AgentStoreState }
  | { type: 'store.reset'; state: AgentStoreState; branch: string }
  | { type: 'store.error'; error: unknown };

export type AgentEmitted =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'turn.started'; turnId: number; branchId: string; queueItemId?: string }
  | { type: 'step.started'; step: number }
  | { type: 'turn.aborting' }
  | { type: 'turn.reminders_consumed'; reminders: HistoryMessage[] }
  | { type: 'turn.done'; messages: HistoryMessage[]; branchId: string }
  | {
      type: 'turn.failed';
      error: unknown;
      messages: HistoryMessage[];
      interruptReason: TurnInterruptReason;
      branchId: string;
    }
  | { type: 'turn.aborted'; messages: HistoryMessage[]; branchId: string }
  | { type: 'context.reset'; branchId: string };

interface ToolEntry {
  toolCall: ToolCall;
  scope: AbortScope;
  ref: ToolActorRef;
}

export interface AgentMachineContext {
  input: AgentInput;
  messages: HistoryMessage[];
  turnTools: Record<string, ToolEntry>;
  background: Record<string, ToolEntry>;
  scope: AbortScope;
  notifications: UserEntry[];
  reminders: HistoryMessage[];
  queue: QueuedPrompt[];
  turnId: number;
  activeTurnId?: number;
  branchId: string;
  drainedId?: string;
}

function completionNotification(toolCall: ToolCall, output: ToolOutput): UserEntry {
  if (output.type === 'failed') {
    const text = output.error instanceof Error ? output.error.message : String(output.error);
    return createUserEntry(
      createUserMessage(`[async tool failed] ${toolCall.name} (tool_call_id=${toolCall.id})\n${text}`),
      { source: 'async-tool' },
    );
  }
  if (output.type === 'aborted') {
    return createUserEntry(
      createUserMessage(`[async tool aborted] ${toolCall.name} (tool_call_id=${toolCall.id})`),
      { source: 'async-tool' },
    );
  }
  return createUserEntry(
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `[async tool completed] ${toolCall.name} (tool_call_id=${toolCall.id})`,
        },
        ...output.result.content,
      ],
    },
    { source: 'async-tool' },
  );
}

function completionPatch(
  context: AgentMachineContext,
  event: { toolCallId: string } & ({ result: ToolResult } | { error: unknown }),
): { notifications?: UserEntry[]; background?: AgentMachineContext['background'] } {
  const entry = context.background[event.toolCallId];
  if (entry === undefined) {
    return {};
  }
  const output: ToolOutput =
    'result' in event
      ? { type: 'succeeded', result: event.result }
      : { type: 'failed', error: event.error };
  const background = { ...context.background };
  delete background[event.toolCallId];
  return {
    notifications: [...context.notifications, completionNotification(entry.toolCall, output)],
    background,
  };
}

function turnOutputPatch(
  context: AgentMachineContext,
  output: TurnOutput,
): Pick<AgentMachineContext, 'messages'> {
  return {
    messages: [...context.messages, ...output.produced],
  };
}

function turnOutcomeEvent(context: AgentMachineContext, output: TurnOutput): AgentEmitted {
  if (output.type === 'failed') {
    return {
      type: 'turn.failed',
      error: output.error,
      messages: context.messages,
      interruptReason: interruptReasonOf(output.error),
      branchId: context.branchId,
    };
  }
  if (output.type === 'aborted') {
    return { type: 'turn.aborted', messages: context.messages, branchId: context.branchId };
  }
  return { type: 'turn.done', messages: context.messages, branchId: context.branchId };
}

function hasPendingWork(context: AgentMachineContext): boolean {
  return context.notifications.length > 0 || context.queue.length > 0;
}

function hasBackgroundWork(context: AgentMachineContext): boolean {
  return Object.keys(context.background).length > 0;
}

function drainPendingPatch(
  context: AgentMachineContext,
): Pick<AgentMachineContext, 'messages' | 'notifications' | 'queue' | 'drainedId'> {
  const [head, ...rest] = context.queue;
  return {
    messages: [
      ...context.messages,
      ...context.notifications,
      ...(head === undefined ? [] : [createUserEntry(head.message, { source: 'input' })]),
    ],
    notifications: [],
    queue: rest,
    drainedId: head?.id,
  };
}

function mirrorPatch(state: AgentStoreState): Pick<
  AgentMachineContext,
  'messages' | 'queue' | 'notifications' | 'reminders'
> {
  return {
    messages: [...state.history],
    queue: [...state.queue],
    notifications: [...state.notifications],
    reminders: [...state.reminders],
  };
}

export interface CreateAgentMachineOptions {
  tools?: readonly ToolDefinition[];
  turnActor: ReturnType<typeof createTurnMachine>;
  abortTimeoutMs?: number;
  maxStepsPerTurn?: number;
}

function dispatchTools(tools: readonly ToolDefinition[]): ToolExecutor {
  const byName = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new Error(`duplicate tool name: '${tool.name}'`);
    }
    byName.set(tool.name, tool);
  }
  return {
    async execute(input) {
      const tool = byName.get(input.toolCall.name);
      if (tool === undefined) {
        return {
          content: [{ type: 'text', text: `unknown tool: ${input.toolCall.name}` }],
          isError: true,
        };
      }
      return tool.execute(input);
    },
  };
}

export function createAgentMachine({
  tools,
  turnActor,
  abortTimeoutMs,
  maxStepsPerTurn,
}: CreateAgentMachineOptions) {
  const executor = dispatchTools(tools ?? []);
  return setup({
    types: {
      input: {} as AgentInput,
      context: {} as AgentMachineContext,
      events: {} as AgentEvent,
      emitted: {} as AgentEmitted,
    },
    actors: {
      turnActor,
      toolActor: createToolMachine(executor),
      storeActor,
      controllerGuard: fromCallback<AgentEvent, { scope: AbortScope }>(
        ({ input }) =>
          () =>
            input.scope.abort(),
      ),
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      resetMirror: assign(({ event }) => {
        if (event.type !== 'store.reset') return {};
        return {
          ...mirrorPatch(event.state),
          turnTools: {},
          background: {},
          scope: createAbortScope(),
          turnId: event.state.turnIndex.nextTurnId,
          activeTurnId: undefined,
          branchId: event.branch,
        };
      }),
      emitReset: emit(({ context }) => ({ type: 'context.reset' as const, branchId: context.branchId })),
      abortScope: ({ context }) => {
        context.scope.abort();
      },
      spawnTurnTools: assign(({ context, spawn, self, event }) => {
        if (event.type !== 'turn.spawn_tools') {
          return {};
        }
        const waitForTasks = createWaitForTasks(self);
        const turnTools = { ...context.turnTools };
        for (const toolCall of event.toolCalls) {
          const scope = withAbort(context.scope.signal);
          turnTools[toolCall.id] = {
            toolCall,
            scope,
            ref: spawn('toolActor', {
              id: toolCall.id,
              input: { toolCall, signal: scope.signal, waitForTasks },
            }),
          };
        }
        return { turnTools };
      }),
      abortSpawnedTools: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== 'turn.spawn_tools') {
          return;
        }
        for (const toolCall of event.toolCalls) {
          const entry = context.turnTools[toolCall.id];
          if (entry !== undefined) {
            entry.scope.abort();
            enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
          }
        }
      }),
      abortTurn: sendTo('turn', { type: 'turn.abort' as const }),
      abortTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const entry of Object.values(context.turnTools)) {
          entry.scope.abort();
          enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
        }
      }),
      stopTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const [toolCallId, entry] of Object.entries(context.turnTools)) {
          entry.scope.abort();
          enqueue.stopChild(toolCallId);
        }
      }),
    },
    delays: {
      abortTimeout: abortTimeoutMs ?? 10_000,
    },
  }).createMachine({
    id: 'agent',
    initial: 'restoring',
    context: ({ input }) => ({
      input,
      messages: [],
      turnTools: {},
      background: {},
      scope: createAbortScope(),
      notifications: [],
      reminders: [],
      queue: [],
      turnId: 0,
      branchId: 'main',
    }),
    invoke: [
      {
        src: 'controllerGuard',
        input: ({ context }) => ({ scope: context.scope }),
      },
      {
        id: 'store',
        src: 'storeActor',
        input: ({ context }) => ({ store: context.input.store }),
      },
    ],
    on: {
      'input.submit': {
        actions: [
          assign(({ context, event }) => {
            if (event.type !== 'input.submit') return {};
            return { queue: [...context.queue, { id: event.id, message: event.message }] };
          }),
          sendTo('store', ({ event }) => ({
            type: 'store.append' as const,
            event: inputSubmitted({ id: event.id, message: event.message }),
          })),
        ],
      },
      'input.notify': {
        actions: [
          assign(({ context, event }) => {
            if (event.type !== 'input.notify') return {};
            return {
              notifications: [
                ...context.notifications,
                createUserEntry(event.message, { source: 'notify' }),
              ],
            };
          }),
          sendTo('store', ({ event }) => ({
            type: 'store.append' as const,
            event: inputNotified({ message: event.message }),
          })),
        ],
      },
      'input.remind': {
        actions: [
          assign(({ context, event }) => {
            if (event.type !== 'input.remind') return {};
            const kept = context.reminders.filter((entry) => entry.meta.key !== event.key);
            kept.push(
              event.message.role === 'system'
                ? createSystemEntry(event.message, { source: 'reminder', key: event.key })
                : createUserEntry(event.message, { source: 'reminder', key: event.key }),
            );
            return { reminders: kept };
          }),
          sendTo('store', ({ event }) => ({
            type: 'store.append' as const,
            event: inputReminded({ key: event.key, message: event.message }),
          })),
        ],
      },
      'input.steer': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.steer') return;
          const entry = context.queue.find((item) => item.id === event.id);
          if (entry === undefined) return;
          enqueue.assign({
            queue: context.queue.filter((item) => item.id !== event.id),
            notifications: [
              ...context.notifications,
              createUserEntry(entry.message, { source: 'input' }),
            ],
          });
          enqueue.sendTo('store', {
            type: 'store.append' as const,
            event: inputSteered({ id: event.id, message: entry.message }),
          });
        }),
      },
      'input.cancel': {
        actions: [
          assign(({ context, event }) => {
            if (event.type !== 'input.cancel') return {};
            return { queue: context.queue.filter((item) => item.id !== event.id) };
          }),
          sendTo('store', ({ event }) => ({
            type: 'store.append' as const,
            event: inputCancelled({ id: event.id }),
          })),
        ],
      },
      'store.reset': {
        target: '.idle',
        actions: ['abortScope', 'resetMirror', 'emitReset', 'forwardToParent'],
      },
      'store.error': {
        actions: 'forwardToParent',
      },
      'store.changed': {},
      'tool.update': {
        actions: [emit(({ event }) => event), 'forwardToParent'],
      },
      'tool.done': {
        guard: ({ context, event }) => context.background[event.toolCallId] !== undefined,
        actions: [
          assign(({ context, event }) => completionPatch(context, event)),
          emit(({ event }) => event),
          'forwardToParent',
        ],
      },
      'tool.failed': {
        guard: ({ context, event }) => context.background[event.toolCallId] !== undefined,
        actions: [
          assign(({ context, event }) => completionPatch(context, event)),
          emit(({ event }) => event),
          'forwardToParent',
        ],
      },
    },
    states: {
      restoring: {
        on: {
          'store.ready': {
            target: 'idle',
            actions: assign(({ event }) => ({
              ...mirrorPatch(event.state),
              turnId: event.state.turnIndex.nextTurnId,
              branchId: event.branch,
            })),
          },
        },
      },
      idle: {
        initial: 'ready',
        always: {
          guard: ({ context }) => hasPendingWork(context),
          target: 'running',
          actions: [
            sendTo('store', ({ context }) => {
              const head = context.queue[0];
              return {
                type: 'store.append' as const,
                event: [
                  ...context.notifications.map((entry) => messageAppended({ message: entry })),
                  ...(head === undefined
                    ? []
                    : [
                        messageAppended({ message: createUserEntry(head.message, { source: 'input' }) }),
                        queueDrained({ id: head.id }),
                      ]),
                  ...(context.notifications.length === 0 ? [] : [notificationsDrained({})]),
                ],
              };
            }),
            assign(({ context }) => drainPendingPatch(context)),
          ],
        },
        states: {
          ready: {
            always: {
              guard: ({ context }) => hasBackgroundWork(context),
              target: 'waiting',
            },
          },
          waiting: {},
        },
      },
      running: {
        invoke: {
          id: 'turn',
          src: 'turnActor',
          input: ({ context }) => ({
            request: { ...context.input.request, tools: tools?.filter((tool) => tool.deferred !== true) },
            history: context.messages,
            maxSteps: maxStepsPerTurn,
            parentSignal: context.scope.signal,
          }),
          onDone: {
            target: '#agent.idle',
            actions: [
              assign(({ context, event }) => turnOutputPatch(context, event.output)),
              emit(({ context, event }) => turnOutcomeEvent(context, event.output)),
              sendTo('store', ({ context, event }) => ({
                type: 'store.append' as const,
                event: [
                  ...event.output.produced.map((message) => messageAppended({ message })),
                  turnEnded({
                    turnId: context.activeTurnId ?? context.turnId,
                    outcome: event.output.type,
                    errorMessage:
                      event.output.type === 'failed' ? String(event.output.error) : undefined,
                  }),
                ],
              })),
            ],
          },
          onError: {
            target: '#agent.idle',
            actions: [
              emit(({ context, event }) => ({
                type: 'turn.failed' as const,
                error: event.error,
                messages: context.messages,
                interruptReason: interruptReasonOf(event.error),
                branchId: context.branchId,
              })),
              sendTo('store', ({ context, event }) => ({
                type: 'store.append' as const,
                event: turnEnded({
                  turnId: context.activeTurnId ?? context.turnId,
                  outcome: 'failed',
                  errorMessage: String(event.error),
                }),
              })),
            ],
          },
        },
        entry: [
          assign({ activeTurnId: ({ context }) => context.turnId }),
          emit(({ context }) => ({
            type: 'turn.started' as const,
            turnId: context.turnId,
            branchId: context.branchId,
            queueItemId: context.drainedId,
          })),
          sendTo('store', ({ context }) => ({
            type: 'store.append' as const,
            event: turnStarted({ turnId: context.turnId, queueItemId: context.drainedId }),
          })),
        ],
        exit: [
          'abortTurnTools',
          'stopTurnTools',
          assign({ turnTools: {} }),
          assign({ turnId: ({ context }) => context.turnId + 1 }),
        ],
        initial: 'active',
        on: {
          'store.reset': {
            target: '#agent.idle',
            actions: [
              'abortScope',
              'resetMirror',
              'emitReset',
              'forwardToParent',
            ],
          },
          'turn.drain': {
            actions: enqueueActions(({ context, enqueue }) => {
              const messages = [...context.notifications, ...context.reminders];
              enqueue.sendTo('turn', { type: 'turn.notify' as const, messages });
              if (messages.length === 0) return;
              enqueue.assign({ notifications: [], reminders: [] });
              enqueue.sendTo('store', {
                type: 'store.append' as const,
                event: inputDrained({}),
              });
            }),
          },
          'tool.detached': {
            guard: ({ context, event }) => context.turnTools[event.toolCallId] !== undefined,
            actions: [
              assign(({ context, event }) => {
                const entry = context.turnTools[event.toolCallId] as ToolEntry;
                const turnTools = { ...context.turnTools };
                delete turnTools[event.toolCallId];
                return {
                  turnTools,
                  background: { ...context.background, [event.toolCallId]: entry },
                };
              }),
              sendTo('turn', ({ event }) => event),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
          'tool.done': {
            guard: ({ context, event }) =>
              context.background[event.toolCallId] === undefined &&
              context.turnTools[event.toolCallId] !== undefined,
            actions: [
              sendTo('turn', ({ event }) => event),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
          'tool.failed': {
            guard: ({ context, event }) =>
              context.background[event.toolCallId] === undefined &&
              context.turnTools[event.toolCallId] !== undefined,
            actions: [
              sendTo('turn', ({ event }) => event),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
          'tool.aborted': {
            guard: ({ context, event }) =>
              context.background[event.toolCallId] === undefined &&
              context.turnTools[event.toolCallId] !== undefined,
            actions: [
              sendTo('turn', ({ event }) => event),
              emit(({ event }) => event),
              'forwardToParent',
            ],
          },
          'llm.sent': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'step.started': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.streaming.*': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.done': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.failed.syntax': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.failed.remote': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.retrying': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.recovering': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'turn.reminders_consumed': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
        },
        states: {
          active: {
            on: {
              'turn.spawn_tools': {
                actions: 'spawnTurnTools',
              },
              'input.abort': {
                target: 'aborting',
                actions: ['abortTurn', 'abortTurnTools', emit({ type: 'turn.aborting' as const })],
              },
            },
          },
          aborting: {
            after: {
              abortTimeout: { actions: ['abortTurn', 'stopTurnTools'] },
            },
            on: {
              'turn.spawn_tools': {
                actions: ['spawnTurnTools', 'abortSpawnedTools'],
              },
              'input.abort': {
                actions: ['abortTurn', 'stopTurnTools'],
              },
            },
          },
        },
      },
    },
  });
}
