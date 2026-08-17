import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  ContextAppendMessage,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import {
  PlanModeCancel,
  PlanModeEnter,
  PlanModeExit,
  planKey,
  PlanRevision,
} from '#/features/plan/planOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'plan-test';

let disposables: DisposableStore;
let dispatcher: IEventDispatcher;
let agentState: IAgentStateService;
let log: IAppendLogStore;

interface Host {
  wire: IWireService;
  dispatcher: IEventDispatcher;
  agentState: IAgentStateService;
  log: IAppendLogStore;
  eventBus: IEventBus;
}

function buildHost(key: string): Host {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  const dispatcher = registerTestEventDispatcher(ix);
  const agentState = ix.get(IAgentStateService);
  agentState.contributeState(planKey);
  return { wire, dispatcher, agentState, log: ix.get(IAppendLogStore), eventBus: ix.get(IEventBus) };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  dispatcher = host.dispatcher;
  agentState = host.agentState;
  log = host.log;
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

describe('plan ops (wire-backed)', () => {
  it('enter/cancel/exit drive active state and persist flat records', async () => {
    expect(agentState.get(planKey).active).toBe(false);

    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    expect(agentState.get(planKey)).toEqual({
      active: true,
      id: 'p1',
    });

    await dispatcher.dispatch(new PlanModeCancel({ id: 'p1' }));
    expect(agentState.get(planKey)).toEqual({ active: false });

    await dispatcher.dispatch(new PlanModeEnter({ id: 'p2' }));
    await dispatcher.dispatch(new PlanModeExit({}));
    expect(agentState.get(planKey).active).toBe(false);

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'plan_mode.enter',
      'plan_mode.cancel',
      'plan_mode.enter',
      'plan_mode.exit',
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'plan_mode.enter',
        id: 'p1',
      }),
    );
  });

  it('cancel and exit both deactivate plan mode but emit distinct record types', async () => {
    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    await dispatcher.dispatch(new PlanModeCancel({ id: 'p1' }));
    expect(agentState.get(planKey)).toEqual({ active: false });

    await dispatcher.dispatch(new PlanModeEnter({ id: 'p2' }));
    await dispatcher.dispatch(new PlanModeExit({ id: 'p2' }));
    expect(agentState.get(planKey)).toEqual({ active: false });

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'plan_mode.enter',
      'plan_mode.cancel',
      'plan_mode.enter',
      'plan_mode.exit',
    ]);
    expect(records[1]).toEqual(expect.objectContaining({ type: 'plan_mode.cancel', id: 'p1' }));
    expect(records[3]).toEqual(expect.objectContaining({ type: 'plan_mode.exit', id: 'p2' }));
  });

  it('apply returns the same reference on a no-op (gate stays quiet)', async () => {
    const initial = agentState.get(planKey);
    await dispatcher.dispatch(new PlanModeCancel({}));
    expect(agentState.get(planKey)).toBe(initial);

    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    const active = agentState.get(planKey);
    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    expect(agentState.get(planKey)).toBe(active);
  });

  it('ignores an invalid undo count without corrupting checkpoint state', async () => {
    await dispatcher.dispatch(
      new ContextAppendMessage({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'keep me' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
    );
    const checkpointed = agentState.get(planKey);

    await dispatcher.dispatch(new ContextUndo({ count: 0.5 }));

    expect(agentState.get(planKey)).toBe(checkpointed);
    expect(agentState.get(planKey)).toEqual({ active: false });
  });

  it('replay rebuilds active state silently', async () => {
    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    const records = await readRecords();

    const host = buildHost('plan-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    await restoreTestEventDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'plan-replay'),
      records,
    );
    expect(host.agentState.get(planKey)).toEqual({
      active: true,
      id: 'p1',
    });
    expect(emissions).toEqual([]);

    const cancelled = buildHost('plan-replay-cancel');
    await restoreTestEventDispatcher(
      cancelled.dispatcher,
      cancelled.log,
      testWireScope(SCOPE, 'plan-replay-cancel'),
      [
      { type: 'plan_mode.enter', id: 'p1', planFilePath: '/w/plan/p1.md' },
      { type: 'plan_mode.cancel', id: 'p1' },
      ],
    );
    expect(cancelled.agentState.get(planKey).active).toBe(false);
  });

  it('plan.revision persists a flat reference record and advances the per-id counter', async () => {
    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    await dispatcher.dispatch(
      new PlanRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    expect(agentState.get(planKey)).toEqual({
      active: true,
      id: 'p1',
      revisionCount: { p1: 1 },
    });

    await dispatcher.dispatch(
      new PlanRevision({
        id: 'p1',
        version: 2,
        path: 'sessions/w/s/agents/main/plan/p1/v2.md',
        sha256: 'sha-b',
        bytes: 20,
      }),
    );
    expect(agentState.get(planKey).revisionCount).toEqual({ p1: 2 });

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'plan_mode.enter',
      'plan.revision',
      'plan.revision',
    ]);
    expect(records[1]).toEqual(
      expect.objectContaining({
        type: 'plan.revision',
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
        time: expect.any(Number),
      }),
    );
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
  });

  it('keeps the revision counter across the lifecycle and emits the event only live', async () => {
    const host = buildHost('plan-revision-events');
    const emissions: unknown[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e);
    });

    await host.dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    await host.dispatcher.dispatch(
      new PlanRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    await host.dispatcher.dispatch(new PlanModeExit({}));
    expect(host.agentState.get(planKey)).toEqual({
      active: false,
      revisionCount: { p1: 1 },
    });

    await host.dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    expect(host.agentState.get(planKey).revisionCount).toEqual({ p1: 1 });

    expect(
      emissions.filter((e) => (e as { type: string }).type === 'plan.revision'),
    ).toEqual([
      expect.objectContaining({
        type: 'plan.revision',
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    ]);
  });

  it('replay restores the revision counter silently', async () => {
    await dispatcher.dispatch(new PlanModeEnter({ id: 'p1' }));
    await dispatcher.dispatch(
      new PlanRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    await dispatcher.dispatch(
      new PlanRevision({
        id: 'p1',
        version: 2,
        path: 'sessions/w/s/agents/main/plan/p1/v2.md',
        sha256: 'sha-b',
        bytes: 20,
      }),
    );
    const records = await readRecords();

    const host = buildHost('plan-revision-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    await restoreTestEventDispatcher(
      host.dispatcher,
      host.log,
      testWireScope(SCOPE, 'plan-revision-replay'),
      records,
    );
    expect(host.agentState.get(planKey)).toEqual({
      active: true,
      id: 'p1',
      revisionCount: { p1: 2 },
    });
    expect(emissions).toEqual([]);
  });
});
