import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  useMachine,
  waitFor,
  type ActorRefFrom,
  type SnapshotFrom,
  type Subscription,
} from '#/xstate2/index';
import {
  createAgentMachine,
  createWaitForTasks,
  type AgentEmitted,
  type CreateAgentMachineOptions,
  type PromptGate,
} from '#/agent-machine/agent';
import type { CreateTurnMachineOptions, TurnRequest } from '#/agent-machine/turn';
import type { AgentLogEvent, AgentStore } from '#/stores/agent';
import {
  createSystemEntry,
  createUserEntry,
  type HistoryMessage,
  type SystemMessage,
  type UserMessage,
  type UserMeta,
} from '#/llm/message';
import type { LlmRequester } from '#/llm/requester/requester';
import type { LlmRetryOptions } from '#/llm/requester/retry';
import {
  createUnit,
  currentUnit,
  EventContext,
  hasCurrentUnit,
  mountRoot,
  provide,
  pushCleanup,
  useNode,
  useReady,
  type MountRootOptions,
  type NodeRef,
  type Ref,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';
import type { FeatureSpec } from '#/feature/feature';
import {
  AgentPort,
  AgentStoreRef,
  AgentUnitRef,
  WaitForTasksRef,
  bindAgentLogics,
  bindPromptGate,
  createAgentPorts,
} from '#/feature/contribution-hooks';
import { useFeatureSlot } from '#/feature/hooks';

type AgentActor = ActorRefFrom<ReturnType<typeof createAgentMachine>>;

function invokedHistory(actor: AgentActor): readonly HistoryMessage[] {
  const child = actor.getSnapshot().children['turn'];
  if (child === undefined) return [];
  const snapshot = child.getSnapshot() as { context?: { history?: readonly HistoryMessage[] } };
  return snapshot.context?.history ?? [];
}

function bindAgentLog(actor: AgentActor, store: AgentStore): { settled(): Promise<unknown> } {
  let chain: Promise<unknown> = Promise.resolve();
  const write = (events: AgentLogEvent | readonly AgentLogEvent[]): void => {
    chain = chain.then(() => store.dispatch(events)).catch(() => {});
  };
  const persisted = new Set<HistoryMessage>(store.getState().history);
  const persistMessages = (messages: readonly HistoryMessage[]): void => {
    const delta = messages.filter((message) => !persisted.has(message));
    if (delta.length === 0) return;
    for (const message of delta) persisted.add(message);
    write(delta.map((message) => ({ type: 'message.appended', message })));
  };
  let activeTurnId = store.getState().turnIndex.nextTurnId;
  actor.on('llm.done', (event) => persistMessages([event.entry]));
  actor.on('turn.drained', (event) => {
    persistMessages(invokedHistory(actor));
    persistMessages(event.messages);
  });
  actor.on('turn.started', () => {
    persistMessages(actor.getSnapshot().context.messages);
    const context = actor.getSnapshot().context;
    if (context.activeTurnId !== undefined) activeTurnId = context.activeTurnId;
    write({ type: 'turn.started', turnId: activeTurnId, queueItemId: context.drainedId });
  });
  const writeOutcome = (outcome: 'done' | 'failed' | 'aborted', error?: unknown): void => {
    persistMessages(actor.getSnapshot().context.messages);
    write({
      type: 'turn.ended',
      turnId: activeTurnId,
      outcome,
      errorMessage: outcome === 'failed' ? String(error) : undefined,
    });
  };
  actor.on('turn.done', () => writeOutcome('done'));
  actor.on('turn.failed', (event) =>
    writeOutcome(
      'failed',
      event.failure.reason === 'max_steps' ? event.failure.message : event.failure.error,
    ),
  );
  actor.on('turn.aborted', () => writeOutcome('aborted'));
  return { settled: () => chain };
}

export interface AgentUnitProps {
  readonly sessionId: string;
  readonly agentId: string;
  readonly store: AgentStore;
  readonly branchId?: string;
  readonly request: TurnRequest;
  readonly requester: LlmRequester;
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly machineOptions?: Omit<CreateAgentMachineOptions, 'turnLogic' | 'toolLogic'>;
  readonly turnOptions?: CreateTurnMachineOptions;
  readonly promptGate?: PromptGate;
  readonly retry?: LlmRetryOptions;
}

export type AgentSnapshot = SnapshotFrom<ReturnType<typeof createAgentMachine>>;

export interface AgentCommands {
  readonly agentId: string;
  readonly snapshot: Ref<AgentSnapshot | undefined>;
  submit(message: UserMessage, meta?: UserMeta): void;
  notify(message: UserMessage): void;
  remind(key: string, message: UserMessage | SystemMessage): void;
  cancel(id: string): void;
  steer(ids: string | readonly string[]): void;
  abort(reason?: unknown): void;
  pause(): void;
  continue(): void;
  on<T extends AgentEmitted['type']>(
    type: T,
    handler: (event: Extract<AgentEmitted, { type: T }>) => void,
  ): Subscription;
}

export interface AgentHandle extends UnitHandle, AgentCommands {
  disposeAsync(): Promise<void>;
}

export const AgentUnit = createUnit<AgentUnitProps>('agent', (props) => {
  const node = useNode();
  const ports = createAgentPorts();
  const { turnLogic, toolLogic } = bindAgentLogics(
    ports,
    props.requester,
    props.turnOptions,
    props.retry,
  );
  const restored = props.store.getState();
  const [snapshot, send, actor] = useMachine(
    () => createAgentMachine({ ...props.machineOptions, turnLogic, toolLogic }),
    {
      key: props.agentId,
      start: false,
      fire: false,
      input: {
        request: props.request,
        promptGate: bindPromptGate(ports, props.promptGate),
        messages: restored.history,
        notifications: restored.notifications,
        reminders: restored.reminders,
        queue: restored.queue,
        turnId: restored.turnIndex.nextTurnId,
        branchId: props.branchId,
      },
    },
  );
  const log = bindAgentLog(actor, props.store);
  pushCleanup(node, props.store.onCommit((entry) => {
    node.fire(entry.event);
  }));
  const commands: AgentCommands = {
    agentId: props.agentId,
    snapshot,
    submit: (message, meta) => send({ type: 'input.submit', entry: { message, meta } }),
    notify: (message) => send({ type: 'input.notify', entry: { message } }),
    remind: (key, message) => send({
      type: 'input.remind',
      key,
      entry: message.role === 'system' ? createSystemEntry(message) : createUserEntry(message),
    }),
    cancel: (id) => send({ type: 'input.cancel', id }),
    steer: (ids) => send({ type: 'input.steer', id: ids }),
    abort: (reason) => send({ type: 'input.abort', reason }),
    pause: () => send({ type: 'input.pause' }),
    continue: () => send({ type: 'input.continue' }),
    on: (type, handler) => {
      const subscription = actor.on(type, (event) => {
        if (type === 'turn.done' || type === 'turn.failed' || type === 'turn.aborted') {
          void log.settled().then(() => handler(event as Parameters<typeof handler>[0]));
          return;
        }
        handler(event as Parameters<typeof handler>[0]);
      });
      if (hasCurrentUnit()) {
        pushCleanup(currentUnit(), () => subscription.unsubscribe());
      }
      return subscription;
    },
  };
  provide(EventContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(AgentStoreRef, props.store);
  provide(AgentPort, ports);
  provide(WaitForTasksRef, createWaitForTasks(actor));
  provide(AgentUnitRef, commands);
  props.provide?.(node);
  const slots = useFeatureSlot('agent', props.features);
  let started = false;
  useReady(slots.ready().then(() => {
    if (node.signal.aborted) return;
    actor.start();
    started = true;
  }));
  pushCleanup(node, async () => {
    if (started) {
      actor.send({ type: 'input.close' });
      await waitFor(actor, (current) => current.status === 'done').catch(() => {});
    }
    await log.settled().catch(() => {});
  });
  return commands;
});

export function agentHandle(handle: UnitHandle): AgentHandle {
  const commands = (): AgentCommands => (handle.node as UnitNode).setupResult as AgentCommands;
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    update: (props) => handle.update(props),
    ready: () => handle.ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    get agentId() { return commands().agentId; },
    get snapshot() { return commands().snapshot; },
    submit: (message, meta) => commands().submit(message, meta),
    notify: (message) => commands().notify(message),
    remind: (key, message) => commands().remind(key, message),
    cancel: (id) => commands().cancel(id),
    steer: (ids) => commands().steer(ids),
    abort: (reason) => commands().abort(reason),
    pause: () => commands().pause(),
    continue: () => commands().continue(),
    on: (type, handler) => commands().on(type, handler),
  };
}

export function mountAgent(props: AgentUnitProps, opts?: MountRootOptions): AgentHandle {
  return agentHandle(mountRoot(AgentUnit, props, opts).handle);
}
