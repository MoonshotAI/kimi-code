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
} from '#/agent/plan/planOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'plan-test';

let disposables: DisposableStore;
let wire: IWireService;
let log: IAppendLogStore;

function buildHost(key: string): { wire: IWireService; log: IAppendLogStore; eventBus: IEventBus } {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: key }]));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  return { wire: ix.get(IAgentWireService), log: ix.get(IAppendLogStore), eventBus: ix.get(IEventBus) };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  wire = host.wire;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
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

  it('replay rebuilds active state silently (no emissions, no subscriber notifications)', async () => {
    wire.dispatch(planModeEnter({ id: 'p1' }));
    const records = await readRecords();

    const host = buildHost('plan-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    let modelChanges = 0;
    host.wire.subscribe(PlanModel, () => {
      modelChanges += 1;
    });

    await host.wire.replay(...records);
    expect(host.wire.getModel(PlanModel)).toEqual({
      active: true,
      id: 'p1',
    });
    expect(emissions).toEqual([]);
    expect(modelChanges).toBe(0);

    const cancelled = buildHost('plan-replay-cancel');
    await cancelled.wire.replay(
      { type: 'plan_mode.enter', id: 'p1', planFilePath: '/w/plan/p1.md' },
      { type: 'plan_mode.cancel', id: 'p1' },
    );
    expect(cancelled.wire.getModel(PlanModel).active).toBe(false);
  });
});
