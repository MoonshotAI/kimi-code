import { describe, expect, it } from 'vitest';

import { type DomainEvent } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';

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
