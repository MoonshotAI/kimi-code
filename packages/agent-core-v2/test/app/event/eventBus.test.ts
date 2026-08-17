/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import '#/app/event/fiberEventResolver';

class TestA extends Event2<{ readonly x: number }> {
  static override readonly type = 'test.a';
}
interface TestA {
  readonly x: number;
}

class TestB extends Event2<{ readonly y: string }> {
  static override readonly type = 'test.b';
}
interface TestB {
  readonly y: string;
}

describe('event bus (full-stream and per-type delivery, dispose and empty-publish tolerance)', () => {
  it('delivers every published event to a full-stream subscriber', () => {
    const bus = new EventBusService();
    const seen: Event2[] = [];
    bus.subscribe((e) => seen.push(e));

    bus.publish(new TestA({ x: 1 }));
    bus.publish(new TestB({ y: 'z' }));

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeInstanceOf(TestA);
    expect(seen[1]).toBeInstanceOf(TestB);
    expect(seen[0]).toMatchObject({ type: 'test.a', x: 1 });
    expect(seen[1]).toMatchObject({ type: 'test.b', y: 'z' });
  });

  it('delivers only matching events to a per-class subscriber', () => {
    const bus = new EventBusService();
    const seenA: number[] = [];
    const seenB: string[] = [];
    bus.subscribe(TestA, (e) => seenA.push(e.x));
    bus.subscribe(TestB, (e) => seenB.push(e.y));

    bus.publish(new TestA({ x: 1 }));
    bus.publish(new TestB({ y: 'z' }));
    bus.publish(new TestA({ x: 2 }));

    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual(['z']);
  });

  it('delivers only matching events to a per-string subscriber', () => {
    const bus = new EventBusService();
    const seen: number[] = [];
    bus.subscribe('test.a', (e) => seen.push((e as TestA).x));

    bus.publish(new TestA({ x: 1 }));
    bus.publish(new TestB({ y: 'z' }));
    bus.publish(new TestA({ x: 2 }));

    expect(seen).toEqual([1, 2]);
  });

  it('keeps the full stream active when a per-type subscriber is present', () => {
    const bus = new EventBusService();
    const all: string[] = [];
    const typed: string[] = [];
    bus.subscribe((e) => all.push(e.type));
    bus.subscribe(TestA, (e) => typed.push(e.type));

    bus.publish(new TestA({ x: 1 }));
    bus.publish(new TestB({ y: 'z' }));

    expect(all).toEqual(['test.a', 'test.b']);
    expect(typed).toEqual(['test.a']);
  });

  it('fires the full stream before the per-type stream for one publish', () => {
    const bus = new EventBusService();
    const order: string[] = [];
    bus.subscribe(() => order.push('all'));
    bus.subscribe(TestA, () => order.push('typed'));
    bus.subscribe('test.a', () => order.push('string'));

    bus.publish(new TestA({ x: 1 }));

    expect(order).toEqual(['all', 'typed', 'string']);
  });

  it('stops delivering after the subscription is disposed', () => {
    const bus = new EventBusService();
    const seen: string[] = [];
    const sub = bus.subscribe(TestA, (e) => seen.push(e.type));

    bus.publish(new TestA({ x: 1 }));
    sub.dispose();
    bus.publish(new TestA({ x: 2 }));

    expect(seen).toEqual(['test.a']);
  });

  it('does not throw when publishing with no subscribers', () => {
    const bus = new EventBusService();
    expect(() => bus.publish(new TestA({ x: 1 }))).not.toThrow();
  });

  it('reports listener counts for the full stream and each subscribed type', () => {
    const bus = new EventBusService();
    expect(bus.listenerCounts()).toEqual({ all: 0, perType: {} });

    const all = bus.subscribe(() => undefined);
    const a = bus.subscribe(TestA, () => undefined);
    const aString = bus.subscribe('test.a', () => undefined);
    const b = bus.subscribe(TestB, () => undefined);

    expect(bus.listenerCounts()).toEqual({
      all: 1,
      perType: { 'test.a': 2, 'test.b': 1 },
    });

    a.dispose();
    aString.dispose();
    expect(bus.listenerCounts()).toEqual({
      all: 1,
      perType: { 'test.a': 0, 'test.b': 1 },
    });

    all.dispose();
    b.dispose();
    expect(bus.listenerCounts()).toEqual({
      all: 0,
      perType: { 'test.a': 0, 'test.b': 0 },
    });
  });
});

describe('fiberEventResolver — string on(...) resolved against the scope IEventBus', () => {
  it('delivers matching bus events to a unit string subscription and detaches on unload', () => {
    const bus = new EventBusService();
    const seen: number[] = [];
    class Unit extends Service {
      constructor() {
        super();
        this.on('test.a', (e: TestA) => seen.push(e.x));
      }
    }
    const IUnit = createDecorator<Unit>('test-string-on-unit');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IEventBus, bus);
    ix.provide(IUnit, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IUnit));

    bus.publish(new TestA({ x: 1 }));
    bus.publish(new TestB({ y: 'ignored' }));
    expect(seen).toEqual([1]);

    ix.unprovide(IUnit);
    bus.publish(new TestA({ x: 2 }));
    expect(seen).toEqual([1]);
    ix.dispose();
  });

  it('attaches when the bus arrives after the unit was constructed', () => {
    const bus = new EventBusService();
    const seen: number[] = [];
    class LateUnit extends Service {
      constructor() {
        super();
        this.on('test.a', (e: TestA) => seen.push(e.x));
      }
    }
    const ILateUnit = createDecorator<LateUnit>('test-string-on-late-unit');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(ILateUnit, new SyncDescriptor(LateUnit));
    ix.invokeFunction((a) => a.get(ILateUnit));

    bus.publish(new TestA({ x: 0 }));
    expect(seen).toEqual([]);

    ix.provide(IEventBus, bus);
    bus.publish(new TestA({ x: 7 }));
    expect(seen).toEqual([7]);
    ix.dispose();
  });
});
