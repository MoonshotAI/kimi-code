import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import {
  type AgentRuntimeDefinition,
  type RuntimeOf,
} from '#/agent/runtime/agentRuntime';
import { AgentRuntimeSet } from '#/agent/runtime/agentRuntimeSet';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { EventBusService } from '#/app/event/eventBusService';
import { IEventBus } from '#/app/event/eventBus';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  AgentInteraction,
  interactionAgentRuntimeProvider,
  type InteractionRuntime,
} from '#/features/interaction/interactionAgentRuntime';
import {
  InteractionRequestEvent,
  InteractionResolvedEvent,
} from '#/features/interaction/interactionOps';
import {
  enqueueSessionInteraction,
  isSessionInteractionRecentlyResolved,
  listSessionPendingInteractions,
  respondSessionInteraction,
} from '#/features/interaction/sessionInteractions';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  attachInteractionRuntime,
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

interface RecordedEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface RuntimeAgent {
  readonly context: AgentContext;
  readonly runtimes: AgentRuntimeSet;
  readonly runtime: InteractionRuntime;
  readonly dispatched: RecordedEvent[];
  readonly disposables: DisposableStore;
}

function makeRuntimeAgent(agentId: string): RuntimeAgent {
  const disposables = new DisposableStore();
  const ix = disposables.add(new TestInstantiationService());
  const scope = makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}`, generation: 1 });
  const context = scope.agentContext;
  const eventBus = disposables.add(new EventBusService());
  eventBus.activateAgent(context);
  const dispatched: RecordedEvent[] = [];
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: (event: RecordedEvent) => {
      dispatched.push(event);
      return Promise.resolve();
    },
  } as unknown as IEventDispatcher;
  ix.stub(IAgentScopeContext, scope);
  ix.stub(IEventBus, eventBus);
  ix.stub(IEventDispatcher, dispatcher);
  const runtimes = new AgentRuntimeSet(context, { get: (id) => ix.get(id) });
  runtimes.apply({
    definition: AgentInteraction,
    provider: interactionAgentRuntimeProvider,
    generation: 1,
    active: true,
  });
  const runtime = runtimes.resolve(AgentInteraction);
  return { context, runtimes, runtime, dispatched, disposables };
}

function payloadOf(event: RecordedEvent): Record<string, unknown> {
  const { type: _type, time: _time, ...payload } = event;
  return payload;
}

function stubManagerFor(agents: Map<string, RuntimeAgent>): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: Event.None,
    get: (agentId: string) => agents.get(agentId)?.context,
    list: () => [...agents.values()].map((agent) => agent.context),
    resolve: <Definition extends AgentRuntimeDefinition<any, any>>(
      context: AgentContext,
      definition: Definition,
    ): RuntimeOf<Definition> => agents.get(context.agentId)!.runtimes.resolve(definition),
  } as unknown as IAgentLifecycleService;
}

describe('interaction runtime', () => {
  let agent: RuntimeAgent;

  beforeEach(() => {
    agent = makeRuntimeAgent('main');
  });
  afterEach(() => agent.disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = agent.runtime;
    const pending = svc.request<{ n: number }, string>({
      kind: 'question',
      payload: { n: 1 },
    });
    expect(svc.listPending()).toHaveLength(1);

    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });

  it('uses the caller-provided id for correlation', async () => {
    const svc = agent.runtime;
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = agent.runtime;
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = agent.runtime;
    let count = 0;
    agent.disposables.add(svc.onDidChangePending(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = agent.runtime;
    const snapshots: (readonly string[])[] = [];
    agent.disposables.add(svc.onDidChangePending((e) => snapshots.push(e.pending)));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = agent.runtime;
    expect(svc.respond('nope', 'x')).toBe(false);
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = agent.runtime;
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = agent.runtime;
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^main:interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('resolves pending requests silently when the runtime closes', async () => {
    const seen: { id: string; response: unknown }[] = [];
    let changes = 0;
    agent.disposables.add(agent.runtime.onDidResolve((resolution) => seen.push(resolution)));
    agent.disposables.add(agent.runtime.onDidChangePending(() => changes++));
    const pending = agent.runtime.request({ kind: 'question', payload: {} });

    await agent.runtimes.close();

    await expect(pending).resolves.toEqual({ cancelled: true, reason: 'agent_closed' });
    expect(seen).toEqual([]);
    expect(changes).toBe(1);
    expect(agent.dispatched.map((event) => event.type)).toEqual(['interaction.request']);
    expect(agent.runtime.listPending()).toHaveLength(0);
    expect(agent.runtime.respond('main:interaction-0', {})).toBe(false);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = agent.runtime;
    const seen: { id: string; response: unknown }[] = [];
    agent.disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = agent.runtime;
    let count = 0;
    agent.disposables.add(svc.onDidResolve(() => count++));
    svc.respond('nope', 'x');
    expect(count).toBe(0);
  });

  it('cancelPendingForTurn clears pending interactions whose turn has ended', () => {
    const svc = agent.runtime;

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('cancelPendingForTurn resolves cancelled interactions through onDidResolve', () => {
    const svc = agent.runtime;
    const seen: { id: string; response: unknown }[] = [];
    agent.disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('cancelPendingForTurn is a no-op when no interaction matches', () => {
    const svc = agent.runtime;
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 1 } });
    expect(() => svc.cancelPendingForTurn(99)).not.toThrow();
    expect(svc.listPending()).toHaveLength(1);
  });

  it('journals interaction.request to the owning agent dispatcher', () => {
    agent.runtime.enqueue({
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
      origin: { agentId: 'main', turnId: 2 },
    });

    expect(agent.dispatched.map((event) => ({ type: event.type, payload: payloadOf(event) }))).toEqual([
      {
        type: 'interaction.request',
        payload: {
          id: 'i1',
          kind: 'approval',
          toolCallId: 'call-1',
          agentId: 'main',
          request: { toolCallId: 'call-1', toolName: 'Bash' },
        },
      },
    ]);
  });

  it('respond journals interaction.resolved to the same dispatcher', async () => {
    const pending = agent.runtime.request({ id: 'i1', kind: 'approval', payload: {} });
    agent.runtime.respond('i1', { decision: 'approved' });
    await pending;

    expect(agent.dispatched.map((event) => event.type)).toEqual([
      'interaction.request',
      'interaction.resolved',
    ]);
    expect(payloadOf(agent.dispatched[1]!)).toEqual({
      agentId: 'main',
      id: 'i1',
      response: { decision: 'approved' },
    });
  });

  it('cancelPendingForTurn journals the cancellation as interaction.resolved', () => {
    agent.runtime.enqueue({ id: 'i1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    agent.runtime.cancelPendingForTurn(5);

    const last = agent.dispatched.at(-1);
    expect(last?.type).toBe('interaction.resolved');
    expect(last === undefined ? undefined : payloadOf(last)).toEqual({
      agentId: 'main',
      id: 'i1',
      response: { cancelled: true, reason: 'turn_ended' },
    });
  });
});

describe('session interaction helpers', () => {
  let agents: Map<string, RuntimeAgent>;
  let manager: IAgentLifecycleService;

  beforeEach(() => {
    agents = new Map();
    manager = stubManagerFor(agents);
  });
  afterEach(() => {
    for (const agent of agents.values()) agent.disposables.dispose();
  });

  it('routes requests to the origin agent runtime', () => {
    const main = makeRuntimeAgent('main');
    const sub = makeRuntimeAgent('agent-1');
    agents.set('main', main);
    agents.set('agent-1', sub);

    enqueueSessionInteraction(manager, {
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
      origin: { agentId: 'agent-1', turnId: 2 },
    });

    expect(sub.runtime.listPending()).toHaveLength(1);
    expect(main.runtime.listPending()).toHaveLength(0);
    expect(sub.dispatched.map((event) => event.type)).toEqual(['interaction.request']);
    expect(main.dispatched).toHaveLength(0);
  });

  it('routes to the main agent when the origin has no agentId', () => {
    const main = makeRuntimeAgent('main');
    agents.set('main', main);

    enqueueSessionInteraction(manager, { id: 'i1', kind: 'question', payload: { question: '?' } });

    expect(main.runtime.listPending()).toHaveLength(1);
    expect(main.dispatched.map((event) => event.type)).toEqual(['interaction.request']);
  });

  it('generated ids remain unique across agents', () => {
    const main = makeRuntimeAgent('main');
    const sub = makeRuntimeAgent('agent-1');
    agents.set('main', main);
    agents.set('agent-1', sub);

    const mainInteraction = enqueueSessionInteraction(manager, { kind: 'approval', payload: {} });
    const subInteraction = enqueueSessionInteraction(manager, {
      kind: 'question',
      payload: {},
      origin: { agentId: 'agent-1' },
    });

    expect(mainInteraction.id).not.toBe(subInteraction.id);
    expect(mainInteraction.id).toMatch(/^main:/);
    expect(subInteraction.id).toMatch(/^agent-1:/);
  });

  it('listPending aggregates across agents', () => {
    const main = makeRuntimeAgent('main');
    const sub = makeRuntimeAgent('agent-1');
    agents.set('main', main);
    agents.set('agent-1', sub);

    enqueueSessionInteraction(manager, { id: 'i1', kind: 'approval', payload: {} });
    enqueueSessionInteraction(manager, {
      id: 'i2',
      kind: 'question',
      payload: {},
      origin: { agentId: 'agent-1' },
    });

    expect(listSessionPendingInteractions(manager).map((i) => i.id).sort()).toEqual(['i1', 'i2']);
    expect(listSessionPendingInteractions(manager, 'approval').map((i) => i.id)).toEqual(['i1']);
  });

  it('respond finds the owning agent', async () => {
    const main = makeRuntimeAgent('main');
    const sub = makeRuntimeAgent('agent-1');
    agents.set('main', main);
    agents.set('agent-1', sub);

    const pending = sub.runtime.request<unknown, string>({ kind: 'question', payload: {} });
    respondSessionInteraction(manager, sub.runtime.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(listSessionPendingInteractions(manager)).toHaveLength(0);
  });

  it('respond to an unknown id is a no-op', () => {
    agents.set('main', makeRuntimeAgent('main'));
    expect(() => respondSessionInteraction(manager, 'nope', 'x')).not.toThrow();
  });

  it('isRecentlyResolved checks every agent', () => {
    const main = makeRuntimeAgent('main');
    const sub = makeRuntimeAgent('agent-1');
    agents.set('main', main);
    agents.set('agent-1', sub);

    sub.runtime.enqueue({ id: 'i1', kind: 'approval', payload: {} });
    sub.runtime.respond('i1', {});

    expect(isSessionInteractionRecentlyResolved(manager, 'i1')).toBe(true);
    expect(isSessionInteractionRecentlyResolved(manager, 'ghost')).toBe(false);
  });
});

describe('interaction ops (wire-backed)', () => {
  const SCOPE = 'wire';
  const KEY = 'interaction-test';

  let disposables: DisposableStore;
  let dispatcher: IEventDispatcher;
  let runtimes: AgentRuntimeSet;
  let log: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
    dispatcher = registerTestEventDispatcher(ix);
    runtimes = attachInteractionRuntime(ix, dispatcher);
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

  function inspectRecords(): readonly { id: string; kind: string; resolved: boolean }[] {
    const line = runtimes.inspect().find((entry) => entry.id === 'interaction');
    return (line?.state ?? []) as readonly { id: string; kind: string; resolved: boolean }[];
  }

  it('request/resolved persist to the journal and fold into the runtime by id', async () => {
    await dispatcher.dispatch(
      new InteractionRequestEvent({
        agentId: 'test-agent',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        request: { toolCallId: 'call-1' },
      }),
    );
    await dispatcher.dispatch(
      new InteractionResolvedEvent({
        agentId: 'test-agent',
        id: 'i1',
        response: { decision: 'approved' },
      }),
    );

    expect(inspectRecords()).toEqual([{ id: 'i1', kind: 'approval', resolved: true }]);

    expect(await readRecords()).toEqual([
      {
        type: 'interaction.request',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'test-agent',
        request: { toolCallId: 'call-1' },
        time: expect.any(Number),
      },
      {
        type: 'interaction.resolved',
        agentId: 'test-agent',
        id: 'i1',
        response: { decision: 'approved' },
        time: expect.any(Number),
      },
    ]);
  });

  it('resolved without a known request leaves the runtime unchanged', async () => {
    await dispatcher.dispatch(
      new InteractionResolvedEvent({ agentId: 'test-agent', id: 'ghost', response: {} }),
    );
    expect(inspectRecords()).toEqual([]);
  });

  it('replay rebuilds the interaction records from persisted records', async () => {
    const records: WireRecord[] = [
      { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: '?' } },
      { type: 'interaction.resolved', id: 'i1', response: { answer: 'a' } },
      { type: 'interaction.request', id: 'i2', kind: 'approval', toolCallId: 'call-2', request: {} },
    ] as unknown as WireRecord[];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    registerTestAgentWire(ix2, testWireScope(SCOPE, 'interaction-replay'), {
      log: log2,
    });
    const dispatcher2 = registerTestEventDispatcher(ix2);
    const runtimes2 = attachInteractionRuntime(ix2, dispatcher2);
    await restoreTestEventDispatcher(dispatcher2, log2, testWireScope(SCOPE, 'interaction-replay'), records);

    const line = runtimes2.inspect().find((entry) => entry.id === 'interaction');
    expect(line?.state).toEqual([
      { id: 'i1', kind: 'question', resolved: true },
      { id: 'i2', kind: 'approval', resolved: false },
    ]);
  });
});
