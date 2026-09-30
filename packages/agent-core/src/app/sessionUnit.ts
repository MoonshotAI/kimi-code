import { toValue, type MaybeRefOrGetter } from '@vue/reactivity';

import {
  createUnit,
  EventContext,
  provide,
  pushCleanup,
  type CertainToken,
  type FacadeToken,
  type NodeRef,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';
import { inject, useNode } from '#/kernel/hooks';
import { bindHandleOn, Features, type FeatureHandleOn, type FeatureSpec } from '#/feature/feature';
import { BlobsRef, MAIN_AGENT_ID, SessionStoreRef, SessionUnitRef } from '#/feature/contribution-hooks';
import { dedupFeatures, useFeatureSlot } from '#/feature/hooks';
import { SessionNodeRef } from '#/feature/tierNodes';
import type { SessionStores } from '#/stores/session';
import type { BranchRef } from '#/store/tree';
import { AgentUnit, agentHandle, type AgentHandle, type AgentUnitProps } from './agentUnit';
import {
  agentWorkOf,
  lastTurnOfMeta,
  lastTurnOutcomeOf,
  sessionStatusOf,
  type AgentWork,
  type SessionOpenSource,
  type SessionStatus,
} from './session-status';

export type CreateAgentProps = Omit<AgentUnitProps, 'sessionId' | 'store'> & {
  readonly source?: string;
};

export interface SessionUnitProps {
  readonly sessionId: string;
  readonly stores: SessionStores;
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
  readonly source?: SessionOpenSource;
}

export interface SessionCommands {
  readonly sessionId: string;
  readonly stores: SessionStores;
  list(): string[];
  get(agentId: string): AgentHandle | undefined;
  create(props: CreateAgentProps): Promise<AgentHandle>;
  fork(sourceId: string, props: CreateAgentProps): Promise<AgentHandle>;
  close(agentId: string): Promise<void>;
  status(): SessionStatus;
}

export interface SessionHandle extends UnitHandle, SessionCommands, FeatureHandleOn {
  disposeAsync(): Promise<void>;
}

export const SessionUnit = createUnit<SessionUnitProps>('session', (props) => {
  const node = useNode();
  const agents = new Map<string, AgentHandle>();
  pushCleanup(node, props.stores.session.onCommit((entry) => {
    node.fire(entry.event);
  }));
  pushCleanup(node, node.on('turn.ended', (event) => {
    const payload = event as { readonly agentId?: unknown; readonly turnId?: unknown; readonly outcome?: unknown };
    if (payload.agentId !== MAIN_AGENT_ID) return;
    if (typeof payload.turnId !== 'number') return;
    if (payload.outcome !== 'done' && payload.outcome !== 'failed' && payload.outcome !== 'aborted') return;
    void props.stores.session
      .dispatch({
        type: 'session.meta_updated',
        meta: { lastTurn: { turnId: payload.turnId, outcome: payload.outcome } },
      })
      .catch(() => {});
  }));
  const sweep = (): void => {
    for (const [agentId, agent] of agents) {
      if (agent.state === 'unmounted') {
        agents.delete(agentId);
      }
    }
  };
  const create = async (
    createProps: CreateAgentProps,
    from?: BranchRef,
    wasRegistered?: boolean,
  ): Promise<AgentHandle> => {
    await node.ready();
    sweep();
    if (agents.has(createProps.agentId)) {
      throw new Error(`agent '${createProps.agentId}' already exists`);
    }
    const { source, ...unitProps } = createProps;
    const registered = props.stores.session.getState().roster.agents[createProps.agentId];
    const reopen = wasRegistered ?? registered !== undefined;
    const pool = dedupFeatures([...toValue(available), ...toValue(createProps.features ?? [])]);
    const features =
      registered?.features === undefined
        ? pool
        : registered.features.flatMap((name) => {
            const spec = pool.find((feature) => feature.featureName === name);
            if (spec === undefined) {
              node.fire({
                type: 'session.feature_missing',
                agentId: createProps.agentId,
                featureName: name,
              });
              return [];
            }
            return [spec];
          });
    const store = await props.stores.open(createProps.agentId, {
      from,
      features: features.map((feature) => feature.featureName),
      source,
    });
    if (createProps.agentId === MAIN_AGENT_ID) {
      const lastTurn = lastTurnOutcomeOf(store);
      const folded = lastTurnOfMeta(props.stores.session.getState().sessionMeta.value);
      if (folded?.turnId !== lastTurn?.turnId || folded?.outcome !== lastTurn?.outcome) {
        void props.stores.session
          .dispatch({ type: 'session.meta_updated', meta: { lastTurn: lastTurn ?? null } })
          .catch(() => {});
      }
    }
    let handle: UnitHandle | undefined;
    try {
      handle = node.mount(AgentUnit, {
        ...unitProps,
        features,
        sessionId: props.sessionId,
        store,
        branchId: props.stores.branch(createProps.agentId),
      });
      const agent = agentHandle(handle);
      agents.set(createProps.agentId, agent);
      await agent.ready();
      node.fire({
        type: 'agent.opened',
        agentId: createProps.agentId,
        source: source ?? registered?.source,
        reopened: reopen ? true : undefined,
      });
      return agent;
    } catch (error) {
      agents.delete(createProps.agentId);
      await handle?.unmount().catch(() => {});
      await props.stores.close(createProps.agentId).catch(() => {});
      throw error;
    }
  };
  const commands: SessionCommands = {
    sessionId: props.sessionId,
    stores: props.stores,
    list: () => {
      sweep();
      return [...agents.keys()];
    },
    get: (agentId) => {
      sweep();
      return agents.get(agentId);
    },
    create: (createProps) => create(createProps),
    fork: async (sourceId, forkProps) => {
      const wasRegistered =
        props.stores.session.getState().roster.agents[forkProps.agentId] !== undefined;
      await props.stores.fork(sourceId, forkProps.agentId, { source: forkProps.source });
      return create(forkProps, undefined, wasRegistered);
    },
    close: async (agentId) => {
      const agent = agents.get(agentId);
      agents.delete(agentId);
      try {
        await agent?.unmount();
      } finally {
        await props.stores.close(agentId);
      }
      if (agent !== undefined) node.fire({ type: 'agent.closed', agentId });
    },
    status: () => {
      const works: Array<readonly [string, AgentWork]> = [];
      for (const [agentId, agent] of agents) {
        works.push([agentId, agentWorkOf(agent.snapshot.value)]);
      }
      return sessionStatusOf(
        works,
        lastTurnOfMeta(props.stores.session.getState().sessionMeta.value),
        props.source ?? 'startup',
      );
    },
  };
  provide(EventContext, { sessionId: props.sessionId });
  provide(SessionUnitRef, commands);
  provide(SessionNodeRef, node);
  provide(SessionStoreRef, props.stores.session);
  provide(BlobsRef, props.stores.blobs);
  props.provide?.(node);
  useFeatureSlot('session', props.features ?? []);
  const available = inject(Features);
  return commands;
});

export function sessionHandle(handle: UnitHandle): SessionHandle {
  const commands = (): SessionCommands => (handle.node as UnitNode).setupResult as SessionCommands;
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
    ...bindHandleOn(handle.node),
    get sessionId() { return commands().sessionId; },
    get stores() { return commands().stores; },
    list: () => commands().list(),
    get: (agentId) => commands().get(agentId),
    create: (props) => commands().create(props),
    fork: (sourceId, props) => commands().fork(sourceId, props),
    close: (agentId) => commands().close(agentId),
    status: () => commands().status(),
  };
}
