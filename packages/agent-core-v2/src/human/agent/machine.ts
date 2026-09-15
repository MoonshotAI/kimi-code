import {
  assign,
  emit,
  enqueueActions,
  fromCallback,
  fromPromise,
  sendTo,
  setup,
  stopChild,
  type ActorRefFromLogic,
  type AnyActorLogic,
  type AnyEventObject,
  type DoneActorEvent,
  type ErrorActorEvent,
  type InputFrom,
  type Subscription,
} from '#/xstate2';

import { createUserMessage, type ToolCall, type UserMessage } from '#/llm/message';
import type { LlmRequestConfig } from '#/llm/requester/requester';
import type { ToolExecutor, ToolResult } from '#/tool/executor';
import { createToolMachine, type ToolEvent, type ToolOutput } from '#/tool/machine';
import type { ToolDefinition } from '#/tool/tool';

import { createWaitForTasks, type ToolActorRef } from './wait-for';
import { interruptReasonOf, type TurnInterruptReason } from './errors';
import { messageAppended, turnEnded, turnStarted } from './events';
import { mergeSteerMessages } from './origin';
import { createSystemEntry, createUserEntry } from './turn';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';
import type { createTurnMachine, HistoryMessage, SystemEntry, TurnLlmEvent, TurnOutput, UserEntry } from './turn';
import { storeActor } from '#/eventStore/actor';
import type { AgentEventStore, AgentStoreState } from './slices';

export interface AgentInput {
  request: LlmRequestConfig;
  store?: AgentEventStore;
  session?: unknown;
  scopeFactory: ScopeFactory;
}

export interface AgentScopeHandle {
  disposeAsync(): Promise<void>;
}

export interface AgentMachineSelf {
  send(event: AgentEvent): void;
  getSnapshot(): unknown;
  on(type: string, handler: (emitted: AnyEventObject) => void): Subscription;
}

export type ScopeFactory = (
  self: AgentMachineSelf,
  signal: AbortSignal,
) => Promise<ScopeFactoryOutput>;

export type PromptGateVerdict = boolean | { block: boolean; message?: UserMessage };

export type PromptGate = (
  queueItemId: string | undefined,
  message: UserMessage,
) => Promise<PromptGateVerdict>;

export interface ScopeFactoryOutput {
  handle?: AgentScopeHandle;
  store: AgentEventStore;
  turnLogic: TurnLogic;
  toolLogic: ToolLogic;
  tools: readonly ToolDefinition[];
  request?: LlmRequestConfig;
  promptGate?: PromptGate;
}

type TurnLogic = ReturnType<typeof createTurnMachine>;
type ToolLogic = ReturnType<typeof createToolMachine>;

type SpawnChild = <TLogic extends AnyActorLogic>(
  logic: TLogic,
  options: { id: string; input: InputFrom<TLogic> },
) => ActorRefFromLogic<TLogic>;

export type AgentEvent =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'input.submit'; entry: UserEntry }
  | { type: 'input.notify'; entry: UserEntry }
  | { type: 'input.remind'; key: string; entry: SystemEntry | UserEntry }
  | { type: 'input.steer'; id: string | readonly string[] }
  | { type: 'input.cancel'; id: string }
  | { type: 'input.abort' }
  | { type: 'input.pause' }
  | { type: 'input.continue' }
  | { type: 'input.close' }
  | { type: 'turn.spawn_tools'; toolCalls: ToolCall[] }
  | { type: 'turn.drain' }
  | { type: 'turn.reminders_consumed'; reminders: HistoryMessage[] }
  | { type: 'step.started'; step: number }
  | { type: 'store.ready'; state: AgentStoreState; branch: string }
  | { type: 'store.changed'; state: AgentStoreState }
  | { type: 'store.reset'; state: AgentStoreState; branch: string }
  | { type: 'store.error'; error: unknown }
  | DoneActorEvent<TurnOutput, 'turn'>
  | ErrorActorEvent<unknown, 'turn'>;

export type AgentEmitted =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'turn.started'; turnId: number; branchId: string; queueItemId?: string; entry?: UserEntry }
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
  | { type: 'prompt.blocked'; queueItemId?: string; entry?: UserEntry }
  | { type: 'prompt.gate_failed'; queueItemId?: string; error: unknown; entry?: UserEntry }
  | { type: 'prompt.steered'; queueItemIds: string[]; entries: UserEntry[] }
  | { type: 'context.reset'; branchId: string }
  | { type: 'agent.attached' }
  | { type: 'agent.failed'; error: unknown };

interface ToolEntry {
  toolCall: ToolCall;
  scope: AbortScope;
  ref: ToolActorRef;
}

export interface AgentMachineContext {
  input: AgentInput;
  request: LlmRequestConfig;
  store?: AgentEventStore;
  handle?: AgentScopeHandle;
  turnLogic?: TurnLogic;
  toolLogic?: ToolLogic;
  tools?: readonly ToolDefinition[];
  promptGate?: PromptGate;
  messages: HistoryMessage[];
  turnTools: Record<string, ToolEntry>;
  background: Record<string, ToolEntry>;
  scope: AbortScope;
  notifications: UserEntry[];
  reminders: HistoryMessage[];
  queue: UserEntry[];
  turnId: number;
  activeTurnId?: number;
  branchId: string;
  drainedId?: string;
  drainedEntry?: UserEntry;
  paused: boolean;
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

function historyEndsMidToolChain(messages: readonly HistoryMessage[]): boolean {
  const last = messages.at(-1);
  if (last === undefined) return false;
  if (last.message.role === 'tool') return true;
  return last.message.role === 'assistant' && last.message.toolCalls.length > 0;
}

function hasBackgroundWork(context: AgentMachineContext): boolean {
  return Object.keys(context.background).length > 0;
}

function drainPendingPatch(
  context: AgentMachineContext,
): Pick<AgentMachineContext, 'messages' | 'notifications' | 'queue' | 'drainedId' | 'drainedEntry'> {
  const [head, ...rest] = context.queue;
  return {
    messages: [
      ...context.messages,
      ...context.notifications,
      ...(head === undefined ? [] : [head]),
    ],
    notifications: [],
    queue: rest,
    drainedId: head?.meta?.promptId,
    drainedEntry: head,
  };
}

function mirrorPatch(state: AgentStoreState): Pick<
  AgentMachineContext,
  'messages' | 'notifications' | 'reminders'
> {
  return {
    messages: [...state.history],
    notifications: [...state.notifications],
    reminders: [...state.reminders],
  };
}

export interface CreateAgentMachineOptions {
  abortTimeoutMs?: number;
  maxStepsPerTurn?: number;
}

export function dispatchTools(tools: readonly ToolDefinition[]): ToolExecutor {
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
  abortTimeoutMs,
  maxStepsPerTurn,
}: CreateAgentMachineOptions) {
  return setup({
    types: {
      input: {} as AgentInput,
      context: {} as AgentMachineContext,
      events: {} as AgentEvent,
      emitted: {} as AgentEmitted,
    },
    actors: {
      storeActor,
      controllerGuard: fromCallback<AgentEvent, { scope: AbortScope }>(
        ({ input }) =>
          () =>
            input.scope.abort(),
      ),
      scopeFactoryActor: fromPromise<ScopeFactoryOutput, AgentInput & { self: AgentMachineSelf }>(
        ({ input, signal }) => input.scopeFactory(input.self, signal),
      ),
      promptGateActor: fromPromise<
        { id?: string; block: boolean; message?: UserMessage; error?: unknown },
        { gate?: PromptGate; head?: UserEntry }
      >(async ({ input }) => {
        const { gate, head } = input;
        if (gate === undefined || head === undefined) return { id: head?.meta?.promptId, block: false };
        try {
          const verdict = await gate(head.meta?.promptId, head.message);
          if (typeof verdict === 'boolean') return { id: head.meta?.promptId, block: verdict };
          return { id: head.meta?.promptId, block: verdict.block, message: verdict.message };
        } catch (error) {
          return { id: head.meta?.promptId, block: false, error };
        }
      }),
      disposeScopeActor: fromPromise<void, { handle?: AgentScopeHandle }>(async ({ input }) => {
        await input.handle?.disposeAsync();
      }),
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      commitPendingToHistory: enqueueActions(({ context, enqueue }) => {
        const head = context.queue[0];
        enqueue.sendTo('store', {
          type: 'store.append' as const,
          event: [
            ...context.notifications.map((entry) => messageAppended({ message: entry })),
            ...(head === undefined
              ? []
              : [messageAppended({ message: head })]),
          ],
        });
        enqueue.assign(drainPendingPatch(context));
      }),
      resetMirror: assign(({ context, event }) => {
        if (event.type !== 'store.reset') return {};
        return {
          ...mirrorPatch(event.state),
          queue: context.queue,
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
            ref: (spawn as SpawnChild)(context.toolLogic as ToolLogic, {
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
    initial: 'linking',
    context: ({ input }) => ({
      input,
      request: input.request,
      messages: [],
      turnTools: {},
      background: {},
      scope: createAbortScope(),
      notifications: [],
      reminders: [],
      queue: [],
      turnId: 0,
      branchId: 'main',
      paused: false,
    }),
    invoke: {
      src: 'controllerGuard',
      input: ({ context }) => ({ scope: context.scope }),
    },
    on: {
      'input.close': {
        target: '.closing',
      },
      'input.submit': {
        actions: assign(({ context, event }) => {
          if (event.type !== 'input.submit') return {};
          return {
            queue: [
              ...context.queue,
              createUserEntry(event.entry.message, { source: 'input', ...event.entry.meta }),
            ],
          };
        }),
      },
      'input.notify': {
        actions: assign(({ context, event }) => {
          if (event.type !== 'input.notify') return {};
          return {
            notifications: [
              ...context.notifications,
              createUserEntry(event.entry.message, { source: 'notify', ...event.entry.meta }),
            ],
          };
        }),
      },
      'input.remind': {
        actions: assign(({ context, event }) => {
          if (event.type !== 'input.remind') return {};
          const kept = context.reminders.filter((entry) => entry.meta?.key !== event.key);
          const meta = { source: 'reminder', key: event.key, ...event.entry.meta };
          kept.push(
            event.entry.message.role === 'system'
              ? createSystemEntry(event.entry.message, meta)
              : createUserEntry(event.entry.message, meta),
          );
          return { reminders: kept };
        }),
      },
      'input.steer': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.steer') return;
          const ids = typeof event.id === 'string' ? [event.id] : event.id;
          const steered = context.queue.filter(
            (item) => item.meta?.promptId !== undefined && ids.includes(item.meta?.promptId),
          );
          if (steered.length === 0) return;
          const merged = mergeSteerMessages(
            steered.map((item) => ({ content: item.message.content, origin: item.meta?.origin })),
          );
          enqueue.assign({
            queue: context.queue.filter((item) => !steered.includes(item)),
            notifications: [
              ...context.notifications,
              createUserEntry({ role: 'user', content: merged.content }, { source: 'input' }),
            ],
          });
          enqueue.emit({
            type: 'prompt.steered' as const,
            queueItemIds: steered.map((item) => item.meta?.promptId as string),
            entries: steered,
          });
        }),
      },
      'input.cancel': {
        actions: assign(({ context, event }) => {
          if (event.type !== 'input.cancel') return {};
          return { queue: context.queue.filter((item) => item.meta?.promptId !== event.id) };
        }),
      },
      'store.reset': {
        target: '.idle',
        actions: ['abortScope', 'resetMirror', 'emitReset', 'forwardToParent'],
      },
      'input.pause': {
        actions: assign({ paused: true }),
      },
      'input.continue': {
        actions: assign({ paused: false }),
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
      linking: {
        invoke: {
          src: 'scopeFactoryActor',
          input: ({ context, self }) => ({ ...context.input, self }),
          onDone: {
            target: '#agent.restoring',
            actions: [
              assign(({ context, event, spawn }) => {
                const output = event.output;
                spawn('storeActor', { id: 'store', input: { store: output.store } });
                return {
                  store: output.store,
                  handle: output.handle,
                  turnLogic: output.turnLogic,
                  toolLogic: output.toolLogic,
                  tools: output.tools,
                  request: output.request ?? context.request,
                  promptGate: output.promptGate,
                };
              }),
              emit({ type: 'agent.attached' as const }),
            ],
          },
          onError: {
            target: '#agent.disposed',
            actions: emit(({ event }) => ({ type: 'agent.failed' as const, error: event.error })),
          },
        },
        on: {
          'input.close': {
            target: '#agent.disposed',
          },
        },
      },
      restoring: {
        on: {
          'store.ready': {
            target: 'idle',
            actions: assign(({ context, event }) => ({
              ...mirrorPatch(event.state),
              notifications: [...event.state.notifications, ...context.notifications],
              reminders: [
                ...event.state.reminders.filter(
                  (entry) =>
                    !context.reminders.some((local) => local.meta?.key === entry.meta?.key),
                ),
                ...context.reminders,
              ],
              queue: [...event.state.queue, ...context.queue],
              turnId: event.state.turnIndex.nextTurnId,
              branchId: event.branch,
            })),
          },
        },
      },
      idle: {
        initial: 'ready',
        on: {
          'input.continue': {
            guard: ({ context }) =>
              !hasPendingWork(context) && historyEndsMidToolChain(context.messages),
            target: 'running',
            actions: [assign({ paused: false }), 'commitPendingToHistory'],
          },
        },
        states: {
          ready: {
            always: [
              {
                guard: ({ context }) =>
                  context.promptGate !== undefined && context.queue.length > 0 && !context.paused,
                target: 'gating',
              },
              {
                guard: ({ context }) => hasPendingWork(context) && !context.paused,
                target: '#agent.running',
                actions: ['commitPendingToHistory'],
              },
              {
                guard: ({ context }) => hasBackgroundWork(context),
                target: 'waiting',
              },
            ],
          },
          waiting: {
            always: [
              {
                guard: ({ context }) =>
                  context.promptGate !== undefined && context.queue.length > 0 && !context.paused,
                target: 'gating',
              },
              {
                guard: ({ context }) => hasPendingWork(context) && !context.paused,
                target: '#agent.running',
                actions: ['commitPendingToHistory'],
              },
            ],
          },
          gating: {
            invoke: {
              src: 'promptGateActor',
              input: ({ context }) => ({ gate: context.promptGate, head: context.queue[0] }),
              onDone: [
                {
                  guard: ({ context, event }) =>
                    context.paused || context.queue[0]?.meta?.promptId !== event.output.id,
                  target: 'ready',
                },
                {
                  guard: ({ event }) => event.output.error !== undefined,
                  target: 'ready',
                  actions: [
                    emit(({ context, event }) => ({
                      type: 'prompt.gate_failed' as const,
                      queueItemId: context.queue[0]?.meta?.promptId,
                      error: event.output.error,
                      entry: context.queue[0],
                    })),
                    assign(({ context }) => ({ queue: context.queue.slice(1) })),
                  ],
                },
                {
                  guard: ({ event }) => event.output.block,
                  target: 'ready',
                  actions: [
                    emit(({ context }) => ({
                      type: 'prompt.blocked' as const,
                      queueItemId: context.queue[0]?.meta?.promptId,
                      entry: context.queue[0],
                    })),
                    assign(({ context }) => ({ queue: context.queue.slice(1) })),
                  ],
                },
                {
                  target: '#agent.running',
                  actions: [
                    assign(({ context, event }) => {
                      const rewritten = event.output.message;
                      const head = context.queue[0];
                      if (rewritten === undefined || head === undefined) return {};
                      return { queue: [{ ...head, message: rewritten }, ...context.queue.slice(1)] };
                    }),
                    'commitPendingToHistory',
                  ],
                },
              ],
              onError: {
                target: 'ready',
                actions: [
                  emit(({ context, event }) => ({
                    type: 'prompt.gate_failed' as const,
                    queueItemId: context.queue[0]?.meta?.promptId,
                    error: event.error,
                    entry: context.queue[0],
                  })),
                  assign(({ context }) => ({ queue: context.queue.slice(1) })),
                ],
              },
            },
          },
        },
      },
      running: {
        entry: [
          assign({ activeTurnId: ({ context }) => context.turnId }),
          emit(({ context }) => ({
            type: 'turn.started' as const,
            turnId: context.turnId,
            branchId: context.branchId,
            queueItemId: context.drainedId,
            entry: context.drainedEntry,
          })),
          sendTo('store', ({ context }) => ({
            type: 'store.append' as const,
            event: turnStarted({ turnId: context.turnId, queueItemId: context.drainedId }),
          })),
          assign(({ context, spawn }) => {
            (spawn as SpawnChild)(context.turnLogic as TurnLogic, {
              id: 'turn',
              input: {
                request: {
                  ...context.request,
                  tools: context.tools?.filter((tool) => tool.deferred !== true),
                },
                history: context.messages,
                maxSteps: maxStepsPerTurn,
                parentSignal: context.scope.signal,
              },
            });
            return {};
          }),
        ],
        exit: [
          stopChild('turn'),
          'abortTurnTools',
          'stopTurnTools',
          assign({ turnTools: {} }),
          assign({ turnId: ({ context }) => context.turnId + 1 }),
        ],
        initial: 'active',
        on: {
          'xstate.done.actor.turn': {
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
          'xstate.error.actor.turn': {
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
          'store.reset': {
            target: '#agent.idle',
            actions: [
              'abortScope',
              'resetMirror',
              'emitReset',
              'forwardToParent',
            ],
          },
          'input.pause': {
            actions: [assign({ paused: true }), sendTo('turn', { type: 'turn.pause' as const })],
          },
          'input.continue': {
            actions: [assign({ paused: false }), sendTo('turn', { type: 'turn.continue' as const })],
          },
          'turn.drain': {
            actions: enqueueActions(({ context, enqueue }) => {
              const messages = [...context.notifications, ...context.reminders];
              enqueue.sendTo('turn', { type: 'turn.notify' as const, messages });
              if (messages.length === 0) return;
              enqueue.assign({ notifications: [], reminders: [] });
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
      closing: {
        entry: ['abortScope', 'abortTurnTools', 'stopTurnTools'],
        invoke: {
          src: 'disposeScopeActor',
          input: ({ context }) => ({ handle: context.handle }),
          onDone: '#agent.disposed',
          onError: '#agent.disposed',
        },
      },
      disposed: {
        type: 'final',
      },
    },
  });
}
