import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import '#/app/event/fiberEventResolver';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'test.a': { x: number };
    'test.b': { y: string };
    'test.full': { readonly type: 'test.full'; readonly z: boolean };
  }
}

describe('event bus (full-stream and per-type delivery, dispose and empty-publish tolerance)', () => {
  it('delivers every published event to a full-stream subscriber', () => {
    const bus = new EventBusService();
    const seen: DomainEvent[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish({ type: 'test.a', x: 1 });
    bus.publish({ type: 'test.b', y: 'z' });

    expect(seen).toEqual([
      { type: 'test.a', x: 1 },
      { type: 'test.b', y: 'z' },
    ]);
  });

  it('delivers only matching events to a per-type subscriber', () => {
    const bus = new EventBusService();
    const seenA: number[] = [];
    const seenB: string[] = [];
    bus.subscribe('test.a', (e) => seenA.push(e.x));
    bus.subscribe('test.b', (e) => seenB.push(e.y));

    bus.publish({ type: 'test.a', x: 1 });
    bus.publish({ type: 'test.b', y: 'z' });
    bus.publish({ type: 'test.a', x: 2 });

    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual(['z']);
  });

  it('keeps the full stream active when a per-type subscriber is present', () => {
    const bus = new EventBusService();
    const all: string[] = [];
    const typed: string[] = [];
    bus.subscribe((e) => all.push(e.type));
    bus.subscribe('test.a', (e) => typed.push(e.type));

    bus.publish({ type: 'test.a', x: 1 });
    bus.publish({ type: 'test.b', y: 'z' });

    expect(all).toEqual(['test.a', 'test.b']);
    expect(typed).toEqual(['test.a']);
  });

  it('stops delivering after the subscription is disposed', () => {
    const bus = new EventBusService();
    const seen: string[] = [];
    const sub = bus.subscribe('test.a', (e) => seen.push(e.type));

    bus.publish({ type: 'test.a', x: 1 });
    sub.dispose();
    bus.publish({ type: 'test.a', x: 2 });

    expect(seen).toEqual(['test.a']);
  });

  it('does not throw when publishing with no subscribers', () => {
    const bus = new EventBusService();
    expect(() => bus.publish({ type: 'test.a', x: 1 })).not.toThrow();
  });

  it('accepts full event types in the domain event map', () => {
    const bus = new EventBusService();
    const seen: boolean[] = [];
    bus.subscribe('test.full', (e) => seen.push(e.z));

    bus.publish({ type: 'test.full', z: true });

    expect(seen).toEqual([true]);
  });
});

describe('fiberEventResolver — string on(...) resolved against the scope IEventBus', () => {
  it('delivers matching bus events to a unit string subscription and detaches on unload', () => {
    const bus = new EventBusService();
    const seen: number[] = [];
    class Unit extends Service {
      constructor() {
        super();
        this.on('test.a', (e: { x: number }) => seen.push(e.x));
      }
    }
    const IUnit = createDecorator<Unit>('test-string-on-unit');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IEventBus, bus);
    ix.provide(IUnit, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IUnit));

    bus.publish({ type: 'test.a', x: 1 });
    bus.publish({ type: 'test.b', y: 'ignored' });
    expect(seen).toEqual([1]);

    ix.unprovide(IUnit);
    bus.publish({ type: 'test.a', x: 2 });
    expect(seen).toEqual([1]);
    ix.dispose();
  });

  it('attaches when the bus arrives after the unit was constructed', () => {
    const bus = new EventBusService();
    const seen: number[] = [];
    class LateUnit extends Service {
      constructor() {
        super();
        this.on('test.a', (e: { x: number }) => seen.push(e.x));
      }
    }
    const ILateUnit = createDecorator<LateUnit>('test-string-on-late-unit');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(ILateUnit, new SyncDescriptor(LateUnit));
    ix.invokeFunction((a) => a.get(ILateUnit));

    bus.publish({ type: 'test.a', x: 0 });
    expect(seen).toEqual([]);

    ix.provide(IEventBus, bus);
    bus.publish({ type: 'test.a', x: 7 });
    expect(seen).toEqual([7]);
    ix.dispose();
  });
});
