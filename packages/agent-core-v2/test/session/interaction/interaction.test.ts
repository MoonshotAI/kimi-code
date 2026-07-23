import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { DisposableStore } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { TestInstantiationService } from '#/_base/di/test';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import {
  InteractionModel,
  interactionRequest,
  interactionResolved,
} from '#/session/interaction/interactionOps';
import { SessionInteractionService } from '#/session/interaction/interactionService';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

interface RecordedOp {
  readonly type: string;
  readonly payload: unknown;
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly dispatched: RecordedOp[];
}

function makeFakeAgent(agentId: string): FakeAgent {
  const dispatched: RecordedOp[] = [];
  const wire = {
    _serviceBrand: undefined,
    dispatch: (...ops: RecordedOp[]) => {
      dispatched.push(...ops);
    },
  } as unknown as IWireService;
  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IWireService) return wire as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };
  return {
    handle: { id: agentId, kind: LifecycleScope.Agent, accessor, dispose: () => {} },
    dispatched,
  };
}

describe('SessionInteractionService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let agents: Map<string, FakeAgent>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    agents = new Map();
    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      get: (id: string) => agents.get(id)?.handle,
    } as unknown as IAgentLifecycleService);
    ix.set(ISessionInteractionService, new SyncDescriptor(SessionInteractionService));
  });
  afterEach(() => disposables.dispose());

  it('request blocks until respond resolves it', async () => {
    const svc = ix.get(ISessionInteractionService);
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
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request({ id: 'tool-1', kind: 'approval', payload: {} });
    expect(svc.listPending()[0]!.id).toBe('tool-1');
    svc.respond('tool-1', { decision: 'approved' });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('listPending filters by kind', () => {
    const svc = ix.get(ISessionInteractionService);
    void svc.request({ kind: 'approval', payload: {} });
    void svc.request({ kind: 'question', payload: {} });
    expect(svc.listPending('approval')).toHaveLength(1);
    expect(svc.listPending('question')).toHaveLength(1);
    expect(svc.listPending()).toHaveLength(2);
  });

  it('onDidChangePending fires on request and on respond', async () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidChangePending(() => count++));
    const pending = svc.request({ kind: 'question', payload: {} });
    expect(count).toBe(1);
    svc.respond(svc.listPending()[0]!.id, 'x');
    await pending;
    expect(count).toBe(2);
  });

  it('onDidChangePending carries the pending ids snapshot', () => {
    const svc = ix.get(ISessionInteractionService);
    const snapshots: (readonly string[])[] = [];
    disposables.add(svc.onDidChangePending((e) => snapshots.push(e.pending)));
    void svc.request({ id: 'a', kind: 'approval', payload: {} });
    void svc.request({ id: 'b', kind: 'question', payload: {} });
    svc.respond('a', {});
    expect(snapshots).toEqual([['a'], ['a', 'b'], ['b']]);
  });

  it('respond to an unknown id is a no-op', () => {
    const svc = ix.get(ISessionInteractionService);
    expect(() => svc.respond('nope', 'x')).not.toThrow();
  });

  it('enqueue parks a request and returns it without blocking', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ id: 'e1', kind: 'approval', payload: { tool: 'bash' } });
    expect(interaction).toMatchObject({
      id: 'e1',
      kind: 'approval',
      payload: { tool: 'bash' },
    });
    expect(svc.listPending()).toHaveLength(1);
  });

  it('enqueue generates an id when none is provided', () => {
    const svc = ix.get(ISessionInteractionService);
    const interaction = svc.enqueue({ kind: 'question', payload: {} });
    expect(interaction.id).toMatch(/^interaction-/);
    expect(svc.listPending()[0]!.id).toBe(interaction.id);
  });

  it('onDidResolve fires with the id and response when responded to', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'e1', kind: 'approval', payload: {} });
    svc.respond('e1', { decision: 'approved' });

    expect(seen).toEqual([{ id: 'e1', response: { decision: 'approved' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('onDidResolve does not fire for an unknown id', () => {
    const svc = ix.get(ISessionInteractionService);
    let count = 0;
    disposables.add(svc.onDidResolve(() => count++));
    svc.respond('nope', 'x');
    expect(count).toBe(0);
  });

  it('cancelPendingForTurn clears pending interactions whose turn has ended (矛盾 c)', () => {
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 3 } });
    svc.enqueue({ id: 'a2', kind: 'approval', payload: {}, origin: { agentId: 'main', turnId: 7 } });
    expect(svc.listPending()).toHaveLength(2);

    svc.cancelPendingForTurn(3);

    expect(svc.listPending().map((i) => i.id)).toEqual(['a2']);
    expect(svc.isRecentlyResolved('a1')).toBe(true);
  });

  it('cancelPendingForTurn resolves cancelled interactions through onDidResolve', () => {
    const svc = ix.get(ISessionInteractionService);
    const seen: { id: string; response: unknown }[] = [];
    disposables.add(svc.onDidResolve((r) => seen.push(r)));

    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    expect(seen).toEqual([{ id: 'a1', response: { cancelled: true, reason: 'turn_ended' } }]);
    expect(svc.listPending()).toHaveLength(0);
  });

  it('cancelPendingForTurn is a no-op when no interaction matches', () => {
    const svc = ix.get(ISessionInteractionService);
    svc.enqueue({ id: 'a1', kind: 'approval', payload: {}, origin: { turnId: 1 } });
    expect(() => svc.cancelPendingForTurn(99)).not.toThrow();
    expect(svc.listPending()).toHaveLength(1);
  });

  it('request journals an interaction.request op to the origin agent wire', () => {
    const sub = makeFakeAgent('agent-1');
    agents.set('agent-1', sub);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({
      id: 'i1',
      kind: 'approval',
      payload: { toolCallId: 'call-1', toolName: 'Bash' },
      origin: { agentId: 'agent-1', turnId: 2 },
    });

    expect(sub.dispatched.map((op) => ({ type: op.type, payload: op.payload }))).toEqual([
      {
        type: 'interaction.request',
        payload: {
          id: 'i1',
          kind: 'approval',
          toolCallId: 'call-1',
          agentId: 'agent-1',
          request: { toolCallId: 'call-1', toolName: 'Bash' },
        },
      },
    ]);
  });

  it('journals to the main agent wire when the origin has no agentId', () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'i1', kind: 'question', payload: { question: '?' } });

    expect(main.dispatched.map((op) => ({ type: op.type, payload: op.payload }))).toEqual([
      {
        type: 'interaction.request',
        payload: {
          id: 'i1',
          kind: 'question',
          toolCallId: undefined,
          agentId: undefined,
          request: { question: '?' },
        },
      },
    ]);
  });

  it('respond journals an interaction.resolved op to the same wire', async () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    const pending = svc.request({ id: 'i1', kind: 'approval', payload: {} });
    svc.respond('i1', { decision: 'approved' });
    await pending;

    expect(main.dispatched.map((op) => op.type)).toEqual([
      'interaction.request',
      'interaction.resolved',
    ]);
    expect(main.dispatched[1]?.payload).toEqual({
      id: 'i1',
      response: { decision: 'approved' },
    });
  });

  it('cancelPendingForTurn journals the cancellation as interaction.resolved', () => {
    const main = makeFakeAgent('main');
    agents.set('main', main);
    const svc = ix.get(ISessionInteractionService);

    svc.enqueue({ id: 'i1', kind: 'approval', payload: {}, origin: { turnId: 5 } });
    svc.cancelPendingForTurn(5);

    const last = main.dispatched.at(-1);
    expect(last?.type).toBe('interaction.resolved');
    expect(last?.payload).toEqual({ id: 'i1', response: { cancelled: true, reason: 'turn_ended' } });
  });

  it('kernel semantics are unchanged when the origin agent is absent', async () => {
    const svc = ix.get(ISessionInteractionService);
    const pending = svc.request<unknown, string>({ kind: 'question', payload: {} });
    svc.respond(svc.listPending()[0]!.id, 'ok');
    await expect(pending).resolves.toBe('ok');
    expect(svc.listPending()).toHaveLength(0);
  });
});

describe('interaction ops (wire-backed)', () => {
  const SCOPE = 'wire';
  const KEY = 'interaction-test';

  let disposables: DisposableStore;
  let wire: IWireService;
  let log: IAppendLogStore;

  beforeEach(() => {
    disposables = new DisposableStore();
    const ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    log = ix.get(IAppendLogStore);
    wire = registerTestAgentWire(ix, testWireScope(SCOPE, KEY), { log });
  });
  afterEach(() => disposables.dispose());

  async function readRecords(key = KEY): Promise<WireRecord[]> {
    await wire.flush();
    const out: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(testWireScope(SCOPE, key), AGENT_WIRE_RECORD_KEY)) {
      out.push(record);
    }
    return out;
  }

  it('request/resolved persist to the journal and fold into the model by id', async () => {
    wire.dispatch(
      interactionRequest({
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'main',
        request: { toolCallId: 'call-1' },
      }),
    );
    wire.dispatch(interactionResolved({ id: 'i1', response: { decision: 'approved' } }));

    const entry = wire.getModel(InteractionModel).get('i1');
    expect(entry).toMatchObject({
      id: 'i1',
      kind: 'approval',
      toolCallId: 'call-1',
      agentId: 'main',
      resolved: true,
      response: { decision: 'approved' },
    });

    expect(await readRecords()).toEqual([
      {
        type: 'interaction.request',
        id: 'i1',
        kind: 'approval',
        toolCallId: 'call-1',
        agentId: 'main',
        request: { toolCallId: 'call-1' },
        time: expect.any(Number),
      },
      {
        type: 'interaction.resolved',
        id: 'i1',
        response: { decision: 'approved' },
        time: expect.any(Number),
      },
    ]);
  });

  it('resolved without a known request leaves the model unchanged', () => {
    const before = wire.getModel(InteractionModel);
    wire.dispatch(interactionResolved({ id: 'ghost', response: {} }));
    expect(wire.getModel(InteractionModel)).toBe(before);
  });

  it('replay rebuilds the interaction map from persisted records', async () => {
    const records: WireRecord[] = [
      { type: 'interaction.request', id: 'i1', kind: 'question', request: { q: '?' } },
      { type: 'interaction.resolved', id: 'i1', response: { answer: 'a' } },
      { type: 'interaction.request', id: 'i2', kind: 'approval', toolCallId: 'call-2', request: {} },
    ] as unknown as WireRecord[];

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const log2 = ix2.get(IAppendLogStore);
    const wire2 = registerTestAgentWire(ix2, testWireScope(SCOPE, 'interaction-replay'), {
      log: log2,
    });
    await restoreTestAgentWire(wire2, log2, testWireScope(SCOPE, 'interaction-replay'), records);

    const model = wire2.getModel(InteractionModel);
    expect(model.size).toBe(2);
    expect(model.get('i1')).toMatchObject({ resolved: true, response: { answer: 'a' } });
    expect(model.get('i2')).toMatchObject({ resolved: false, toolCallId: 'call-2' });
  });
});
