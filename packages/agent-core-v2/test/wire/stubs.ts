import { toDisposable } from '#/_base/di/lifecycle';
import type { ServiceRegistration, TestInstantiationService } from '#/_base/di/test';
import type { CollectionChange, CollectionView } from '#/_base/di/collection';
import { Event } from '#/_base/event';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { AgentRuntimeSet } from '#/actor/agentRuntimeSet';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { makeAgentScopeContext, type IAgentScopeContext as AgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { EventStateContribution, type EventStateContributionRecord } from '#/state/stateContribution';
import { AgentTodo, todoAgentRuntimeProvider } from '#/actor/todo/todoAgentRuntime';
import { AgentContextMemory, contextMemoryAgentRuntimeProvider } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { AgentCron, cronAgentRuntimeProvider } from '#/actor/cron/cronAgentRuntime';
import { AgentGoal, goalAgentRuntimeProvider } from '#/actor/goal/goalAgentRuntime';
import { AgentInteraction, interactionAgentRuntimeProvider } from '#/actor/interaction/interactionAgentRuntime';
import { AgentUsage, usageAgentRuntimeProvider } from '#/actor/usage/usageAgentRuntime';
import {
  AgentFullCompaction,
  fullCompactionAgentRuntimeProvider,
} from '#/actor/fullCompaction/fullCompactionAgentRuntime';
import {
  AgentPermissionRules,
  permissionRulesAgentRuntimeProvider,
} from '#/actor/permissionRules/permissionRulesAgentRuntime';
import {
  IWireService,
  type IWireService as AgentWire,
} from '#/wire/wire';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { AgentHost } from '#/agent/host/agentHost';
import { WireService } from '#/wire/wireService';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

interface TestAgentWireDependencies {
  readonly log?: IAppendLogStore;
  readonly blob?: IAgentBlobService;
  readonly eventBus?: IEventBus;
}

const noopLog: IAppendLogStore = {
  _serviceBrand: undefined,
  append: () => {},
  read: async function* () {},
  rewrite: async () => {},
  flush: async () => {},
  close: async () => {},
  acquire: () => toDisposable(() => {}),
  drainRetirements: () => Promise.resolve(),
};

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

const noopEventBus: IEventBus = {
  _serviceBrand: undefined,
  publish: () => {},
  subscribe: () => toDisposable(() => {}),
};

const emptyEventStateView: CollectionView<EventStateContributionRecord> = {
  items: [],
  records: [],
  onDidChange: Event.None as Event<CollectionChange<EventStateContributionRecord>>,
};

export function testWireScope(scope: string, journal: string): string {
  return `${scope}/${journal}`;
}

export function stubAgentScopeContext(scope: string): AgentScopeContext {
  return makeAgentScopeContext({ agentId: 'test-agent', agentScope: scope, generation: 0 });
}

export function registerTestAgentWire(
  ix: TestInstantiationService,
  scope: string | AgentScopeContext,
  dependencies: TestAgentWireDependencies = {},
): AgentWire {
  const agentScope = typeof scope === 'string' ? stubAgentScopeContext(scope) : scope;
  const log = dependencies.log ?? noopLog;
  const blob = dependencies.blob ?? noopBlob;
  const eventBus = dependencies.eventBus ?? noopEventBus;
  ix.set(IAppendLogStore, log);
  ix.set(IAgentBlobService, blob);
  ix.set(IEventBus, eventBus);
  const wire = new WireService(agentScope, log, blob);
  ix.set(IWireService, wire);
  if (typeof (eventBus as Partial<ISessionEventBus>).activateAgent === 'function') {
    (eventBus as ISessionEventBus).activateAgent(agentScope.agentContext);
  }
  return wire;
}

export function registerTestAgentWireServices(
  registration: ServiceRegistration,
  scope = 'wire/test-agent',
  agentScope: AgentScopeContext = stubAgentScopeContext(scope),
): void {
  const wireScope = stubAgentScopeContext(scope);
  class TestAgentWireService extends WireService {
    constructor(
      @IAppendLogStore log: IAppendLogStore,
      @IAgentBlobService blob: IAgentBlobService,
    ) {
      super(wireScope, log, blob);
    }
  }
  class TestAgentEventDispatcherService extends EventDispatcherService {
    constructor(
      @IWireService wire: IWireService,
      @IEventBus eventBus: IEventBus,
      @IAgentBlobService blob: IAgentBlobService,
      @IAgentStateService agentState: IAgentStateService,
      @EventStateContribution view: CollectionView<EventStateContributionRecord>,
    ) {
      super(wire, eventBus, agentScope, blob, agentState, view);
    }
  }
  registration.defineInstance(IAppendLogStore, noopLog);
  registration.defineInstance(IAgentBlobService, noopBlob);
  registration.defineInstance(IEventBus, noopEventBus);
  registration.defineInstance(IAgentStateService, new AgentStateService());
  registration.define(IWireService, TestAgentWireService);
  registration.define(IEventDispatcher, TestAgentEventDispatcherService);
}

export function registerTestEventDispatcher(
  ix: TestInstantiationService,
  scopeContext: AgentScopeContext | undefined,
): IEventDispatcher {
  const createdState = new AgentStateService();
  const previous = ix.set(IAgentStateService, createdState);
  if (previous !== undefined) {
    ix.set(IAgentStateService, previous as IAgentStateService);
  }
  const dispatcher = new EventDispatcherService(
    ix.get(IWireService),
    ix.get(IEventBus),
    scopeContext,
    ix.get(IAgentBlobService),
    ix.get(IAgentStateService),
    emptyEventStateView,
  );
  ix.set(IEventDispatcher, dispatcher);
  return dispatcher;
}

export function attachContextMemoryRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentContextMemory,
    provider: contextMemoryAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachTodoRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentTodo,
    provider: todoAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachCronRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentCron,
    provider: cronAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachGoalRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentGoal,
    provider: goalAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachInteractionRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentInteraction,
    provider: interactionAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachFullCompactionRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentFullCompaction,
    provider: fullCompactionAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachUsageRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentUsage,
    provider: usageAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export function attachPermissionRulesRuntime(
  ix: TestInstantiationService,
  dispatcher: IEventDispatcher,
  agent: AgentContext,
): AgentRuntimeSet {
  const runtimes = new AgentRuntimeSet(agent, { get: (id) => ix.get(id) }, () => dispatcher);
  runtimes.apply({
    definition: AgentPermissionRules,
    provider: permissionRulesAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  runtimes.attachDurable(dispatcher);
  return runtimes;
}

export async function restoreTestEventDispatcher(
  dispatcher: IEventDispatcher,
  log: IAppendLogStore,
  scope: string,
  records: readonly WireRecord[],
): Promise<void> {
  await log.rewrite(scope, AGENT_WIRE_RECORD_KEY, records);
  await dispatcher.restore();
}

export function stubAgentWire(
  flush: () => Promise<void> = async () => {},
): AgentWire {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: () => {},
    readJournal: async function* () {},
    flush,
  };
}

export function stubWireJournal(journal: WireRecord[]): AgentWire {
  return {
    ...stubAgentWire(),
    appendRecord: (record) => {
      journal.push(record);
    },
    readJournal: async function* () {
      for (const record of journal) yield record;
    },
  };
}

export function recordingWireLog(
  records: WireRecord[],
  onAppend?: (record: WireRecord) => void,
): IAppendLogStore {
  return {
    _serviceBrand: undefined,
    append: (_scope, _key, record) => {
      records.push(record as WireRecord);
      onAppend?.(record as WireRecord);
    },
    read: async function* <R>() {
      for (const record of records) yield record as R;
    },
    rewrite: async (_scope, _key, next) => {
      records.splice(0, records.length, ...(next as readonly WireRecord[]));
    },
    flush: async () => {},
    close: async () => {},
    acquire: () => toDisposable(() => {}),
    drainRetirements: () => Promise.resolve(),
  };
}

export function registerTestAgentHost(
  ix: TestInstantiationService,
  scopeContext: AgentScopeContext,
): AgentHost {
  return ix.get(IAgentHostService).create({
    scopeContext,
    binding: { workspaceId: 'test-workspace', runtimeId: 'local' },
  });
}

export function stubAgentHost(
  get: <T>(id: never) => T,
  scopeContext: AgentScopeContext,
): AgentHost {
  return {
    scopeContext,
    telemetry: get(ITelemetryService as never),
    eventBus: get(IEventBus as never),
    blob: get(IAgentBlobService as never),
    wire: get(IWireService as never),
    state: get(IAgentStateService as never),
    dispatcher: get(IEventDispatcher as never),
    telemetryContext: undefined as never,
    runtimeBinding: undefined as never,
    agentRuntime: undefined as never,
    contextProjector: undefined as never,
    dispose: async () => {},
  };
}

export function stubAgentHostService(
  get: <T>(id: never) => T,
  scopeContext: AgentScopeContext,
): IAgentHostService {
  let host: AgentHost | undefined;
  const of = (): AgentHost => (host ??= stubAgentHost(get, scopeContext));
  return {
    _serviceBrand: undefined,
    create: () => {
      throw new Error('stubAgentHostService.create is not implemented');
    },
    of,
    tryOf: of,
    release: () => {},
  };
}
