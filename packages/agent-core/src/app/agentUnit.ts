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
import type { CreateTurnMachineOptions, TurnOutcome } from '#/agent-machine/turn';
import type { AgentLogEvent, AgentStore } from '#/stores/agent';
import {
  createSystemEntry,
  createUserEntry,
  type HistoryMessage,
  type SystemMessage,
  type UserMessage,
  type UserMeta,
} from '#/llm/message';
import type { LlmCredentialProvider, LlmRequestConfig, LlmRequester } from '#/llm/requester/requester';
import type { LlmRetryOptions } from '#/llm/requester/retry';
import {
  createUnit,
  currentUnit,
  EventContext,
  hasCurrentUnit,
  mountRoot,
  provide,
  pushCleanup,
  useReady,
  type CertainToken,
  type EventHandler,
  type FacadeToken,
  type MountRootOptions,
  type NodeRef,
  type Ref,
  type RuntimeEvent,
  type UnitHandle,
  type UnitNode,
  type Unsubscribe,
  type WaitOpts,
} from '#/kernel/index';
import { useNode } from '#/kernel/hooks';
import { bindHandleOn, type FeatureSpec, type ListenOpts } from '#/feature/feature';
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
import { AgentNodeRef } from '#/feature/tierNodes';

type AgentActor = ActorRefFrom<ReturnType<typeof createAgentMachine>>;

type AgentAck<T extends AgentEmitted['type']> = Extract<AgentEmitted, { type: T }>;

function acceptEmitted<T extends AgentEmitted['type']>(
  actor: AgentActor,
  node: NodeRef,
  type: T,
  send: () => void,
  match: (event: AgentAck<T>) => boolean = () => true,
): AgentAck<T> | undefined {
  if (node.signal.aborted) return undefined;
  const status = actor.getSnapshot().status;
  if (status === 'done' || status === 'stopped') return undefined;
  let accepted: AgentAck<T> | undefined;
  const subscription = actor.on(type, (event) => {
    const typed = event as AgentAck<T>;
    if (match(typed)) accepted = typed;
  });
  try {
    send();
  } finally {
    subscription.unsubscribe();
  }
  return accepted;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error(reason === undefined ? 'aborted' : String(reason));
}

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
  actor.on('turn.prompt_committed', (event) => persistMessages([event.entry]));
  actor.on('context.reset', (event) => {
    for (const message of event.messages) persisted.add(message);
    write({
      type: 'context.reset',
      messages: event.messages,
      reason: event.reason,
      instruction: event.instruction,
      stats: event.stats,
    });
  });
  actor.on('turn.drained', (event) => {
    persistMessages(invokedHistory(actor));
    persistMessages(event.messages);
  });
  actor.on('turn.started', () => {
    const context = actor.getSnapshot().context;
    if (context.activeTurnId !== undefined) activeTurnId = context.activeTurnId;
    write({ type: 'turn.started', turnId: activeTurnId, queueItemId: context.drainedId });
    persistMessages(context.messages);
  });
  actor.on('turn.done', (event) => {
    const outcome = event.outcome;
    persistMessages(actor.getSnapshot().context.messages);
    write({
      type: 'turn.ended',
      turnId: activeTurnId,
      outcome: outcome.type,
      errorMessage:
        outcome.type === 'failed'
          ? String(outcome.failure.reason === 'max_steps' ? outcome.failure.message : outcome.failure.error)
          : undefined,
    });
  });
  return { settled: () => chain };
}

export interface AgentUnitProps {
  readonly sessionId: string;
  readonly agentId: string;
  readonly store: AgentStore;
  readonly branchId?: string;
  readonly systemPrompt?: string;
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly machineOptions?: Omit<CreateAgentMachineOptions, 'turnLogic' | 'toolLogic'>;
  readonly turnOptions?: CreateTurnMachineOptions;
  readonly promptGate?: PromptGate;
  readonly retry?: LlmRetryOptions;
}

export type AgentSnapshot = SnapshotFrom<ReturnType<typeof createAgentMachine>>;

export interface AgentWaitOpts<T extends AgentEmitted['type']> {
  readonly match?: (event: Extract<AgentEmitted, { type: T }>) => boolean;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class AgentRunError extends Error {
  readonly code: 'not_running' | 'blocked' | 'busy';

  constructor(code: 'not_running' | 'blocked' | 'busy', message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AgentRunError';
    this.code = code;
  }
}

export interface AgentRunOpts {
  readonly meta?: UserMeta;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStarted?: (turnId: number) => void;
  readonly abortAsOutcome?: boolean;
}

export interface AgentRunResult {
  readonly turnId: number;
  readonly branchId: string;
  readonly outcome: TurnOutcome;
  readonly messages: readonly HistoryMessage[];
}

export interface AgentRunOutcome {
  readonly turnId?: number;
  readonly branchId?: string;
  readonly outcome: TurnOutcome;
  readonly messages?: readonly HistoryMessage[];
}

export interface ContextResetInput {
  readonly messages?: HistoryMessage[];
  readonly reason?: string;
  readonly instruction?: string;
  readonly stats?: Record<string, number>;
  readonly error?: unknown;
}

let runSeq = 0;

export interface AgentCommands {
  readonly agentId: string;
  readonly snapshot: Ref<AgentSnapshot | undefined>;
  readonly config: LlmRequestConfig | undefined;
  setRequester(requester: LlmRequester): void;
  setConfig(config: LlmRequestConfig): void;
  setCredentialProvider(provider?: LlmCredentialProvider): void;
  submit(message: UserMessage, meta?: UserMeta): AgentAck<'prompt.submitted'> | undefined;
  notify(message: UserMessage): AgentAck<'prompt.notified'> | undefined;
  remind(message: UserMessage | SystemMessage, meta?: UserMeta): AgentAck<'prompt.reminded'> | undefined;
  cancel(id: string): AgentAck<'prompt.cancelled'> | undefined;
  steer(ids: string | readonly string[]): AgentAck<'prompt.steered'> | undefined;
  abort(reason?: unknown): AgentAck<'agent.aborted'> | undefined;
  abortTool(toolCallId: string, reason?: unknown): void;
  detachTool(toolCallId: string): void;
  pause(): AgentAck<'agent.paused'> | undefined;
  continue(): AgentAck<'agent.continued'> | undefined;
  contextReset(input: ContextResetInput): AgentAck<'context.reset'> | undefined;
  on<T extends AgentEmitted['type']>(
    type: T,
    handler: (event: Extract<AgentEmitted, { type: T }>) => void,
  ): Subscription;
  wait<T extends AgentEmitted['type']>(
    type: T,
    opts?: AgentWaitOpts<T>,
  ): Promise<Extract<AgentEmitted, { type: T }>>;
  run(message: UserMessage, opts: AgentRunOpts & { abortAsOutcome: true }): Promise<AgentRunOutcome>;
  run(message: UserMessage, opts?: AgentRunOpts): Promise<AgentRunResult>;
  retry(opts: AgentRunOpts & { abortAsOutcome: true }): Promise<AgentRunOutcome>;
  retry(opts?: AgentRunOpts): Promise<AgentRunResult>;
}

export interface AgentHandleOn {
  on<T extends AgentEmitted['type']>(
    type: T,
    handler: (event: Extract<AgentEmitted, { type: T }>) => void,
  ): Subscription;
  on<E extends RuntimeEvent, T extends E['type']>(
    feature: FeatureSpec<E>,
    type: T,
    handler: EventHandler<Extract<E, { type: T }>>,
    opts?: ListenOpts,
  ): Unsubscribe;
  on<E extends RuntimeEvent>(
    feature: FeatureSpec<E>,
    type: '*',
    handler: EventHandler<E>,
    opts?: ListenOpts,
  ): Unsubscribe;
  wait<T extends AgentEmitted['type']>(
    type: T,
    opts?: AgentWaitOpts<T>,
  ): Promise<Extract<AgentEmitted, { type: T }>>;
  wait<E extends RuntimeEvent, T extends E['type']>(
    feature: FeatureSpec<E>,
    type: T,
    opts?: WaitOpts<Extract<E, { type: T }>>,
  ): Promise<Extract<E, { type: T }>>;
  wait<E extends RuntimeEvent>(
    feature: FeatureSpec<E>,
    type: '*',
    opts?: WaitOpts<E>,
  ): Promise<E>;
}

export interface AgentHandle extends UnitHandle, Omit<AgentCommands, 'on' | 'wait'>, AgentHandleOn {
  disposeAsync(): Promise<void>;
}

export const AgentUnit = createUnit<AgentUnitProps>('agent', (props) => {
  const node = useNode();
  const ports = createAgentPorts();
  let requester: LlmRequester | undefined;
  let config: LlmRequestConfig | undefined;
  let credentialProvider: LlmCredentialProvider | undefined;
  const { turnLogic, toolLogic } = bindAgentLogics(
    ports,
    () => requester,
    {
      ...props.turnOptions,
      getConfig: () => config,
      getCredentialProvider: () => credentialProvider,
      getHostPrompt: () => props.systemPrompt,
    },
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
        promptGate: bindPromptGate(ports, props.promptGate),
        messages: restored.history,
        turnId: restored.turnIndex.nextTurnId,
        branchId: props.branchId,
      },
    },
  );
  const log = bindAgentLog(actor, props.store);
  pushCleanup(node, props.store.onCommit((entry) => {
    node.fire(entry.event);
  }));
  const onEmitted: AgentCommands['on'] = (type, handler) => {
    const subscription = actor.on(type, (event) => {
      if (type === 'turn.done') {
        void log.settled().then(() => handler(event as Parameters<typeof handler>[0]));
        return;
      }
      handler(event as Parameters<typeof handler>[0]);
    });
    if (hasCurrentUnit()) {
      pushCleanup(currentUnit(), () => subscription.unsubscribe());
    }
    return subscription;
  };
  const runTurn = async (
    message: UserMessage,
    opts?: AgentRunOpts,
  ): Promise<AgentRunResult | AgentRunOutcome> => {
    const snapshot = actor.getSnapshot();
    if (
      snapshot.status !== 'active' ||
      !snapshot.matches('idle') ||
      snapshot.context.paused ||
      snapshot.context.queue.length > 0 ||
      snapshot.context.notifications.length > 0
    ) {
      throw new AgentRunError('busy', 'agent is busy');
    }
    const promptId = opts?.meta?.promptId ?? `run-${++runSeq}`;
    if (opts?.signal?.aborted) {
      if (opts.abortAsOutcome === true) {
        return { outcome: { type: 'aborted' as const, reason: opts.signal.reason } };
      }
      throw abortReason(opts.signal);
    }
    const scope = new AbortController();
    const onExternalAbort = (): void => scope.abort(opts?.signal?.reason);
    opts?.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer =
      opts?.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            scope.abort(new Error(`run timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
    try {
      const blocked = commands
        .wait('prompt.blocked', {
          match: (event) => event.queueItemId === promptId,
          signal: scope.signal,
        })
        .then((event): never => {
          throw new AgentRunError('blocked', `prompt blocked (${event.reason})`, {
            cause: event.error,
          });
        });
      void blocked.catch(() => {});
      const ack = commands.submit(message, { ...opts?.meta, promptId });
      if (ack === undefined) throw new AgentRunError('not_running', 'agent is not running');
      const turnId = actor.getSnapshot().context.activeTurnId;
      if (turnId === undefined) throw new AgentRunError('not_running', 'agent is not running');
      opts?.onStarted?.(turnId);
      try {
        return await Promise.race([
          commands
            .wait('turn.done', {
              match: (event) => event.turnId === turnId,
              signal: scope.signal,
            })
            .then((event) => ({
              turnId: event.turnId,
              branchId: event.branchId,
              outcome: event.outcome,
              messages: event.messages,
            })),
          blocked,
        ]);
      } catch (error) {
        if (scope.signal.aborted) {
          commands.abort(scope.signal.reason);
          if (opts?.abortAsOutcome === true) {
            return { outcome: { type: 'aborted' as const, reason: scope.signal.reason } };
          }
          throw abortReason(scope.signal);
        }
        throw error;
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      opts?.signal?.removeEventListener('abort', onExternalAbort);
      scope.abort();
    }
  };

  const retryTurn = (opts?: AgentRunOpts): Promise<AgentRunResult | AgentRunOutcome> =>
    runTurn(
      { role: 'user', content: [] },
      { ...opts, meta: { ...opts?.meta, origin: { kind: 'retry' } } },
    );

  const commands: AgentCommands = {
    agentId: props.agentId,
    snapshot,
    get config() {
      return config;
    },
    setRequester: (next) => {
      requester = next;
    },
    setConfig: (next) => {
      config = next;
    },
    setCredentialProvider: (next) => {
      credentialProvider = next;
    },
    submit: (message, meta) => {
      const entry = createUserEntry(message, { source: 'input', ...meta });
      return acceptEmitted(actor, node, 'prompt.submitted', () => send({ type: 'input.submit', entry }), (event) => event.entry === entry);
    },
    notify: (message) => {
      const entry = createUserEntry(message, { source: 'notify' });
      return acceptEmitted(actor, node, 'prompt.notified', () => send({ type: 'input.notify', entry }), (event) => event.entry === entry);
    },
    remind: (message, meta) => {
      const entry = message.role === 'system'
        ? createSystemEntry(message, { source: 'reminder', key: meta?.key })
        : createUserEntry(message, { source: 'reminder', ...meta });
      return acceptEmitted(actor, node, 'prompt.reminded', () => send({ type: 'input.remind', entry }), (event) => event.entry === entry);
    },
    cancel: (id) =>
      acceptEmitted(actor, node, 'prompt.cancelled', () => send({ type: 'input.cancel', id }), (event) => event.id === id),
    steer: (ids) => {
      const requested = typeof ids === 'string' ? [ids] : [...ids];
      return acceptEmitted(
        actor,
        node,
        'prompt.steered',
        () => send({ type: 'input.steer', id: ids }),
        (event) => event.ids.length === requested.length && event.ids.every((id, index) => id === requested[index]),
      );
    },
    abort: (reason) => acceptEmitted(actor, node, 'agent.aborted', () => send({ type: 'input.abort', reason })),
    abortTool: (toolCallId, reason) => {
      if (node.signal.aborted) return;
      const status = actor.getSnapshot().status;
      if (status === 'done' || status === 'stopped') return;
      send({ type: 'input.abort_tool', toolCallId, reason });
    },
    detachTool: (toolCallId) => {
      if (node.signal.aborted) return;
      const status = actor.getSnapshot().status;
      if (status === 'done' || status === 'stopped') return;
      send({ type: 'input.detach_tool', toolCallId });
    },
    pause: () => acceptEmitted(actor, node, 'agent.paused', () => send({ type: 'input.pause' })),
    continue: () => acceptEmitted(actor, node, 'agent.continued', () => send({ type: 'input.continue' })),
    contextReset: (input) => {
      if (input.messages === undefined) {
        if (node.signal.aborted) return undefined;
        const status = actor.getSnapshot().status;
        if (status === 'done' || status === 'stopped') return undefined;
        send({ type: 'input.context_reset', error: input.error });
        return undefined;
      }
      const messages = input.messages;
      return acceptEmitted(
        actor,
        node,
        'context.reset',
        () =>
          send({
            type: 'input.context_reset',
            messages,
            reason: input.reason,
            instruction: input.instruction,
            stats: input.stats,
          }),
        (event) => event.messages === messages,
      );
    },
    on: onEmitted,
    wait: (type, opts) =>
      new Promise((resolve, reject) => {
        let subscription: Subscription | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = (): void => {
          subscription?.unsubscribe();
          if (timer !== undefined) clearTimeout(timer);
          opts?.signal?.removeEventListener('abort', onAbort);
        };
        subscription = onEmitted(type, (event) => {
          if (opts?.match !== undefined && !opts.match(event)) return;
          cleanup();
          resolve(event);
        });
        if (opts?.timeoutMs !== undefined) {
          timer = setTimeout(() => {
            cleanup();
            reject(new Error(`wait '${type}' timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs);
        }
        const onAbort = (): void => {
          cleanup();
          reject(abortReason(opts?.signal));
        };
        if (opts?.signal?.aborted) {
          onAbort();
          return;
        }
        opts?.signal?.addEventListener('abort', onAbort, { once: true });
      }),
    run: runTurn as AgentCommands['run'],
    retry: retryTurn as AgentCommands['retry'],
  };
  provide(EventContext, { sessionId: props.sessionId, agentId: props.agentId });
  provide(AgentStoreRef, props.store);
  provide(AgentPort, ports);
  provide(WaitForTasksRef, createWaitForTasks(actor));
  provide(AgentUnitRef, commands);
  provide(AgentNodeRef, node);
  props.provide?.(node);
  const slots = useFeatureSlot('agent', props.features ?? []);
  let started = false;
  useReady(slots.ready().then(async () => {
    if (node.signal.aborted) return;
    const persisted = props.store.getState().spec;
    const spec = ports.freeze(persisted, props.systemPrompt);
    if (persisted === undefined) {
      await props.store.dispatch({ type: 'spec.frozen', spec }).catch(() => {});
    }
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
  const nodeOn = bindHandleOn(handle.node);
  const onFeature = nodeOn.on as unknown as (
    feature: FeatureSpec,
    type: string,
    handler: EventHandler,
    opts?: ListenOpts,
  ) => Unsubscribe;
  const waitFeature = nodeOn.wait as unknown as (
    feature: FeatureSpec,
    type: string,
    opts?: WaitOpts,
  ) => Promise<RuntimeEvent>;
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    resolve: ((token: CertainToken<unknown> | FacadeToken<unknown>) =>
      token.kind === 'facade' ? handle.resolve(token) : handle.resolve(token)) as UnitHandle['resolve'],
    update: (props) => handle.update(props),
    ready: () => handle.ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    get agentId() { return commands().agentId; },
    get snapshot() { return commands().snapshot; },
    get config() { return commands().config; },
    setRequester: (requester) => commands().setRequester(requester),
    setConfig: (config) => commands().setConfig(config),
    setCredentialProvider: (provider) => commands().setCredentialProvider(provider),
    submit: (message, meta) => commands().submit(message, meta),
    notify: (message) => commands().notify(message),
    remind: (message, meta) => commands().remind(message, meta),
    cancel: (id) => commands().cancel(id),
    steer: (ids) => commands().steer(ids),
    abort: (reason) => commands().abort(reason),
    abortTool: (toolCallId, reason) => commands().abortTool(toolCallId, reason),
    detachTool: (toolCallId) => commands().detachTool(toolCallId),
    pause: () => commands().pause(),
    continue: () => commands().continue(),
    contextReset: (input) => commands().contextReset(input),
    on: ((
      featureOrType: FeatureSpec | string,
      typeOrHandler?: string | ((event: AgentEmitted) => void),
      handlerOrOpts?: EventHandler | ListenOpts,
      opts?: ListenOpts,
    ) => {
      if (typeof featureOrType === 'string') {
        return commands().on(
          featureOrType as AgentEmitted['type'],
          typeOrHandler as (event: AgentEmitted) => void,
        );
      }
      return onFeature(featureOrType, typeOrHandler as string, handlerOrOpts as EventHandler, opts);
    }) as AgentHandle['on'],
    wait: ((
      featureOrType: FeatureSpec | string,
      typeOrOpts?: string | AgentWaitOpts<AgentEmitted['type']>,
      opts?: WaitOpts,
    ) => {
      if (typeof featureOrType === 'string') {
        return commands().wait(
          featureOrType as AgentEmitted['type'],
          typeOrOpts as AgentWaitOpts<AgentEmitted['type']>,
        );
      }
      return waitFeature(featureOrType, typeOrOpts as string, opts);
    }) as AgentHandle['wait'],
    run: ((message: UserMessage, opts?: AgentRunOpts) =>
      commands().run(message, opts)) as AgentCommands['run'],
    retry: ((opts?: AgentRunOpts) => commands().retry(opts)) as AgentCommands['retry'],
  };
}

export function mountAgent(props: AgentUnitProps, opts?: MountRootOptions): AgentHandle {
  return agentHandle(mountRoot(AgentUnit, props, opts).handle);
}
