import { onScopeDispose } from '@vue/reactivity';

import {
  EventContext,
  createCollection,
  createToken,
  createUnit,
  provide,
  useCleanup,
  useCollection,
  useContribute,
  useInject,
  useMounted,
  watch,
  type CertainToken,
  type CollectionToken,
  type UnitRecipe,
} from '#/kernel/index';
import { currentUnit, report, type UnitNode } from '#/kernel/runtime';
import type { HookFailurePolicy, HookPoint, HookRegistration, LoopHooks, LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { isLoopRecord } from '@moonshot-ai/agent-core/loop/index';
import {
  isToolExecutorHost,
  type ToolDefinition,
  type ToolEndingHookEvent,
  type ToolHandler,
  type ToolHookPoint,
  type ToolHookRegistration,
  type ToolHooks,
  type ToolStartingHookEvent,
} from '@moonshot-ai/agent-core/tool/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';
import type { Event, Log } from '@moonshot-ai/agent-core/store/index';

import type { App } from './app';
import { createFeature, featureSetOf, type Feature, type FeatureEntry, type FeatureLevel, type FeatureSet } from './features';
import type { AppSession } from './session';
import { useSystemPrompt, useSystemPromptAssembly } from './system-prompt';

const AppRef: CertainToken<App> = createToken('app');
const SessionRef: CertainToken<AppSession> = createToken('session');
const AgentRef: CertainToken<Agent> = createToken('agent');
export const RootRef: CertainToken<UnitNode> = createToken('app.root');
const SessionFeatures: CollectionToken<FeatureEntry> = createCollection('session.features');
const AgentFeatures: CollectionToken<FeatureEntry> = createCollection('agent.features');

export function useApp(): App {
  return useInject(AppRef);
}

export function useSession(): AppSession {
  return useInject(SessionRef);
}

export function useAgent(): Agent {
  return useInject(AgentRef);
}

export function createHostFeature(): Feature<void> {
  return createFeature('host', {
    agent() {
      const text = useSession().agentRuntime(useAgent().id)?.hostSystemPrompt;
      if (text === undefined) return;
      useSystemPrompt({ id: 'host', text, priority: -100 });
    },
  });
}

export interface LoopHookOptions {
  readonly id?: string;
  readonly onFailure?: HookFailurePolicy;
}

function loopHook<P extends HookPoint>(point: P): (hook: LoopHooks[P], options?: LoopHookOptions) => string {
  return (hook, options) => {
    const { loop } = useAgent();
    const id = loop.hooks.add({ ...options, point, hook } as HookRegistration);
    onScopeDispose(() => {
      loop.hooks.remove(id);
    });
    return id;
  };
}

type ToolHookEvent<P extends ToolHookPoint> = P extends 'tool.ending'
  ? ToolEndingHookEvent
  : ToolStartingHookEvent;

type LoopToolHook<P extends ToolHookPoint> = (
  event: Omit<ToolHookEvent<P>, 'turnId' | 'step'> & { turnId: number; step: number },
  signal: AbortSignal,
) => ReturnType<ToolHooks[P]>;

function toolHook<P extends ToolHookPoint>(point: P): (hook: LoopToolHook<P>, options?: LoopHookOptions) => string {
  return (hook, options) => {
    const executor = useAgent().loop.executor;
    if (!isToolExecutorHost(executor)) throw new Error('agent executor has no hook registry');
    const id = executor.hooks.add({
      ...options,
      point,
      hook: (event: ToolHookEvent<P>, signal: AbortSignal) =>
        hook({ ...event, turnId: event.turnId as number, step: event.step as number }, signal),
    } as ToolHookRegistration);
    onScopeDispose(() => {
      executor.hooks.remove(id);
    });
    return id;
  };
}

export const useTurnStarting = loopHook('turn.starting');
export const useMessageAppending = loopHook('message.appending');
export const useStepStarting = loopHook('step.starting');
export const useToolBatchStarting = loopHook('tool.batch-starting');
export const useToolStarting = toolHook('tool.starting');
export const useToolPermitting = toolHook('tool.permitting');
export const useToolEnding = toolHook('tool.ending');
export const useStepStopping = loopHook('step.stopping');
export const useStepContinuing = loopHook('step.continuing');

export function useRequester(): LoopLlmRequester {
  return useAgent().loop.requester;
}

export function useToolHandler(definition: ToolDefinition): () => void;
export function useToolHandler(name: string, handler: ToolHandler): () => void;
export function useToolHandler(nameOrDefinition: string | ToolDefinition, handler?: ToolHandler): () => void {
  const executor = useAgent().loop.executor;
  if (!isToolExecutorHost(executor)) throw new Error('agent executor has no registry');
  const dispose =
    typeof nameOrDefinition === 'string'
      ? executor.register(nameOrDefinition, requiredHandler(handler))
      : executor.register(nameOrDefinition);
  onScopeDispose(dispose);
  return dispose;
}

function requiredHandler(handler: ToolHandler | undefined): ToolHandler {
  if (handler === undefined) throw new TypeError('tool handler is required');
  return handler;
}

interface Child {
  readonly key: string;
  readonly recipe: UnitRecipe<any>;
  readonly props: unknown;
  readonly attach?: boolean;
}

const children = new WeakMap<object, Child>();
let childSeq = 0;

function childOf(value: object, prefix: string, recipe: UnitRecipe<any>, props: unknown): Child {
  let child = children.get(value);
  if (child === undefined) {
    child = { key: `${prefix}#${++childSeq}`, recipe, props };
    children.set(value, child);
  }
  return child;
}

interface Slot {
  recipe: UnitRecipe<any>;
  props: unknown;
  node?: UnitNode;
  dropped?: boolean;
}

function useMirror(source: () => readonly Child[]): void {
  const node = currentUnit();
  const live = new Map<string, Slot>();
  const drop = (child: UnitNode): void => {
    node.track(child.dispose().catch((error: unknown) => report(node, error)));
  };
  const apply = (entries: readonly Child[]): void => {
    if (node.state !== 'active') return;
    const next = new Map(entries.map((entry) => [entry.key, entry]));
    for (const [key, slot] of live) {
      const entry = next.get(key);
      if (entry?.recipe === slot.recipe) {
        if (Object.is(entry.props, slot.props)) continue;
        slot.props = entry.props;
        slot.node?.update(entry.props);
        continue;
      }
      live.delete(key);
      if (slot.node === undefined) slot.dropped = true;
      else drop(slot.node);
    }
    for (const entry of entries) {
      if (live.has(entry.key)) continue;
      const slot: Slot = { recipe: entry.recipe, props: entry.props };
      live.set(entry.key, slot);
      const child = node.mount(entry.recipe, entry.props, { attach: entry.attach });
      slot.node = child;
      if (slot.dropped === true) drop(child);
      else if (!Object.is(slot.props, entry.props)) child.update(slot.props);
    }
  };
  watch(source, apply);
  useMounted(() => apply(source()));
}

function useForward(log: Log<Event>, since: number, match: (event: Event) => boolean): void {
  const node = currentUnit();
  const forwarding = log.subscribe(since, (commit) => {
    for (const event of commit.events ?? []) {
      if (match(event)) node.fire({ ...event });
    }
  });
  useCleanup(() => forwarding.then((unsubscribe) => unsubscribe()).catch(() => {}));
}

function useContributeEach<T>(collection: CollectionToken<T>, source: () => readonly T[]): void {
  const node = currentUnit();
  let withdraw: Array<() => void> = [];
  const release = (): void => {
    for (const undo of withdraw.splice(0)) undo();
  };
  watch(
    source,
    (values: readonly T[]) => {
      release();
      withdraw = values.map((value) => node.register(collection, value));
    },
    { immediate: true },
  );
  useCleanup(release);
}

function useLevel(
  level: FeatureLevel,
  features: FeatureSet,
  inherited: CollectionToken<FeatureEntry> | undefined,
  domain: () => readonly Child[],
): void {
  const passed = inherited === undefined ? undefined : useCollection(inherited);
  useMirror(() => {
    const byName = new Map<string, FeatureEntry>();
    for (const entry of [...(passed?.value ?? []), ...features.entries()]) byName.set(entry.feature.name, entry);
    const mounted = [...byName.values()].flatMap((entry) => {
      const recipe = entry.feature.units[level];
      return recipe === undefined
        ? []
        : [{ key: `feature:${entry.feature.name}`, recipe, props: entry.props, attach: true }];
    });
    return [...domain(), ...mounted];
  });
}

export const AgentUnit = createUnit<{ readonly agent: Agent }>('agent', ({ agent }) => {
  const node = currentUnit();
  provide(AgentRef, agent);
  useContribute(EventContext, { agentId: agent.id });
  useCleanup(() => {
    node.fire({ type: 'agent.closed' });
  });
  useForward(agent.log, agent.since, isLoopRecord);
  useLevel('agent', featureSetOf(agent), AgentFeatures, () => []);
  useSystemPromptAssembly(agent);
  node.fire({ type: 'agent.opened', source: agent.source, reopened: agent.reopened });
});

export const SessionUnit = createUnit<{ readonly session: AppSession }>('session', ({ session }) => {
  const features = featureSetOf(session);
  provide(SessionRef, session);
  useContribute(EventContext, { sessionId: session.id });
  useForward(session.log, session.since, (event) => event.type === 'agent.registered');
  useContributeEach(AgentFeatures, () => features.entries());
  useLevel('session', features, SessionFeatures, () =>
    [...session.liveAgents.values()].map((agent) => childOf(agent, `agent:${agent.id}`, AgentUnit, { agent })),
  );
});

export const AppUnit = createUnit<{ readonly app: App }>('app', ({ app }) => {
  const features = featureSetOf(app);
  provide(AppRef, app);
  provide(RootRef, currentUnit());
  useContributeEach(SessionFeatures, () => features.entries());
  useContributeEach(AgentFeatures, () => features.entries());
  useLevel('app', features, undefined, () =>
    [...app.sessions.values()].map((session) => childOf(session, `session:${session.id}`, SessionUnit, { session })),
  );
});
