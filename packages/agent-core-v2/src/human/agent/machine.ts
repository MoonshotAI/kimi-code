import { assign, emit, enqueueActions, sendTo, setup } from '#/xstate2';

import {
  createUserMessage,
  type SystemMessage,
  type ToolCall,
  type UserMessage,
} from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { ToolExecutor, ToolResult } from '#/tool/executor';
import { createToolMachine, type ToolEvent, type ToolOutput } from '#/tool/machine';
import type { ToolDefinition } from '#/tool/tool';

import { createWaitForTasks, type ToolActorRef } from './wait-for';
import { interruptReasonOf, type TurnInterruptReason } from './errors';
import { createSystemEntry, createUserEntry } from './turn';
import type {
  createTurnMachine,
  HistoryMessage,
  TurnLlmEvent,
  TurnOutput,
  UserEntry,
} from './turn';

export interface AgentInput {
  request: LlmRequestConfig;
  history?: readonly HistoryMessage[];
  turnId?: number;
  branchId?: string;
}

export type AgentEvent =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'input.submit'; id?: string; message: UserMessage }
  | { type: 'input.notify'; message: UserMessage }
  | { type: 'input.reminder'; key: string; message: UserMessage | SystemMessage }
  | { type: 'input.steer'; id: string }
  | { type: 'input.abort' }
  | { type: 'turn.spawnTools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' }
  | { type: 'turn.remindersConsumed'; reminders: HistoryMessage[] }
  | { type: 'context.reset'; history: readonly HistoryMessage[]; turnId: number; branchId?: string };

export type AgentEmitted =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'turn.start'; turnId: number; branchId: string }
  | { type: 'turn.aborting' }
  | { type: 'turn.remindersConsumed'; reminders: HistoryMessage[] }
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
  ref: ToolActorRef;
}

export interface QueuedPrompt {
  id?: string;
  message: UserMessage;
}

export interface AgentMachineContext {
  input: AgentInput;
  messages: HistoryMessage[];
  turnTools: Record<string, ToolEntry>;
  background: Record<string, ToolEntry>;
  notifications: UserEntry[];
  reminders: HistoryMessage[];
  queue: QueuedPrompt[];
  turnId: number;
  branchId: string;
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
): Pick<AgentMachineContext, 'messages' | 'notifications' | 'queue'> {
  const [head, ...rest] = context.queue;
  return {
    messages: [
      ...context.messages,
      ...context.notifications,
      ...(head === undefined ? [] : [createUserEntry(head.message, { source: 'input' })]),
    ],
    notifications: [],
    queue: rest,
  };
}

function steerPatch(
  context: AgentMachineContext,
  id: string,
): Partial<Pick<AgentMachineContext, 'queue' | 'notifications'>> {
  const index = context.queue.findIndex((entry) => entry.id === id);
  if (index === -1) {
    return {};
  }
  const entry = context.queue[index] as QueuedPrompt;
  return {
    queue: context.queue.filter((_, i) => i !== index),
    notifications: [...context.notifications, createUserEntry(entry.message, { source: 'input' })],
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
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      spawnTurnTools: assign(({ context, spawn, self, event }) => {
        if (event.type !== 'turn.spawnTools') {
          return {};
        }
        const waitForTasks = createWaitForTasks(self);
        const turnTools = { ...context.turnTools };
        for (const toolCall of event.toolCalls) {
          turnTools[toolCall.id] = {
            toolCall,
            ref: spawn('toolActor', {
              id: toolCall.id,
              input: { toolCall, waitForTasks },
            }),
          };
        }
        return { turnTools };
      }),
      abortSpawnedTools: enqueueActions(({ context, event, enqueue }) => {
        if (event.type !== 'turn.spawnTools') {
          return;
        }
        for (const toolCall of event.toolCalls) {
          const entry = context.turnTools[toolCall.id];
          if (entry !== undefined) {
            enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
          }
        }
      }),
      abortTurn: sendTo('turn', { type: 'turn.abort' as const }),
      abortTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const entry of Object.values(context.turnTools)) {
          enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
        }
      }),
      stopTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const toolCallId of Object.keys(context.turnTools)) {
          enqueue.stopChild(toolCallId);
        }
      }),
    },
    delays: {
      abortTimeout: abortTimeoutMs ?? 10_000,
    },
  }).createMachine({
    id: 'agent',
    initial: 'idle',
    context: ({ input }) => ({
      input,
      messages: [...(input.history ?? [])],
      turnTools: {},
      background: {},
      notifications: [],
      reminders: [],
      queue: [],
      turnId: input.turnId ?? 0,
      branchId: input.branchId ?? 'main',
    }),
    on: {
      'input.submit': {
        actions: assign({
          queue: ({ context, event }) => [
            ...context.queue,
            { id: event.id, message: event.message },
          ],
        }),
      },
      'input.notify': {
        actions: assign({
          notifications: ({ context, event }) => [
            ...context.notifications,
            createUserEntry(event.message, { source: 'notify' }),
          ],
        }),
      },
      'input.reminder': {
        actions: assign({
          reminders: ({ context, event }) => [
            ...context.reminders.filter((entry) => entry.meta.key !== event.key),
            event.message.role === 'system'
              ? createSystemEntry(event.message, { source: 'reminder', key: event.key })
              : createUserEntry(event.message, { source: 'reminder', key: event.key }),
          ],
        }),
      },
      'input.steer': {
        actions: assign(({ context, event }) => steerPatch(context, event.id)),
      },
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
      idle: {
        initial: 'ready',
        always: {
          guard: ({ context }) => hasPendingWork(context),
          target: 'running',
          actions: assign(({ context }) => drainPendingPatch(context)),
        },
        on: {
          'context.reset': {
            actions: [
              assign(({ context, event }) => ({
                messages: [...event.history],
                turnId: event.turnId,
                branchId: event.branchId ?? context.branchId,
              })),
              emit(({ context }) => ({ type: 'context.reset' as const, branchId: context.branchId })),
              'forwardToParent',
            ],
          },
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
          }),
          onDone: {
            target: '#agent.idle',
            actions: [
              assign(({ context, event }) => turnOutputPatch(context, event.output)),
              emit(({ context, event }) => turnOutcomeEvent(context, event.output)),
            ],
          },
          onError: {
            target: '#agent.idle',
            actions: emit(({ context, event }) => ({
              type: 'turn.failed' as const,
              error: event.error,
              messages: context.messages,
              interruptReason: interruptReasonOf(event.error),
              branchId: context.branchId,
            })),
          },
        },
        entry: [
          assign({ turnId: ({ context }) => context.turnId + 1 }),
          emit(({ context }) => ({ type: 'turn.start' as const, turnId: context.turnId, branchId: context.branchId })),
        ],
        exit: assign({ turnTools: {} }),
        initial: 'active',
        on: {
          'turn.drain': {
            actions: [
              sendTo('turn', ({ context }) => ({
                type: 'turn.notifications' as const,
                messages: [...context.notifications, ...context.reminders],
              })),
              assign({ notifications: [], reminders: [] }),
            ],
          },
          'tool.async': {
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
          'llm.delta': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.headers': {
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
          'llm.usage': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.finish': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'llm.message-id': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
          'turn.remindersConsumed': {
            actions: [emit(({ event }) => event), 'forwardToParent'],
          },
        },
        states: {
          active: {
            on: {
              'turn.spawnTools': {
                actions: 'spawnTurnTools',
              },
              'input.abort': {
                target: 'aborting',
                actions: [
                  'abortTurn',
                  'abortTurnTools',
                  emit({ type: 'turn.aborting' as const }),
                ],
              },
            },
          },
          aborting: {
            after: {
              abortTimeout: { actions: ['abortTurn', 'stopTurnTools'] },
            },
            on: {
              'turn.spawnTools': {
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
