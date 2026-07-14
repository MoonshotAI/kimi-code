import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import { AgentUserToolService } from '#/agent/userTool/userToolService';
import { UserToolModel } from '#/agent/userTool/userToolOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'user-tool-test';

const toolA: UserToolRegistration = {
  name: 'Lookup',
  description: 'Look up a short test value.',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
};
const toolB: UserToolRegistration = {
  name: 'Echo',
  description: 'Echo the input.',
  parameters: { type: 'object', properties: { text: { type: 'string' } } },
};

interface ProfileStub {
  readonly active: Set<string>;
}

function createProfileStub(): IAgentProfileService & ProfileStub {
  const active = new Set<string>();
  return {
    active,
    _serviceBrand: undefined,
    getActiveToolNames: () => undefined,
    addActiveTool: (name: string) => {
      active.add(name);
    },
    removeActiveTool: (name: string) => {
      active.delete(name);
    },
  } as unknown as IAgentProfileService & ProfileStub;
}

function createInteractionStub(): ISessionInteractionService {
  return {
    _serviceBrand: undefined,
    request: () => Promise.reject(new Error('not exercised')),
    respond: () => undefined,
    onDidResolve: () => ({ dispose: () => undefined }),
    onDidChangePending: () => ({ dispose: () => undefined }),
  } as unknown as ISessionInteractionService;
}

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let wire: IWireService;
let registry: IAgentToolRegistryService;
let profile: IAgentProfileService & ProfileStub;
let svc: IAgentUserToolService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  profile = createProfileStub();
  ix.stub(IAgentProfileService, profile);
  ix.stub(ISessionInteractionService, createInteractionStub());
  ix.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
  log = ix.get(IAppendLogStore);
  wire = ix.get(IAgentWireService);
  registry = ix.get(IAgentToolRegistryService);
  svc = ix.get(IAgentUserToolService);
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IWireService): ReadonlyMap<string, UserToolRegistration> {
  return target.getModel(UserToolModel);
}

describe('AgentUserToolService (wire-backed)', () => {
  it('register persists a flat record, registers the tool live, and marks it active', async () => {
    svc.register(toolA);

    expect(registry.resolve(toolA.name)).toBeDefined();
    expect(profile.active.has(toolA.name)).toBe(true);
    expect(modelOf(wire).get(toolA.name)).toEqual(toolA);

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'tools.register_user_tool', ...toolA, time: expect.any(Number) },
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('unregister persists a flat record and removes the tool live', async () => {
    svc.register(toolA);
    svc.unregister(toolA.name);

    expect(registry.resolve(toolA.name)).toBeUndefined();
    expect(profile.active.has(toolA.name)).toBe(false);
    expect(modelOf(wire).has(toolA.name)).toBe(false);

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'tools.register_user_tool', ...toolA, time: expect.any(Number) },
      { type: 'tools.unregister_user_tool', name: toolA.name, time: expect.any(Number) },
    ]);
  });

  it('inherits currently registered parent user tools into another agent service', async () => {
    svc.register(toolA);
    svc.register(toolB);
    svc.unregister(toolB.name);

    const ixChild = disposables.add(new TestInstantiationService());
    ixChild.stub(IFileSystemStorageService, new InMemoryStorageService());
    ixChild.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ixChild.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'user-tool-child' }]),
    );
    ixChild.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const childProfile = createProfileStub();
    ixChild.stub(IAgentProfileService, childProfile);
    ixChild.stub(ISessionInteractionService, createInteractionStub());
    ixChild.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));

    const child = ixChild.get(IAgentUserToolService);
    const childWire = ixChild.get(IAgentWireService);
    const childRegistry = ixChild.get(IAgentToolRegistryService);
    child.inheritUserTools(svc);

    expect(child.list()).toEqual([toolA]);
    expect(modelOf(childWire).get(toolA.name)).toEqual(toolA);
    expect(modelOf(childWire).has(toolB.name)).toBe(false);
    expect(childRegistry.resolve(toolA.name)).toBeDefined();
    expect(childProfile.active.has(toolA.name)).toBe(true);
    expect(childProfile.active.has(toolB.name)).toBe(false);

    const childRecords: PersistedRecord[] = [];
    for await (const record of ixChild
      .get(IAppendLogStore)
      .read<PersistedRecord>(SCOPE, 'user-tool-child')) {
      childRecords.push(record);
    }
    expect(childRecords).toEqual([
      { type: 'tools.register_user_tool', ...toolA, time: expect.any(Number) },
    ]);
  });

  it('re-registering an equal tool is a no-op on the model (same reference)', () => {
    svc.register(toolA);
    const before = modelOf(wire);
    svc.register(toolA);
    expect(modelOf(wire)).toBe(before);
  });

  it('replay rebuilds the model silently and onRestored re-registers tools after replay', async () => {
    svc.register(toolA);
    svc.register(toolB);
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'user-tool-replay' }]),
    );
    ix2.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const profile2 = createProfileStub();
    ix2.stub(IAgentProfileService, profile2);
    ix2.stub(ISessionInteractionService, createInteractionStub());
    ix2.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));

    const wire2 = ix2.get(IAgentWireService);
    const registry2 = ix2.get(IAgentToolRegistryService);
    ix2.get(IAgentUserToolService);

    expect(registry2.resolve(toolA.name)).toBeUndefined();
    await wire2.replay(...records);

    expect(modelOf(wire2).get(toolA.name)).toEqual(toolA);
    expect(modelOf(wire2).get(toolB.name)).toEqual(toolB);
    expect(registry2.resolve(toolA.name)).toBeDefined();
    expect(registry2.resolve(toolB.name)).toBeDefined();
    expect(profile2.active.has(toolA.name)).toBe(true);
    expect(profile2.active.has(toolB.name)).toBe(true);

    const written: PersistedRecord[] = [];
    for await (const record of ix2
      .get(IAppendLogStore)
      .read<PersistedRecord>(SCOPE, 'user-tool-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });
});
