import type { BlobStore } from '@moonshot-ai/agent-core/blob/index';
import type { Loop, LoopRecordState } from '@moonshot-ai/agent-core/loop/index';
import type { Agent, Session } from '@moonshot-ai/agent-core/session/index';

import type { FeatureEvent, FeatureStore } from '#/runtime/index';

export type PtcContextLevel = 'none' | 'readonly' | 'full';

export interface PtcStoreState {
  readonly dispatches: number;
}

export interface PtcAgentReadonly {
  readonly id: string;
  subscribe: Loop['subscribe'];
  wait: Loop['wait'];
}

export interface PtcAgentFull extends PtcAgentReadonly {
  readonly loop: Loop;
  flush(): Promise<void>;
}

export interface PtcStoreReadonly {
  getState(): Promise<LoopRecordState>;
}

export interface PtcStoreFull extends PtcStoreReadonly {
  dispatch(events: readonly FeatureEvent[]): Promise<void>;
}

export type PtcBlobsReadonly = Pick<BlobStore, 'get' | 'has'>;

export type PtcSessionReadonly = Pick<Session, 'id' | 'source' | 'agents' | 'roster' | 'status'>;

export interface PtcContextBridge {
  readonly level: Exclude<PtcContextLevel, 'none'>;
  readonly useAgent: () => PtcAgentReadonly | PtcAgentFull;
  readonly useAgentStore: () => PtcStoreReadonly | PtcStoreFull;
  readonly useBlobs: () => PtcBlobsReadonly | BlobStore;
  readonly useSession: () => PtcSessionReadonly | Session;
  drain(): void;
}

export interface PtcContextDeps {
  readonly agent: Agent;
  readonly session: Session;
  readonly blobs: BlobStore;
  readonly store?: FeatureStore<PtcStoreState, FeatureEvent>;
}

export function createPtcContext(
  level: PtcContextLevel,
  deps?: PtcContextDeps,
): PtcContextBridge | undefined {
  if (level === 'none') return undefined;
  if (deps === undefined) throw new Error('ptc context requires agent/session facades');
  const full = level === 'full';
  const { agent, session, blobs, store } = deps;
  const disposers: (() => void)[] = [];
  const subscribe: Loop['subscribe'] = (listener) => {
    const unsubscribe = agent.loop.subscribe(listener);
    disposers.push(unsubscribe);
    return unsubscribe;
  };
  const wait: Loop['wait'] = (type, opts) => agent.loop.wait(type, opts);
  const getState = async (): Promise<LoopRecordState> => {
    await agent.flush();
    return agent.view.getState();
  };
  return {
    level: full ? 'full' : 'readonly',
    useAgent: () =>
      full
        ? { id: agent.id, subscribe, wait, loop: agent.loop, flush: () => agent.flush() }
        : { id: agent.id, subscribe, wait },
    useAgentStore: () =>
      full && store !== undefined
        ? { getState, dispatch: (events) => store.dispatch(events) }
        : { getState },
    useBlobs: () =>
      full ? blobs : { get: (ref) => blobs.get(ref), has: (ref) => blobs.has(ref) },
    useSession: () =>
      full
        ? session
        : {
            id: session.id,
            source: session.source,
            agents: session.agents,
            roster: session.roster,
            status: () => session.status(),
          },
    drain: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}
