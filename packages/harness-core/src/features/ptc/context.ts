import type {
  AgentCommands,
  AgentFeatureStore,
  AgentRunOpts,
  AgentStoreState,
  Blobs,
  BranchRef,
  Entry,
  RecordEvent,
  SessionCommands,
} from '@moonshot-ai/agent-core';

export type PtcContextLevel = 'none' | 'readonly' | 'full';

export interface PtcAgentReadonly {
  readonly agentId: string;
  readonly snapshot: AgentCommands['snapshot'];
  readonly model: AgentCommands['model'];
  readonly endpoint: AgentCommands['endpoint'];
  on: AgentCommands['on'];
  wait: AgentCommands['wait'];
}

export interface PtcAgentStoreReadonly {
  getState(): AgentStoreState;
}

export interface PtcAgentStoreFull extends PtcAgentStoreReadonly {
  dispatch(event: RecordEvent | readonly RecordEvent[]): Promise<Entry<RecordEvent, BranchRef>>;
}

export type PtcBlobsReadonly = Pick<Blobs, 'get' | 'has'>;

export type PtcSessionReadonly = Pick<SessionCommands, 'sessionId' | 'stores' | 'list' | 'get'>;

export interface PtcContextBridge {
  readonly level: Exclude<PtcContextLevel, 'none'>;
  readonly useAgent: () => PtcAgentReadonly | AgentCommands;
  readonly useAgentStore: () => PtcAgentStoreReadonly | PtcAgentStoreFull;
  readonly useBlobs: () => PtcBlobsReadonly | Blobs;
  readonly useSession: () => PtcSessionReadonly | SessionCommands;
  drain(): void;
}

export interface PtcContextDeps {
  readonly agent: AgentCommands;
  readonly store: AgentFeatureStore;
  readonly blobs: Blobs;
  readonly session: SessionCommands;
}

export function createPtcContext(
  level: PtcContextLevel,
  deps?: PtcContextDeps,
): PtcContextBridge | undefined {
  if (level === 'none') return undefined;
  if (deps === undefined) throw new Error('ptc context requires agent/session facades');
  const full = level === 'full';
  const disposers: (() => void)[] = [];
  const on: AgentCommands['on'] = (type, handler) => {
    const subscription = deps.agent.on(type, handler);
    disposers.push(() => subscription.unsubscribe());
    return subscription;
  };
  return {
    level: full ? 'full' : 'readonly',
    useAgent: () => (full ? createFullAgent(deps.agent, on) : createReadonlyAgent(deps.agent, on)),
    useAgentStore: () =>
      full
        ? {
            getState: () => deps.store.getState(),
            dispatch: (event) => deps.store.dispatch(event),
          }
        : { getState: () => deps.store.getState() },
    useBlobs: () =>
      full ? deps.blobs : { get: (ref) => deps.blobs.get(ref), has: (ref) => deps.blobs.has(ref) },
    useSession: () =>
      full
        ? deps.session
        : {
            sessionId: deps.session.sessionId,
            stores: deps.session.stores,
            list: () => deps.session.list(),
            get: (agentId) => deps.session.get(agentId),
          },
    drain: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
  };
}

function createReadonlyAgent(agent: AgentCommands, on: AgentCommands['on']): PtcAgentReadonly {
  return {
    get agentId() {
      return agent.agentId;
    },
    get snapshot() {
      return agent.snapshot;
    },
    get model() {
      return agent.model;
    },
    get endpoint() {
      return agent.endpoint;
    },
    on,
    wait: (type, opts) => agent.wait(type, opts),
  };
}

function createFullAgent(agent: AgentCommands, on: AgentCommands['on']): AgentCommands {
  return {
    ...createReadonlyAgent(agent, on),
    run: ((message: Parameters<AgentCommands['run']>[0], opts?: AgentRunOpts) =>
      agent.run(message, opts)) as AgentCommands['run'],
    retry: ((opts?: AgentRunOpts) => agent.retry(opts)) as AgentCommands['retry'],
    setRequester: (requester) => agent.setRequester(requester),
    setModel: (model) => agent.setModel(model),
    setEndpoint: (endpoint) => agent.setEndpoint(endpoint),
    submit: (message, meta) => agent.submit(message, meta),
    notify: (message) => agent.notify(message),
    remind: (message, meta) => agent.remind(message, meta),
    cancel: (id) => agent.cancel(id),
    steer: (ids) => agent.steer(ids),
    abort: (reason) => agent.abort(reason),
    abortTool: (toolCallId, reason) => agent.abortTool(toolCallId, reason),
    detachTool: (toolCallId) => agent.detachTool(toolCallId),
    pause: () => agent.pause(),
    continue: () => agent.continue(),
    contextReset: (input) => agent.contextReset(input),
  };
}
