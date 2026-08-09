import { SyncDescriptor } from '#/_base/di/descriptors';
import { toDisposable } from '#/_base/di/lifecycle';
import type { ServiceRegistration, TestInstantiationService } from '#/_base/di/test';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { IAgentScopeContext, type IAgentScopeContext as AgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IEventBus } from '#/app/event/eventBus';
import { createHooks } from '#/hooks';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import {
  IWireService,
  type IWireService as AgentWire,
  type WireHooks,
} from '#/wire/wire';
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

export function testWireScope(scope: string, journal: string): string {
  return `${scope}/${journal}`;
}

export function stubAgentScopeContext(scope: string): AgentScopeContext {
  return {
    _serviceBrand: undefined,
    agentId: 'test-agent',
    scope: (subKey?: string): string =>
      subKey === undefined || subKey === '' ? scope : `${scope}/${subKey}`,
  };
}

export function registerTestAgentWire(
  ix: TestInstantiationService,
  scope: string,
  dependencies: TestAgentWireDependencies = {},
): AgentWire {
  ix.stub(IAgentScopeContext, stubAgentScopeContext(scope));
  ix.set(IAppendLogStore, dependencies.log ?? noopLog);
  ix.set(IAgentBlobService, dependencies.blob ?? noopBlob);
  ix.set(IEventBus, dependencies.eventBus ?? noopEventBus);
  ix.set(IWireService, new SyncDescriptor(WireService));
  return ix.get(IWireService);
}

export function registerTestAgentWireServices(
  registration: ServiceRegistration,
  scope = 'wire/test-agent',
): void {
  registration.defineInstance(IAgentScopeContext, stubAgentScopeContext(scope));
  registration.defineInstance(IAppendLogStore, noopLog);
  registration.defineInstance(IAgentBlobService, noopBlob);
  registration.defineInstance(IEventBus, noopEventBus);
  registration.define(IWireService, WireService);
}

export async function restoreTestAgentWire(
  wire: AgentWire,
  log: IAppendLogStore,
  scope: string,
  records: readonly WireRecord[],
): Promise<void> {
  await log.rewrite(scope, AGENT_WIRE_RECORD_KEY, records);
  await wire.restore();
}

export function stubAgentWire(
  flush: () => Promise<void> = async () => {},
): AgentWire {
  return {
    _serviceBrand: undefined,
    hooks: createHooks<WireHooks, keyof WireHooks>(['onDidRestore']),
    dispatch: () => {},
    seal: async () => {},
    restore: async () => {},
    flush,
    getModel: (model) => model.initial() as never,
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
  };
}
