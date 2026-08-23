import { describe, expect, it } from 'vitest';

import { collection, type CollectionView } from '#/_base/di/collection';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { Emitter } from '#/_base/event';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { EventService } from '#/app/event/eventService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { DI_UNIT_CHANGED_EVENT, DiUnitChanged } from '#/debug/debugCascade';
import { DebugCascadeService } from '#/debug/debugCascadeService';
import { DebugGraphService } from '#/debug/debugGraphService';
import { DebugLedgerService } from '#/debug/debugLedgerService';
import { DebugEventsService } from '#/features/debugEvents/debugEventsService';


interface IRoot {
  label: string;
}
const IRoot = createDecorator<IRoot>('debug-root');

interface IMid {
  root: IRoot;
}
const IMid = createDecorator<IMid>('debug-mid');

interface IBoom {
  marker: string;
}
const IBoom = createDecorator<IBoom>('debug-boom');

interface IFold {
  marker: string;
}
const IFold = createDecorator<IFold>('debug-fold');

const ToolContribution = collection<{ name: string }>('debug-tool-contribution');

class Root implements IRoot {
  label = 'root';
  dispose(): void {}
}

class Mid implements IMid {
  constructor(@IRoot readonly root: IRoot) {}
  dispose(): void {}
}

class Boom implements IBoom {
  marker = 'boom';
  constructor() {
    throw new Error('boom construction failed');
  }
}

class Fold extends Service implements IFold {
  marker = 'fold';
  constructor(@ToolContribution readonly view: CollectionView<{ name: string }>) {
    super();
  }
}

class FakeEventService implements IEventService {
  declare readonly _serviceBrand: undefined;
  private readonly emitter = new Emitter<Event2>();
  readonly onDidPublish = this.emitter.event;
  readonly published: Event2[] = [];
  publish(event: Event2): void {
    this.published.push(event);
    this.emitter.fire(event);
  }
  subscribe(handler: (event: Event2) => void) {
    return this.emitter.event(handler);
  }
}

class BusSubscriber extends Service {
  constructor(@IEventBus bus: IEventBus) {
    super();
    this._register(bus.subscribe('debug.test', () => undefined));
  }
}
const IBusSubscriber = createDecorator<BusSubscriber>('debug-bus-subscriber');

function makeTree(): { app: InstantiationService; ws: InstantiationService } {
  const app = new InstantiationService(new ServiceCollection(), true);
  app.debugLabel = 'app';
  const ws = app.createChild(new ServiceCollection()) as InstantiationService;
  ws.debugLabel = 'workspace:ws1';
  return { app, ws };
}


describe('debug domain — IDebugLedgerService', () => {
  it('tree() exposes units, ledger entries, and children recursively', () => {
    const { app, ws } = makeTree();
    app.provide(IRoot, new SyncDescriptor(Root));
    ws.provide(IMid, new SyncDescriptor(Mid));

    const tree = new DebugLedgerService(app).tree();

    expect(tree.path).toBe('app');
    expect(tree.label).toBe('app');
    const rootUnit = tree.units.find((unit) => unit.token === 'debug-root');
    expect(rootUnit).toMatchObject({
      uid: expect.any(Number),
      state: 'Active',
      everActive: true,
      inFlight: false,
    });
    expect(tree.ledger.map((entry) => entry.label)).toContain('provide:debug-root');
    expect(tree.ledger.map((entry) => entry.label)).toContain('service:debug-root');

    expect(tree.children).toHaveLength(1);
    const wsNode = tree.children[0]!;
    expect(wsNode.path).toBe('app/workspace:ws1');
    expect(wsNode.label).toBe('workspace:ws1');
    expect(wsNode.units.find((unit) => unit.token === 'debug-mid')).toMatchObject({
      state: 'Active',
    });
    expect(() => JSON.stringify(tree)).not.toThrow();
    app.dispose();
  });
});

describe('debug domain — IDebugGraphService', () => {
  it('graph() renders instance edges (cross-tree) and collection edges', () => {
    const { app, ws } = makeTree();
    app.provide(IRoot, new SyncDescriptor(Root));
    ws.provide(IMid, new SyncDescriptor(Mid));
    app.provide(IFold, new SyncDescriptor(Fold));
    ws.invokeFunction((a) => a.get(IMid));
    app.invokeFunction((a) => a.get(IFold));

    const graph = new DebugGraphService(app).graph();
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    expect(nodeIds.has('app::debug-root')).toBe(true);
    expect(nodeIds.has('app/workspace:ws1::debug-mid')).toBe(true);
    expect(graph.nodes.find((node) => node.id === 'app::debug-root')).toMatchObject({
      token: 'debug-root',
      scopePath: 'app',
      state: 'Active',
    });

    const instanceEdge = graph.edges.find(
      (edge) =>
        edge.from === 'app/workspace:ws1::debug-mid' &&
        edge.to === 'app::debug-root' &&
        edge.kind === 'instance',
    );
    expect(instanceEdge).toBeDefined();

    const collectionEdge = graph.edges.find((edge) => edge.kind === 'collection');
    expect(collectionEdge).toMatchObject({
      from: 'app::debug-fold',
      to: 'app::collection:debug-tool-contribution',
    });
    expect(nodeIds.has('app::collection:debug-tool-contribution')).toBe(true);
    expect(() => JSON.stringify(graph)).not.toThrow();
    app.dispose();
  });
});

describe('debug domain — IDebugCascadeService', () => {
  it('history() folds every scope and pending() reports waiting + failed units', () => {
    const { app, ws } = makeTree();
    const events = new FakeEventService();
    const service = new DebugCascadeService(app, events);

    ws.provide(IMid, new SyncDescriptor(Mid));
    app.provide(IBoom, new SyncDescriptor(Boom));
    ws.provide(IRoot, new SyncDescriptor(Root));

    const history = service.history();
    const scopes = new Set(history.map((entry) => entry.scopePath));
    expect(scopes.has('app')).toBe(true);
    expect(scopes.has('app/workspace:ws1')).toBe(true);
    expect(history.every((entry) => typeof entry.reason === 'string')).toBe(true);

    const pending = service.pending();
    const wsGroup = pending.find((group) => group.scopePath === 'app/workspace:ws1');
    expect(wsGroup?.waiting ?? []).toEqual([]);
    const appGroup = pending.find((group) => group.scopePath === 'app');
    expect(appGroup?.failed).toEqual([
      { token: 'debug-boom', error: 'boom construction failed' },
    ]);
    app.dispose();
  });

  it('pending() reports a waiting unit with its missing dependencies', () => {
    const { app, ws } = makeTree();
    const service = new DebugCascadeService(app, new FakeEventService());
    ws.provide(IMid, new SyncDescriptor(Mid));

    const wsGroup = service.pending().find((group) => group.scopePath === 'app/workspace:ws1');
    expect(wsGroup?.waiting).toEqual([{ token: 'debug-mid', missing: ['debug-root'] }]);
    app.dispose();
  });

  it('unprovide/update/dispose triggers drive the public cascade entries', async () => {
    const { app, ws } = makeTree();
    const service = new DebugCascadeService(app, new FakeEventService());
    app.provide(IRoot, new SyncDescriptor(Root));
    ws.provide(IMid, new SyncDescriptor(Mid));
    const firstMid = ws.invokeFunction((a) => a.get(IMid));

    await service.unprovide('app', 'debug-root');
    expect(app.cascade.stateOf(IRoot)).toBeUndefined();
    expect(ws.cascade.stateOf(IMid)).toBe('Pending');

    app.provide(IRoot, new SyncDescriptor(Root));
    expect(ws.cascade.stateOf(IMid)).toBe('Active');
    await service.update('app', 'debug-root');
    const secondMid = ws.invokeFunction((a) => a.get(IMid));
    expect(secondMid).not.toBe(firstMid);
    expect(ws.cascade.stateOf(IMid)).toBe('Active');

    await service.dispose('app', 'debug-root');
    expect(app.cascade.stateOf(IRoot)).toBeUndefined();
    expect(ws.cascade.stateOf(IMid)).toBe('Pending');
    app.dispose();
  });

  it('update with a config routes through the fiber host', async () => {
    const { app } = makeTree();
    const service = new DebugCascadeService(app, new FakeEventService());
    app.provide(IRoot, new SyncDescriptor(Root));
    await service.update('app', 'debug-root', { tag: 1 });
    expect(app.cascade.stateOf(IRoot)).toBe('Active');
    app.dispose();
  });

  it('rejects unknown scope paths and tokens with coded errors', async () => {
    const { app } = makeTree();
    const service = new DebugCascadeService(app, new FakeEventService());
    app.provide(IRoot, new SyncDescriptor(Root));

    await expect(service.unprovide('app/nope', 'debug-root')).rejects.toMatchObject({
      code: 'debug.scope_not_found',
    });
    await expect(service.update('app', 'debug-nope')).rejects.toMatchObject({
      code: 'debug.token_not_found',
    });
    await expect(
      (service.dispose as (scopePath?: string) => Promise<void>)('app'),
    ).rejects.toMatchObject({
      code: 'debug.token_not_found',
    });
    app.dispose();
  });

  it('publishes event.di.unit_changed for live and late-joined engines until teardown', () => {
    const { app } = makeTree();
    const events = new FakeEventService();
    const service = new DebugCascadeService(app, events);

    app.provide(IRoot, new SyncDescriptor(Root));
    const rootEvents = events.published.filter(
      (event) => event.type === DI_UNIT_CHANGED_EVENT,
    );
    expect(rootEvents).toContainEqual(
      expect.objectContaining({
        type: DI_UNIT_CHANGED_EVENT,
        payload: { scope: 'app', token: 'debug-root', state: 'Active', error: undefined },
      }),
    );

    const ws = app.createChild(new ServiceCollection()) as InstantiationService;
    ws.debugLabel = 'workspace:late';
    ws.provide(IMid, new SyncDescriptor(Mid));
    const wsEvents = events.published.filter(
      (event): event is DiUnitChanged =>
        event.type === DI_UNIT_CHANGED_EVENT &&
        (event as DiUnitChanged).payload.scope === 'app/workspace:late',
    );
    expect(wsEvents.length).toBeGreaterThan(0);

    const publishedBefore = events.published.length;
    service.dispose();
    app.provide(IBoom, new SyncDescriptor(Boom));
    expect(events.published.length).toBe(publishedBefore);
    app.dispose();
  });
});

describe('debug domain — IDebugEventsService', () => {
  it('subscriptions() merges unit-book labels and bus listener counts, deduped across containers', () => {
    const { app } = makeTree();
    app.provide(IEventBus, new SyncDescriptor(EventBusService));
    app.provide(IBusSubscriber, new SyncDescriptor(BusSubscriber));
    app.invokeFunction((a) => a.get(IBusSubscriber));
    const bus = app.invokeFunction((a) => a.get(IEventBus));
    bus.subscribe('debug.test', () => undefined);
    bus.subscribe(() => undefined);

    const result = new DebugEventsService(app).subscriptions();

    const entry = result.subscriptions.find((s) => s.unit === 'debug-bus-subscriber');
    expect(entry).toMatchObject({
      scopePath: 'app',
      label: 'on:debug.test',
      kind: 'disposer',
      uid: expect.any(Number),
    });
    expect(result.buses).toEqual([
      { scopePath: 'app', all: 1, perType: { 'debug.test': 2 } },
    ]);
    expect(() => JSON.stringify(result)).not.toThrow();
    app.dispose();
  });

  it('skips unmaterialized units and reports the global event service listener count', () => {
    const { app } = makeTree();
    app.provide(IBusSubscriber, new SyncDescriptor(BusSubscriber));
    app.provide(IEventService, new SyncDescriptor(EventService));
    const events = app.invokeFunction((a) => a.get(IEventService));
    events.subscribe(() => undefined);

    const result = new DebugEventsService(app).subscriptions();

    expect(result.subscriptions.find((s) => s.unit === 'debug-bus-subscriber')).toBeUndefined();
    expect(result.globalListeners).toBe(1);
    app.dispose();
  });
});
