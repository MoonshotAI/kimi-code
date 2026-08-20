import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import { AgentUserToolService } from '#/agent/userTool/userToolService';
import { userToolKey } from '#/agent/userTool/userToolOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

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
const deferredTool: UserToolRegistration = {
  name: 'DashboardCreate',
  description: 'Create a dashboard.',
  parameters: { type: 'object', properties: { title: { type: 'string' } } },
  disclosure: 'deferred',
};

interface ProfileStub {
  readonly active: Set<string>;
}

function createProfileStub(activeToolNames?: readonly string[]): IAgentProfileService & ProfileStub {
  const active = new Set<string>();
  return {
    active,
    _serviceBrand: undefined,
    getActiveToolNames: () => activeToolNames,
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
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;
let registry: IAgentToolRegistryService;
let profile: IAgentProfileService & ProfileStub;
let svc: IAgentUserToolService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentStateService, new AgentStateService());
  ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
  profile = createProfileStub();
  ix.stub(IAgentProfileService, profile);
  ix.stub(ISessionInteractionService, createInteractionStub());
  ix.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
  log = ix.get(IAppendLogStore);
  registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  dispatcher = registerTestEventDispatcher(ix);
  agentState = ix.get(IAgentStateService);
  registry = ix.get(IAgentToolRegistryService);
  svc = ix.get(IAgentUserToolService);
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<WireRecord[]> {
  await dispatcher.flush();
  const out: WireRecord[] = [];
  for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
    out.push(record);
  }
  return out;
}

function modelOf(target: IAgentStateService): ReadonlyMap<string, UserToolRegistration> {
  return target.get(userToolKey);
}

describe('AgentUserToolService (wire-backed)', () => {
  it('register persists a flat record, registers the tool live, and marks it active', async () => {
    svc.register(toolA);

    expect(registry.resolve(toolA.name)).toBeDefined();
    expect(profile.active.has(toolA.name)).toBe(true);
    expect(modelOf(agentState).get(toolA.name)).toEqual(toolA);

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'tools.register_user_tool',
        agentId: 'test-agent',
        ...toolA,
        time: expect.any(Number),
      },
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('preserves deferred disclosure in the wire model and runtime registry', async () => {
    svc.register(deferredTool);

    expect(modelOf(agentState).get(deferredTool.name)).toEqual(deferredTool);
    expect(registry.list().find((tool) => tool.name === deferredTool.name)?.disclosure).toBe(
      'deferred',
    );
    expect(await readRecords()).toEqual([
      {
        type: 'tools.register_user_tool',
        agentId: 'test-agent',
        ...deferredTool,
        time: expect.any(Number),
      },
    ]);
  });

  it('unregister persists a flat record and removes the tool live', async () => {
    svc.register(toolA);
    svc.unregister(toolA.name);

    expect(registry.resolve(toolA.name)).toBeUndefined();
    expect(profile.active.has(toolA.name)).toBe(false);
    expect(modelOf(agentState).has(toolA.name)).toBe(false);

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'tools.register_user_tool',
        agentId: 'test-agent',
        ...toolA,
        time: expect.any(Number),
      },
      {
        type: 'tools.unregister_user_tool',
        agentId: 'test-agent',
        name: toolA.name,
        time: expect.any(Number),
      },
    ]);
  });

  it('inherits currently registered parent user tools into another agent service', async () => {
    svc.register(toolA);
    svc.register(toolB);
    svc.unregister(toolB.name);

    const ixChild = disposables.add(new TestInstantiationService());
    ixChild.stub(IFileSystemStorageService, new InMemoryStorageService());
    ixChild.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ixChild.set(IAgentStateService, new AgentStateService());
    ixChild.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const childProfile = createProfileStub();
    ixChild.stub(IAgentProfileService, childProfile);
    ixChild.stub(ISessionInteractionService, createInteractionStub());
    ixChild.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));

    registerTestAgentWire(ixChild, testWireScope(SCOPE, 'user-tool-child'), {
      log: ixChild.get(IAppendLogStore),
    });
    const childDispatcher = registerTestEventDispatcher(ixChild);
    const childAgentState = ixChild.get(IAgentStateService);
    const child = ixChild.get(IAgentUserToolService);
    const childRegistry = ixChild.get(IAgentToolRegistryService);
    child.inheritUserTools(svc);

    expect(child.list()).toEqual([toolA]);
    expect(modelOf(childAgentState).get(toolA.name)).toEqual(toolA);
    expect(modelOf(childAgentState).has(toolB.name)).toBe(false);
    expect(childRegistry.resolve(toolA.name)).toBeDefined();
    expect(childProfile.active.has(toolA.name)).toBe(true);
    expect(childProfile.active.has(toolB.name)).toBe(false);

    const childRecords: WireRecord[] = [];
    for await (const record of ixChild
      .get(IAppendLogStore)
      .read<WireRecord>(testWireScope(SCOPE, 'user-tool-child'), AGENT_WIRE_RECORD_KEY)) {
      childRecords.push(record);
    }
    expect(childRecords).toEqual([
      {
        type: 'tools.register_user_tool',
        agentId: 'test-agent',
        ...toolA,
        time: expect.any(Number),
      },
    ]);
  });

  it('inherits a registered tool without activating it when absent from the active tool names', () => {
    svc.register(toolA);

    const ixChild = disposables.add(new TestInstantiationService());
    ixChild.stub(IFileSystemStorageService, new InMemoryStorageService());
    ixChild.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ixChild.set(IAgentStateService, new AgentStateService());
    ixChild.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const childProfile = createProfileStub([]);
    ixChild.stub(IAgentProfileService, childProfile);
    ixChild.stub(ISessionInteractionService, createInteractionStub());
    ixChild.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
    registerTestAgentWire(ixChild, testWireScope(SCOPE, 'inactive-user-tool-child'), {
      log: ixChild.get(IAppendLogStore),
    });
    registerTestEventDispatcher(ixChild);
    const child = ixChild.get(IAgentUserToolService);
    const childRegistry = ixChild.get(IAgentToolRegistryService);

    child.inheritUserTools(svc, []);

    expect(child.list()).toEqual([toolA]);
    expect(childRegistry.resolve(toolA.name)).toBeDefined();
    expect(childProfile.active.has(toolA.name)).toBe(false);
  });

  it('re-registering an equal tool is a no-op on the model (same reference)', () => {
    svc.register(toolA);
    const before = modelOf(agentState);
    svc.register(toolA);
    expect(modelOf(agentState)).toBe(before);
  });

  it('execute parks under a minted interaction id and keeps the provider toolCallId on the payload', async () => {
    const parked: { id: string | undefined; kind: string; payload: unknown }[] = [];
    const responses: { id: string; response: unknown }[] = [];
    let settle: ((result: unknown) => void) | undefined;
    const interactionStub = {
      _serviceBrand: undefined,
      request: (req: { id?: string; kind: string; payload: unknown }) => {
        parked.push({ id: req.id, kind: req.kind, payload: req.payload });
        return new Promise((resolve) => {
          settle = resolve;
        });
      },
      respond: (id: string, response: unknown) => {
        responses.push({ id, response });
      },
      onDidResolve: () => ({ dispose: () => undefined }),
      onDidChangePending: () => ({ dispose: () => undefined }),
    } as unknown as ISessionInteractionService;

    const ixExec = disposables.add(new TestInstantiationService());
    ixExec.stub(IFileSystemStorageService, new InMemoryStorageService());
    ixExec.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ixExec.set(IAgentStateService, new AgentStateService());
    ixExec.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ixExec.stub(IAgentProfileService, createProfileStub());
    ixExec.stub(ISessionInteractionService, interactionStub);
    ixExec.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));
    registerTestAgentWire(ixExec, testWireScope(SCOPE, 'user-tool-exec'), {
      log: ixExec.get(IAppendLogStore),
    });
    registerTestEventDispatcher(ixExec);
    const execSvc = ixExec.get(IAgentUserToolService);
    const execRegistry = ixExec.get(IAgentToolRegistryService);
    execSvc.register(toolA);

    const tool = execRegistry.resolve(toolA.name);
    expect(tool).toBeDefined();
    const execution = await tool!.resolveExecution({ query: 'x' });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');

    const resultPromise = execution.execute({
      turnId: 1,
      toolCallId: 'Bash_0',
      signal: new AbortController().signal,
    });
    expect(parked).toHaveLength(1);
    expect(parked[0]!.id).toMatch(/^user_tool_/);
    expect(parked[0]!.payload).toEqual({
      turnId: 1,
      toolCallId: 'Bash_0',
      name: toolA.name,
      args: { query: 'x' },
    });
    settle!({ output: 'done', isError: false });
    await expect(resultPromise).resolves.toEqual({ output: 'done', isError: false });

    const controller = new AbortController();
    const aborted = execution.execute({
      turnId: 1,
      toolCallId: 'Bash_0',
      signal: controller.signal,
    });
    controller.abort();
    await expect(aborted).rejects.toThrow();
    expect(parked).toHaveLength(2);
    expect(parked[1]!.id).not.toBe(parked[0]!.id);
    expect(responses).toEqual([
      {
        id: parked[1]!.id,
        response: { output: `User tool "${toolA.name}" was aborted.`, isError: true },
      },
    ]);
  });

  it('treats a disclosure change as a new registration state', () => {
    svc.register(toolA);
    const before = modelOf(agentState);

    svc.register({ ...toolA, disclosure: 'deferred' });

    expect(modelOf(agentState)).not.toBe(before);
    expect(modelOf(agentState).get(toolA.name)?.disclosure).toBe('deferred');
    expect(registry.list().find((tool) => tool.name === toolA.name)?.disclosure).toBe(
      'deferred',
    );
  });

  it('replay rebuilds the model silently and onDidRestore re-registers tools after replay', async () => {
    svc.register(toolA);
    svc.register(toolB);
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(IAgentStateService, new AgentStateService());
    ix2.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    const profile2 = createProfileStub();
    ix2.stub(IAgentProfileService, profile2);
    ix2.stub(ISessionInteractionService, createInteractionStub());
    ix2.set(IAgentUserToolService, new SyncDescriptor(AgentUserToolService));

    registerTestAgentWire(ix2, testWireScope(SCOPE, 'user-tool-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    const dispatcher2 = registerTestEventDispatcher(ix2);
    const agentState2 = ix2.get(IAgentStateService);
    const registry2 = ix2.get(IAgentToolRegistryService);
    ix2.get(IAgentUserToolService);

    expect(registry2.resolve(toolA.name)).toBeUndefined();
    await restoreTestEventDispatcher(
      dispatcher2,
      ix2.get(IAppendLogStore),
      testWireScope(SCOPE, 'user-tool-replay'),
      records,
    );

    expect(modelOf(agentState2).get(toolA.name)).toEqual(toolA);
    expect(modelOf(agentState2).get(toolB.name)).toEqual(toolB);
    expect(registry2.resolve(toolA.name)).toBeDefined();
    expect(registry2.resolve(toolB.name)).toBeDefined();
    expect(profile2.active.has(toolA.name)).toBe(true);
    expect(profile2.active.has(toolB.name)).toBe(true);

    const written: WireRecord[] = [];
    for await (const record of ix2
      .get(IAppendLogStore)
      .read<WireRecord>(testWireScope(SCOPE, 'user-tool-replay'), AGENT_WIRE_RECORD_KEY)) {
      written.push(record);
    }
    expect(written[0]).toMatchObject({ type: 'metadata' });
    expect(written.slice(1)).toEqual(records);
  });
});
