import {
  assign,
  emit,
  enqueueActions,
  fromCallback,
  fromPromise,
  sendTo,
  setup,
  spawnChild,
  stopChild,
  waitFor,
  type ActorRefFrom,
} from '#/xstate2/index';

import {
  createUserEntry,
  createUserMessage,
  mergeSteerMessages,
  type HistoryMessage,
  type SystemEntry,
  type ToolCall,
  type UserEntry,
  type UserMessage,
} from '#/llm/message';
import { createToolMachine, type ToolBeforeDecision, type ToolEvent, type ToolOutput } from './tool';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';

import {
  type TurnCompactionReason,
  type TurnLlmEvent,
  type TurnLogic,
  type TurnOutcome,
  type TurnOutput,
} from './turn';

export interface AgentInput {
  promptGate?: PromptGate;
  messages?: HistoryMessage[];
  notifications?: UserEntry[];
  reminders?: HistoryMessage[];
  queue?: UserEntry[];
  turnId?: number;
  branchId?: string;
}

export type PromptGateVerdict = boolean | { block: boolean; message?: UserMessage };

export type PromptGate = (
  queueItemId: string | undefined,
  message: UserMessage,
) => Promise<PromptGateVerdict>;

type ToolLogic = ReturnType<typeof createToolMachine>;
type ToolActorRef = ActorRefFrom<ToolLogic>;

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

export type WaitForTasks = (input: TaskWaitInput) => Promise<TaskWaitOutcome>;

interface WaitForTarget {
  id: string;
  ref: ToolActorRef;
}

interface AgentSnapshotSource {
  getSnapshot(): {
    context: {
      background: Record<string, { ref: ToolActorRef }>;
    };
  };
}

export function createWaitForTasks(self: AgentSnapshotSource): WaitForTasks {
  return async ({ taskId, timeoutMs }) => {
    const { background } = self.getSnapshot().context;
    const targets: WaitForTarget[] = [];
    const unknown: string[] = [];
    const ids = taskId === undefined ? Object.keys(background) : [taskId];
    for (const id of ids) {
      const ref = background[id]?.ref;
      if (ref === undefined) {
        unknown.push(id);
      } else {
        targets.push({ id, ref });
      }
    }
    if (targets.length === 0) {
      return { completed: [], running: [], unknown, timedOut: false };
    }
    const waitForAny = () =>
      Promise.any(
        targets.map(({ ref }) =>
          waitFor(ref, (snapshot) => snapshot.status === 'done').catch(() => undefined),
        ),
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, timeoutMs);
    });
    const timedOut =
      (await Promise.race([waitForAny().then(() => 'done' as const), timeout])) === 'timeout';
    clearTimeout(timer);
    const completed = targets
      .filter(({ ref }) => ref.getSnapshot().status === 'done')
      .map(({ id }) => id);
    const running = targets
      .filter(({ ref }) => ref.getSnapshot().status !== 'done')
      .map(({ id }) => id);
    return { completed, running, unknown, timedOut };
  };
}

export type AgentEvent =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'input.submit'; entry: UserEntry }
  | { type: 'input.notify'; entry: UserEntry }
  | { type: 'input.remind'; entry: SystemEntry | UserEntry }
  | { type: 'input.steer'; id: string | readonly string[] }
  | { type: 'input.cancel'; id: string }
  | { type: 'input.abort'; reason?: unknown }
  | { type: 'input.abort_tool'; toolCallId: string; reason?: unknown }
  | { type: 'input.detach_tool'; toolCallId: string }
  | { type: 'input.pause' }
  | { type: 'input.continue' }
  | { type: 'input.close' }
  | {
      type: 'input.context_reset';
      messages?: HistoryMessage[];
      reason?: string;
      instruction?: string;
      stats?: Record<string, number>;
      error?: unknown;
    }
  | {
      type: 'turn.spawn_tools';
      toolCalls: ToolCall[];
      decisions?: Record<string, ToolBeforeDecision>;
    }
  | { type: 'turn.compaction_requested'; reason: TurnCompactionReason; history: HistoryMessage[] }
  | { type: 'turn.drain' }
  | { type: 'step.started'; step: number }
  | { type: 'xstate.done.actor.turn'; output: TurnOutput }
  | { type: 'xstate.error.actor.turn'; error: unknown };

export type AgentEmitted =
  | TurnLlmEvent
  | ToolEvent
  | { type: 'turn.started'; turnId: number; branchId: string; queueItemId?: string; entry?: UserEntry }
  | { type: 'turn.prompt_committed'; turnId: number; entry: UserEntry }
  | { type: 'step.started'; step: number }
  | { type: 'turn.aborting' }
  | {
      type: 'turn.spawn_tools';
      toolCalls: ToolCall[];
      decisions?: Record<string, ToolBeforeDecision>;
    }
  | { type: 'turn.compaction_requested'; turnId: number; reason: TurnCompactionReason; history: HistoryMessage[] }
  | { type: 'turn.drained'; messages: HistoryMessage[] }
  | { type: 'turn.done'; turnId: number; outcome: TurnOutcome; messages: HistoryMessage[]; branchId: string }
  | {
      type: 'context.reset';
      messages: HistoryMessage[];
      reason?: string;
      instruction?: string;
      stats?: Record<string, number>;
    }
  | {
      type: 'prompt.blocked';
      queueItemId?: string;
      entry?: UserEntry;
      reason: 'gate' | 'error';
      error?: unknown;
    }
  | { type: 'prompt.submitted'; entry: UserEntry }
  | { type: 'prompt.notified'; entry: UserEntry }
  | { type: 'prompt.reminded'; entry: SystemEntry | UserEntry }
  | { type: 'prompt.cancelled'; id: string; cancelled: boolean }
  | { type: 'prompt.steered'; ids: string[]; queueItemIds: string[]; entries: UserEntry[] }
  | { type: 'agent.paused' }
  | { type: 'agent.continued' }
  | { type: 'agent.aborted'; reason?: unknown }
  | { type: 'agent.failed'; error: unknown };

interface ToolEntry {
  toolCall: ToolCall;
  scope: AbortScope;
  ref: ToolActorRef;
}

export interface AgentMachineContext {
  input: AgentInput;
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
  abortReason?: unknown;
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
  event: { toolCallId: string; outcome: ToolOutput },
): { notifications?: UserEntry[]; background?: AgentMachineContext['background'] } {
  const entry = context.background[event.toolCallId];
  if (entry === undefined) {
    return {};
  }
  const background = { ...context.background };
  delete background[event.toolCallId];
  return {
    notifications: [
      ...context.notifications,
      completionNotification(entry.toolCall, event.outcome),
    ],
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
  const turnId = context.activeTurnId ?? context.turnId;
  const outcome: TurnOutcome =
    output.type === 'failed'
      ? { type: 'failed', failure: output.failure }
      : output.type === 'aborted'
        ? { type: 'aborted', reason: output.reason }
        : { type: 'done' };
  return { type: 'turn.done', turnId, outcome, messages: context.messages, branchId: context.branchId };
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
    messages: [...context.messages, ...context.notifications],
    notifications: [],
    queue: rest,
    drainedId: head?.meta?.promptId,
    drainedEntry: head,
  };
}

export interface CreateAgentMachineOptions {
  abortTimeoutMs?: number;
  maxStepsPerTurn?: number;
  turnLogic: TurnLogic;
  toolLogic: ToolLogic;
}

export function createAgentMachine({
  abortTimeoutMs,
  maxStepsPerTurn,
  turnLogic,
  toolLogic,
}: CreateAgentMachineOptions) {
  return setup({
    types: {
      input: {} as AgentInput,
      context: {} as AgentMachineContext,
      events: {} as AgentEvent,
      emitted: {} as AgentEmitted,
    },
    actors: {
      turnActor: turnLogic,
      toolActor: toolLogic,
      controllerGuard: fromCallback<AgentEvent, { scope: AbortScope }>(
        ({ input }) =>
          () =>
            input.scope.abort(),
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
    },
    actions: {
      forwardToParent: ({ self, event }) => {
        self._parent?.send(event);
      },
      drainPending: enqueueActions(({ context, enqueue }) => {
        enqueue.assign(drainPendingPatch(context));
      }),
      commitDrainedPrompt: enqueueActions(({ context, enqueue }) => {
        const entry = context.drainedEntry;
        if (entry === undefined) return;
        enqueue.assign({ messages: [...context.messages, entry] });
        enqueue.emit({
          type: 'turn.prompt_committed' as const,
          turnId: context.activeTurnId ?? context.turnId,
          entry,
        });
      }),
      spawnTurn: spawnChild('turnActor', {
        id: 'turn',
        input: ({ context }: { context: AgentMachineContext }) => ({
          history: context.messages,
          maxSteps: maxStepsPerTurn,
          parentSignal: context.scope.signal,
        }),
      }),
      pauseTurnIfPaused: enqueueActions(({ context, enqueue }) => {
        if (context.paused) enqueue.sendTo('turn', { type: 'turn.pause' as const });
      }),
      abortScope: ({ context }) => {
        context.scope.abort();
      },
      spawnTurnTools: assign(({ context, spawn, event }) => {
        if (event.type !== 'turn.spawn_tools') {
          return {};
        }
        const turnTools = { ...context.turnTools };
        for (const toolCall of event.toolCalls) {
          const scope = withAbort(context.scope.signal);
          const decision = event.decisions?.[toolCall.id];
          turnTools[toolCall.id] = {
            toolCall,
            scope,
            ref: spawn('toolActor', {
              id: toolCall.id,
              input: {
                toolCall:
                  decision?.type === 'proceed' && decision.toolCall !== undefined
                    ? decision.toolCall
                    : toolCall,
                signal: scope.signal,
                result:
                  decision?.type === 'denied'
                    ? { ...decision.result, isError: true }
                    : undefined,
              },
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
            entry.scope.abort(context.abortReason);
            enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
          }
        }
      }),
      rememberAbortReason: assign(({ event }) => ({
        abortReason: event.type === 'input.abort' ? event.reason : undefined,
      })),
      abortTurn: sendTo('turn', ({ context }) => ({
        type: 'turn.abort' as const,
        reason: context.abortReason,
      })),
      abortTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const entry of Object.values(context.turnTools)) {
          entry.scope.abort(context.abortReason);
          enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
        }
      }),
      stopTurnTools: enqueueActions(({ context, enqueue }) => {
        for (const [toolCallId, entry] of Object.entries(context.turnTools)) {
          entry.scope.abort(context.abortReason);
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
      promptGate: input.promptGate,
      messages: input.messages ?? [],
      turnTools: {},
      background: {},
      scope: createAbortScope(),
      notifications: input.notifications ?? [],
      reminders: input.reminders ?? [],
      queue: input.queue ?? [],
      turnId: input.turnId ?? 0,
      branchId: input.branchId ?? 'main',
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
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.submit') return;
          enqueue.assign({ queue: [...context.queue, event.entry] });
          enqueue.emit({ type: 'prompt.submitted' as const, entry: event.entry   });
        }),
      },
      'input.notify': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.notify') return;
          enqueue.assign({ notifications: [...context.notifications, event.entry] });
          enqueue.emit({ type: 'prompt.notified' as const, entry: event.entry });
        }),
      },
      'input.remind': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.remind') return;
          enqueue.assign({ reminders: [...context.reminders, event.entry] });
          enqueue.emit({ type: 'prompt.reminded' as const, entry: event.entry });
        }),
      },
      'input.steer': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.steer') return;
          const ids = typeof event.id === 'string' ? [event.id] : [...event.id];
          const steered = context.queue.filter(
            (item) => item.meta?.promptId !== undefined && ids.includes(item.meta.promptId),
          );
          if (steered.length > 0) {
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
          }
          enqueue.emit({
            type: 'prompt.steered' as const,
            ids,
            queueItemIds: steered.map((item) => item.meta?.promptId as string),
            entries: steered,
          });
        }),
      },
      'input.cancel': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.cancel') return;
          const queue = context.queue.filter((item) => item.meta?.promptId !== event.id);
          enqueue.assign({ queue });
          enqueue.emit({
            type: 'prompt.cancelled' as const,
            id: event.id,
            cancelled: queue.length !== context.queue.length,
          });
        }),
      },
      'input.abort': {
        actions: emit(({ event }) => ({
          type: 'agent.aborted' as const,
          reason: event.type === 'input.abort' ? event.reason : undefined,
        })),
      },
      'input.abort_tool': {
        actions: enqueueActions(({ context, event, enqueue }) => {
          if (event.type !== 'input.abort_tool') return;
          const entry = context.background[event.toolCallId];
          if (entry === undefined) return;
          entry.scope.abort(event.reason);
          enqueue.sendTo(entry.ref, { type: 'tool.abort' as const });
        }),
      },
      'input.pause': {
        actions: [assign({ paused: true }), emit({ type: 'agent.paused' as const })],
      },
      'input.continue': {
        actions: [assign({ paused: false }), emit({ type: 'agent.continued' as const })],
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
    },
    states: {
      idle: {
        initial: 'ready',
        on: {
          'input.context_reset': {
            guard: ({ event }) => event.messages !== undefined,
            actions: [
              assign({ messages: ({ event }) => event.messages as HistoryMessage[] }),
              emit(({ event }) => ({
                type: 'context.reset' as const,
                messages: event.messages as HistoryMessage[],
                reason: event.reason,
                instruction: event.instruction,
                stats: event.stats,
              })),
            ],
          },
          'input.continue': {
            guard: ({ context }) =>
              !hasPendingWork(context) && historyEndsMidToolChain(context.messages),
            target: 'running',
            actions: [
              assign({ paused: false }),
              'drainPending',
              emit({ type: 'agent.continued' as const }),
            ],
          },
          'input.abort': {
            actions: emit(({ event }) => ({
              type: 'agent.aborted' as const,
              reason: event.type === 'input.abort' ? event.reason : undefined,
            })),
          },
        },
        states: {
          ready: {
            always: [
              {
                guard: ({ context }) => hasPendingWork(context) && !context.paused,
                target: '#agent.running',
                actions: ['drainPending'],
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
                guard: ({ context }) => hasPendingWork(context) && !context.paused,
                target: '#agent.running',
                actions: ['drainPending'],
              },
            ],
          },
        },
      },
      running: {
        entry: [
          assign({ activeTurnId: ({ context }) => context.turnId, abortReason: undefined }),
          emit(({ context }) => ({
            type: 'turn.started' as const,
            turnId: context.turnId,
            branchId: context.branchId,
            queueItemId: context.drainedId,
            entry: context.drainedEntry,
          })),
        ],
        exit: [
          'abortTurnTools',
          'stopTurnTools',
          stopChild('turn'),
          assign({ turnTools: {} }),
          assign({ turnId: ({ context }) => context.turnId + 1 }),
        ],
        initial: 'gating',
        on: {
          'xstate.done.actor.turn': {
            target: '#agent.idle',
            actions: [
              assign(({ context, event }) => turnOutputPatch(context, event.output)),
              emit(({ context, event }) => turnOutcomeEvent(context, event.output)),
            ],
          },
          'xstate.error.actor.turn': {
            target: '#agent.idle',
            actions: [
              emit(({ context, event }) =>
                turnOutcomeEvent(context, {
                  type: 'failed' as const,
                  failure: { reason: 'error', error: event.error },
                  produced: [],
                }),
              ),
            ],
          },
          'input.pause': {
            actions: [
              assign({ paused: true }),
              sendTo('turn', { type: 'turn.pause' as const }),
              emit({ type: 'agent.paused' as const }),
            ],
          },
          'input.continue': {
            actions: [
              assign({ paused: false }),
              sendTo('turn', { type: 'turn.continue' as const }),
              emit({ type: 'agent.continued' as const }),
            ],
          },
          'turn.drain': {
            actions: enqueueActions(({ context, enqueue }) => {
              const messages = [...context.notifications, ...context.reminders];
              enqueue.sendTo('turn', { type: 'agent.notify' as const, messages });
              enqueue.emit({ type: 'turn.drained' as const, messages });
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
          'input.detach_tool': {
            guard: ({ context, event }) =>
              event.type === 'input.detach_tool' &&
              context.turnTools[event.toolCallId] !== undefined,
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
              sendTo('turn', ({ context, event }) => {
                const entry = context.background[event.toolCallId] as ToolEntry;
                return {
                  type: 'tool.detached' as const,
                  toolCallId: event.toolCallId,
                  text: `moved to background by the user: ${entry.toolCall.name} (tool_call_id=${event.toolCallId})`,
                  toolCall: entry.toolCall,
                };
              }),
              emit(({ context, event }) => {
                const entry = context.background[event.toolCallId] as ToolEntry;
                return {
                  type: 'tool.detached' as const,
                  toolCallId: event.toolCallId,
                  text: `moved to background by the user: ${entry.toolCall.name} (tool_call_id=${event.toolCallId})`,
                  toolCall: entry.toolCall,
                };
              }),
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
          'llm.aborted': {
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
          'turn.compaction_requested': {
            actions: [
              emit(({ context, event }) => ({
                type: 'turn.compaction_requested' as const,
                turnId: context.activeTurnId ?? context.turnId,
                reason: event.reason,
                history: event.history,
              })),
              'forwardToParent',
            ],
          },
          'input.context_reset': [
            {
              guard: ({ event }) => event.messages !== undefined,
              actions: [
                assign({ messages: ({ event }) => event.messages as HistoryMessage[] }),
                sendTo('turn', ({ event }) => ({
                  type: 'turn.compaction_finished' as const,
                  history: event.messages,
                })),
                emit(({ event }) => ({
                  type: 'context.reset' as const,
                  messages: event.messages as HistoryMessage[],
                  reason: event.reason,
                  instruction: event.instruction,
                  stats: event.stats,
                })),
              ],
            },
            {
              actions: sendTo('turn', ({ event }) => ({
                type: 'turn.compaction_finished' as const,
                error: event.error,
              })),
            },
          ],
        },
        states: {
          gating: {
            always: [
              {
                guard: ({ context }) =>
                  context.drainedEntry === undefined || context.promptGate === undefined,
                target: 'active',
                actions: ['commitDrainedPrompt', 'spawnTurn', 'pauseTurnIfPaused'],
              },
            ],
            invoke: {
              src: 'promptGateActor',
              input: ({ context }) => ({ gate: context.promptGate, head: context.drainedEntry }),
              onDone: [
                {
                  guard: ({ event }) => event.output.error !== undefined,
                  target: '#agent.idle',
                  actions: [
                    'commitDrainedPrompt',
                    emit(({ context, event }) => ({
                      type: 'prompt.blocked' as const,
                      queueItemId: context.drainedId,
                      entry: context.drainedEntry,
                      reason: 'error' as const,
                      error: event.output.error,
                    })),
                    emit(({ context, event }) =>
                      turnOutcomeEvent(context, {
                        type: 'failed' as const,
                        failure: { reason: 'error', error: event.output.error },
                        produced: [],
                      }),
                    ),
                  ],
                },
                {
                  guard: ({ event }) => event.output.block,
                  target: '#agent.idle',
                  actions: [
                    'commitDrainedPrompt',
                    emit(({ context }) => ({
                      type: 'prompt.blocked' as const,
                      queueItemId: context.drainedId,
                      entry: context.drainedEntry,
                      reason: 'gate' as const,
                    })),
                    emit(({ context }) =>
                      turnOutcomeEvent(context, {
                        type: 'failed' as const,
                        failure: { reason: 'error', error: undefined },
                        produced: [],
                      }),
                    ),
                  ],
                },
                {
                  target: 'active',
                  actions: [
                    assign(({ context, event }) => {
                      const rewritten = event.output.message;
                      const head = context.drainedEntry;
                      if (rewritten === undefined || head === undefined) return {};
                      return { drainedEntry: { ...head, message: rewritten } };
                    }),
                    'commitDrainedPrompt',
                    'spawnTurn',
                    'pauseTurnIfPaused',
                  ],
                },
              ],
              onError: {
                target: '#agent.idle',
                actions: [
                  'commitDrainedPrompt',
                  emit(({ context, event }) => ({
                    type: 'prompt.blocked' as const,
                    queueItemId: context.drainedId,
                    entry: context.drainedEntry,
                    reason: 'error' as const,
                    error: event.error,
                  })),
                  emit(({ context, event }) =>
                    turnOutcomeEvent(context, {
                      type: 'failed' as const,
                      failure: { reason: 'error', error: event.error },
                      produced: [],
                    }),
                  ),
                ],
              },
            },
            on: {
              'input.pause': {
                actions: [assign({ paused: true }), emit({ type: 'agent.paused' as const })],
              },
              'input.continue': {
                actions: [assign({ paused: false }), emit({ type: 'agent.continued' as const })],
              },
              'input.context_reset': {
                guard: ({ event }) => event.messages !== undefined,
                actions: [
                  assign({ messages: ({ event }) => event.messages as HistoryMessage[] }),
                  emit(({ event }) => ({
                    type: 'context.reset' as const,
                    messages: event.messages as HistoryMessage[],
                    reason: event.reason,
                    instruction: event.instruction,
                    stats: event.stats,
                  })),
                ],
              },
              'input.abort': {
                target: '#agent.idle',
                actions: [
                  'rememberAbortReason',
                  emit({ type: 'turn.aborting' as const }),
                  emit(({ event }) => ({
                    type: 'agent.aborted' as const,
                    reason: event.type === 'input.abort' ? event.reason : undefined,
                  })),
                  emit(({ context, event }) =>
                    turnOutcomeEvent(context, {
                      type: 'aborted' as const,
                      reason: event.type === 'input.abort' ? event.reason : undefined,
                      produced: [],
                    }),
                  ),
                ],
              },
            },
          },
          active: {
            on: {
              'turn.spawn_tools': {
                actions: ['spawnTurnTools', emit(({ event }) => event)],
              },
              'input.abort': {
                target: 'aborting',
                actions: [
                  'rememberAbortReason',
                  'abortTurn',
                  'abortTurnTools',
                  emit({ type: 'turn.aborting' as const }),
                  emit(({ event }) => ({
                    type: 'agent.aborted' as const,
                    reason: event.type === 'input.abort' ? event.reason : undefined,
                  })),
                ],
              },
            },
          },
          aborting: {
            after: {
              abortTimeout: { actions: ['abortTurn', 'stopTurnTools'] },
            },
            on: {
              'turn.spawn_tools': {
                actions: ['spawnTurnTools', 'abortSpawnedTools', emit(({ event }) => event)],
              },
              'input.abort': {
                actions: [
                  'rememberAbortReason',
                  'abortTurn',
                  'stopTurnTools',
                  emit(({ event }) => ({
                    type: 'agent.aborted' as const,
                    reason: event.type === 'input.abort' ? event.reason : undefined,
                  })),
                ],
              },
            },
          },
        },
      },
      closing: {
        entry: ['abortScope', 'abortTurnTools', 'stopTurnTools'],
        always: '#agent.disposed',
      },
      disposed: {
        type: 'final',
      },
    },
  });
}
