import type { MaybeRefOrGetter } from '@vue/reactivity';

import {
  createUnit,
  EventContext,
  provide,
  useNode,
  type NodeRef,
  type UnitHandle,
  type UnitNode,
} from '#/kernel/index';
import type { FeatureSpec } from '#/feature/feature';
import { BlobsRef, SessionStoreRef, SessionUnitRef } from '#/feature/contribution-hooks';
import { useFeatureSlot } from '#/feature/hooks';
import type { SessionStores } from '#/stores/session';
import type { BranchRef } from '#/store/tree';
import type { LlmRequester } from '#/llm/requester/requester';

import { AgentUnit, agentHandle, type AgentHandle, type AgentUnitProps } from './agentUnit';

export type CreateAgentProps = Omit<AgentUnitProps, 'sessionId' | 'store' | 'requester'>;

export interface SessionUnitProps {
  readonly sessionId: string;
  readonly stores: SessionStores;
  readonly requester: LlmRequester;
  readonly features?: MaybeRefOrGetter<readonly FeatureSpec[]>;
  readonly provide?: (node: NodeRef) => void;
}

export interface SessionCommands {
  readonly sessionId: string;
  readonly stores: SessionStores;
  list(): string[];
  get(agentId: string): AgentHandle | undefined;
  create(props: CreateAgentProps): Promise<AgentHandle>;
  fork(sourceId: string, props: CreateAgentProps): Promise<AgentHandle>;
  close(agentId: string): Promise<void>;
}

export interface SessionHandle extends UnitHandle, SessionCommands {
  disposeAsync(): Promise<void>;
}

export const SessionUnit = createUnit<SessionUnitProps>('session', (props) => {
  const node = useNode();
  const agents = new Map<string, AgentHandle>();
  const sweep = (): void => {
    for (const [agentId, agent] of agents) {
      if (agent.state === 'unmounted') {
        agents.delete(agentId);
      }
    }
  };
  const create = async (createProps: CreateAgentProps, from?: BranchRef): Promise<AgentHandle> => {
    await node.ready();
    sweep();
    if (agents.has(createProps.agentId)) {
      throw new Error(`agent '${createProps.agentId}' already exists`);
    }
    const store = await props.stores.open(createProps.agentId, { from });
    let handle: UnitHandle | undefined;
    try {
      handle = node.mount(AgentUnit, {
        ...createProps,
        sessionId: props.sessionId,
        store,
        branchId: props.stores.branch(createProps.agentId),
        requester: props.requester,
      });
      const agent = agentHandle(handle);
      agents.set(createProps.agentId, agent);
      await agent.ready();
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
      await props.stores.fork(sourceId, forkProps.agentId);
      return create(forkProps);
    },
    close: async (agentId) => {
      const agent = agents.get(agentId);
      agents.delete(agentId);
      try {
        await agent?.unmount();
      } finally {
        await props.stores.close(agentId);
      }
    },
  };
  provide(EventContext, { sessionId: props.sessionId });
  provide(SessionUnitRef, commands);
  provide(SessionStoreRef, props.stores.session);
  provide(BlobsRef, props.stores.blobs);
  props.provide?.(node);
  useFeatureSlot('session', props.features);
  return commands;
});

export function sessionHandle(handle: UnitHandle): SessionHandle {
  const commands = (): SessionCommands => (handle.node as UnitNode).setupResult as SessionCommands;
  return {
    get name() { return handle.name; },
    get state() { return handle.state; },
    node: handle.node,
    update: (props) => handle.update(props),
    ready: () => handle.ready(),
    unmount: () => handle.unmount(),
    disposeAsync: () => handle.unmount(),
    get sessionId() { return commands().sessionId; },
    get stores() { return commands().stores; },
    list: () => commands().list(),
    get: (agentId) => commands().get(agentId),
    create: (props) => commands().create(props),
    fork: (sourceId, props) => commands().fork(sourceId, props),
    close: (agentId) => commands().close(agentId),
  };
}
