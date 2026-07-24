import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import {
  PlanModel,
  planModeCancel,
  planModeEnter,
  planModeExit,
  planRevision,
} from '#/agent/plan/planOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

const SCOPE = 'wire';
const KEY = 'plan-test';

let disposables: DisposableStore;
let wire: IWireService;
let log: IAppendLogStore;

function buildHost(key: string): { wire: IWireService; log: IAppendLogStore; eventBus: IEventBus } {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  const wire = registerTestAgentWire(ix, testWireScope(SCOPE, key), {
    log: ix.get(IAppendLogStore),
    eventBus: ix.get(IEventBus),
  });
  return { wire, log: ix.get(IAppendLogStore), eventBus: ix.get(IEventBus) };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  wire = host.wire;
  log = host.log;
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

describe('plan ops (wire-backed)', () => {
  it('enter/cancel/exit drive active state and persist flat records', async () => {
    expect(wire.getModel(PlanModel).active).toBe(false);

    wire.dispatch(planModeEnter({ id: 'p1' }));
    expect(wire.getModel(PlanModel)).toEqual({
      active: true,
      id: 'p1',
    });

    wire.dispatch(planModeCancel({ id: 'p1' }));
    expect(wire.getModel(PlanModel)).toEqual({ active: false });

    wire.dispatch(planModeEnter({ id: 'p2' }));
    wire.dispatch(planModeExit({}));
    expect(wire.getModel(PlanModel).active).toBe(false);

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
    wire.dispatch(planModeEnter({ id: 'p1' }));
    wire.dispatch(planModeCancel({ id: 'p1' }));
    expect(wire.getModel(PlanModel)).toEqual({ active: false });

    wire.dispatch(planModeEnter({ id: 'p2' }));
    wire.dispatch(planModeExit({ id: 'p2' }));
    expect(wire.getModel(PlanModel)).toEqual({ active: false });

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

  it('apply returns the same reference on a no-op (gate stays quiet)', () => {
    const initial = wire.getModel(PlanModel);
    wire.dispatch(planModeCancel({}));
    expect(wire.getModel(PlanModel)).toBe(initial);

    wire.dispatch(planModeEnter({ id: 'p1' }));
    const active = wire.getModel(PlanModel);
    wire.dispatch(planModeEnter({ id: 'p1' }));
    expect(wire.getModel(PlanModel)).toBe(active);
  });

  it('replay rebuilds active state silently', async () => {
    wire.dispatch(planModeEnter({ id: 'p1' }));
    const records = await readRecords();

    const host = buildHost('plan-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'plan-replay'),
      records,
    );
    expect(host.wire.getModel(PlanModel)).toEqual({
      active: true,
      id: 'p1',
    });
    expect(emissions).toEqual([]);

    const cancelled = buildHost('plan-replay-cancel');
    await restoreTestAgentWire(
      cancelled.wire,
      cancelled.log,
      testWireScope(SCOPE, 'plan-replay-cancel'),
      [
      { type: 'plan_mode.enter', id: 'p1', planFilePath: '/w/plan/p1.md' },
      { type: 'plan_mode.cancel', id: 'p1' },
      ],
    );
    expect(cancelled.wire.getModel(PlanModel).active).toBe(false);
  });

  it('plan.revision persists a flat reference record and advances the per-id counter', async () => {
    wire.dispatch(planModeEnter({ id: 'p1' }));
    wire.dispatch(
      planRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    expect(wire.getModel(PlanModel)).toEqual({
      active: true,
      id: 'p1',
      revisionCount: { p1: 1 },
    });

    wire.dispatch(
      planRevision({
        id: 'p1',
        version: 2,
        path: 'sessions/w/s/agents/main/plan/p1/v2.md',
        sha256: 'sha-b',
        bytes: 20,
      }),
    );
    expect(wire.getModel(PlanModel).revisionCount).toEqual({ p1: 2 });

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

    host.wire.dispatch(planModeEnter({ id: 'p1' }));
    host.wire.dispatch(
      planRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    host.wire.dispatch(planModeExit({}));
    expect(host.wire.getModel(PlanModel)).toEqual({
      active: false,
      revisionCount: { p1: 1 },
    });

    // Re-entering the same plan id continues the counter instead of
    // restarting it, so later revisions never overwrite earlier blobs.
    host.wire.dispatch(planModeEnter({ id: 'p1' }));
    expect(host.wire.getModel(PlanModel).revisionCount).toEqual({ p1: 1 });

    expect(
      emissions.filter((e) => (e as { type: string }).type === 'plan.revision'),
    ).toEqual([
      {
        type: 'plan.revision',
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      },
    ]);
  });

  it('replay restores the revision counter silently', async () => {
    wire.dispatch(planModeEnter({ id: 'p1' }));
    wire.dispatch(
      planRevision({
        id: 'p1',
        version: 1,
        path: 'sessions/w/s/agents/main/plan/p1/v1.md',
        sha256: 'sha-a',
        bytes: 12,
      }),
    );
    wire.dispatch(
      planRevision({
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
    await restoreTestAgentWire(
      host.wire,
      host.log,
      testWireScope(SCOPE, 'plan-revision-replay'),
      records,
    );
    expect(host.wire.getModel(PlanModel)).toEqual({
      active: true,
      id: 'p1',
      revisionCount: { p1: 2 },
    });
    expect(emissions).toEqual([]);
  });
});
