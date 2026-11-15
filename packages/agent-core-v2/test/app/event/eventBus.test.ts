/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Disposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { AgentEvent2, Event2 } from '#/app/event/event2';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEventBusView, EventBusService } from '#/app/event/eventBusService';
import '#/app/event/fiberEventResolver';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { stubAgentContext } from '../../agent/agentContext/stubs';

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

const agentEventSchema = z.object({ agentId: z.string(), value: z.number() });

class TestAgentEvent extends AgentEvent2<z.infer<typeof agentEventSchema>> {
  static override readonly type = 'test.agent';
  static override readonly durable = true;
  static override readonly schema = agentEventSchema;
}
interface TestAgentEvent {
  readonly agentId: string;
  readonly value: number;
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
    expect(bus.listenerCounts()).toEqual({ all: 0, perType: {}, perAgent: {} });

    const all = bus.subscribe(() => undefined);
    const a = bus.subscribe(TestA, () => undefined);
    const aString = bus.subscribe('test.a', () => undefined);
    const b = bus.subscribe(TestB, () => undefined);

    expect(bus.listenerCounts()).toEqual({
      all: 1,
      perType: { 'test.a': 2, 'test.b': 1 },
      perAgent: {},
    });

    a.dispose();
    aString.dispose();
    expect(bus.listenerCounts()).toEqual({
      all: 1,
      perType: { 'test.a': 0, 'test.b': 1 },
      perAgent: {},
    });

    all.dispose();
    b.dispose();
    expect(bus.listenerCounts()).toEqual({
      all: 0,
      perType: { 'test.a': 0, 'test.b': 0 },
      perAgent: {},
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

describe('session agent event routing', () => {
  it('filters by payload identity and rejects stale contexts', () => {
    const bus = new EventBusService();
    const a = stubAgentContext('a', 1);
    const b = stubAgentContext('b', 1);
    const stale = stubAgentContext('a', 2);
    bus.activateAgent(a);
    bus.activateAgent(b);
    const seenA: number[] = [];
    bus.onAgent(a, TestAgentEvent, (event) => seenA.push(event.value));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), a);
    bus.publish(new TestAgentEvent({ agentId: 'b', value: 2 }), b);

    expect(seenA).toEqual([1]);
    expect(() => bus.onAgent(stale, TestAgentEvent, () => {})).toThrow('not the active');
    bus.deactivateAgent(a);
    expect(() => bus.publish(new TestAgentEvent({ agentId: 'a', value: 3 }), a)).toThrow(
      'no active lifecycle context',
    );
  });

  it('stops onAgent delivery after the agent is deactivated and a generation is replaced', () => {
    const bus = new EventBusService();
    const a = stubAgentContext('a', 1);
    bus.activateAgent(a);
    const seen: number[] = [];
    bus.onAgent(a, TestAgentEvent, (event) => seen.push(event.value));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), a);
    bus.deactivateAgent(a);
    const a2 = stubAgentContext('a', 2);
    bus.activateAgent(a2);
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 2 }), a2);

    expect(seen).toEqual([1]);
  });
});

describe('per-agent sharded channels', () => {
  it('delivers only its own agent events to a view full-stream subscriber', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    const scopeB = makeAgentScopeContext({ agentId: 'b', agentScope: 'agents/b', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    bus.activateAgent(scopeB.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const viewB = new AgentEventBusView(bus, scopeB);
    const seenA: string[] = [];
    const seenB: string[] = [];
    viewA.subscribe((event) => seenA.push(event.type));
    viewB.subscribe((event) => seenB.push(event.type));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'b', value: 2 }), scopeB.agentContext);
    bus.publish(new TestA({ x: 1 }), scopeA.agentContext);
    bus.publish(new TestA({ x: 2 }));

    expect(seenA).toEqual(['test.agent', 'test.a']);
    expect(seenB).toEqual(['test.agent']);
  });

  it('delivers only its own agent matching-type events to view typed subscribers', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    const scopeB = makeAgentScopeContext({ agentId: 'b', agentScope: 'agents/b', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    bus.activateAgent(scopeB.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const viewB = new AgentEventBusView(bus, scopeB);
    const byClass: number[] = [];
    const byString: number[] = [];
    const seenB: number[] = [];
    viewA.subscribe(TestAgentEvent, (event) => byClass.push(event.value));
    viewA.subscribe('test.agent', (event) =>
      byString.push((event as Event2<any> & { value: number }).value),
    );
    viewB.subscribe(TestAgentEvent, (event) => seenB.push(event.value));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);
    bus.publish(new TestA({ x: 1 }), scopeA.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'b', value: 2 }), scopeB.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 3 }), scopeA.agentContext);

    expect(byClass).toEqual([1, 3]);
    expect(byString).toEqual([1, 3]);
    expect(seenB).toEqual([2]);
  });

  it('keeps per-agent delivery order matching publish order', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    const scopeB = makeAgentScopeContext({ agentId: 'b', agentScope: 'agents/b', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    bus.activateAgent(scopeB.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const seen: string[] = [];
    viewA.subscribe((event) => seen.push(event.type));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'b', value: 2 }), scopeB.agentContext);
    bus.publish(new TestA({ x: 1 }), scopeA.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 3 }), scopeA.agentContext);

    expect(seen).toEqual(['test.agent', 'test.a', 'test.agent']);
  });

  it('fires the full stream, then the agent stream, then the per-type stream for one publish', () => {
    const bus = new EventBusService();
    const a = stubAgentContext('a', 1);
    bus.activateAgent(a);
    const order: string[] = [];
    bus.subscribe(() => order.push('all'));
    bus.subscribe(TestAgentEvent, () => order.push('typed'));
    bus.subscribeAgent(a, () => order.push('agent'));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), a);

    expect(order).toEqual(['all', 'agent', 'typed']);
  });

  it('does not attach view or onAgent subscriptions to the shared channels', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const full = viewA.subscribe(() => undefined);
    const typed = viewA.subscribe(TestAgentEvent, () => undefined);
    const perAgent = bus.onAgent(scopeA.agentContext, TestAgentEvent, () => undefined);

    expect(bus.listenerCounts()).toEqual({
      all: 0,
      perType: { 'test.agent': 2 },
      perAgent: { a: 1 },
    });

    typed.dispose();
    expect(bus.listenerCounts().perAgent).toEqual({ a: 1 });
    full.dispose();
    perAgent.dispose();
    expect(bus.listenerCounts()).toEqual({
      all: 0,
      perType: { 'test.agent': 0 },
      perAgent: { a: 0 },
    });
  });

  it('removes the sharded channel on deactivate and isolates a re-activated generation', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(gen1.agentContext);
    const view1 = new AgentEventBusView(bus, gen1);
    const seen1: number[] = [];
    view1.subscribe(TestAgentEvent, (event) => seen1.push(event.value));
    expect(bus.listenerCounts().perAgent).toEqual({});

    bus.deactivateAgent(gen1.agentContext);
    expect(bus.listenerCounts().perAgent).toEqual({});

    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen2.agentContext);
    const view2 = new AgentEventBusView(bus, gen2);
    const seen2: number[] = [];
    view2.subscribe(TestAgentEvent, (event) => seen2.push(event.value));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 7 }), gen2.agentContext);

    expect(seen2).toEqual([7]);
    expect(seen1).toEqual([]);
  });

  it('isolates both channels when a new generation replaces the active context', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(gen1.agentContext);
    const view1 = new AgentEventBusView(bus, gen1);
    const fullSeen: number[] = [];
    const typedSeen: number[] = [];
    view1.subscribe((event) => {
      if (event instanceof TestAgentEvent) fullSeen.push(event.value);
    });
    view1.subscribe(TestAgentEvent, (event) => typedSeen.push(event.value));

    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen2.agentContext);
    const view2 = new AgentEventBusView(bus, gen2);
    const seen2: number[] = [];
    view2.subscribe((event) => {
      if (event instanceof TestAgentEvent) seen2.push(event.value);
    });

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 9 }), gen2.agentContext);

    expect(fullSeen).toEqual([]);
    expect(typedSeen).toEqual([]);
    expect(seen2).toEqual([9]);
  });

  it('does not deliver stale-generation non-agent events to the replacement full stream', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(gen1.agentContext);

    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen2.agentContext);
    const view2 = new AgentEventBusView(bus, gen2);
    const seen: string[] = [];
    view2.subscribe((event) => seen.push(event.type));

    bus.publish(new TestA({ x: 1 }), gen1.agentContext);
    bus.publish(new TestA({ x: 2 }), gen2.agentContext);

    expect(seen).toEqual(['test.a']);
  });

  it('rejects a stale generation subscribing to the replacement full stream', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(gen1.agentContext);
    const view1 = new AgentEventBusView(bus, gen1);

    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen2.agentContext);
    const view2 = new AgentEventBusView(bus, gen2);
    const seen2: string[] = [];
    view2.subscribe((event) => seen2.push(event.type));

    const staleSeen: string[] = [];
    expect(() => view1.subscribe((event) => staleSeen.push(event.type))).toThrow(
      'not the active',
    );

    bus.publish(new TestA({ x: 1 }), gen2.agentContext);

    expect(seen2).toEqual(['test.a']);
    expect(staleSeen).toEqual([]);
  });

  it('delivers only its own agent events to a typed subscribeAgent subscriber', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    const scopeB = makeAgentScopeContext({ agentId: 'b', agentScope: 'agents/b', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    bus.activateAgent(scopeB.agentContext);
    const agentEvents: number[] = [];
    const plainEvents: number[] = [];
    bus.subscribeAgent(scopeA.agentContext, 'test.agent', (event) =>
      agentEvents.push((event as TestAgentEvent).value),
    );
    bus.subscribeAgent(scopeA.agentContext, 'test.a', (event) =>
      plainEvents.push((event as TestA).x),
    );

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'b', value: 2 }), scopeB.agentContext);
    bus.publish(new TestA({ x: 1 }), scopeA.agentContext);
    bus.publish(new TestA({ x: 2 }), scopeB.agentContext);
    bus.publish(new TestA({ x: 3 }));

    expect(agentEvents).toEqual([1]);
    expect(plainEvents).toEqual([1]);
  });

  it('stops typed subscribeAgent delivery after the agent generation is replaced', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(gen1.agentContext);
    const seen: number[] = [];
    bus.subscribeAgent(gen1.agentContext, 'test.agent', (event) =>
      seen.push((event as TestAgentEvent).value),
    );

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), gen1.agentContext);
    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen2.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 2 }), gen2.agentContext);

    expect(seen).toEqual([1]);
    expect(() => bus.subscribeAgent(gen1.agentContext, 'test.agent', () => {})).toThrow(
      'not the active',
    );
  });

  it('keeps a stale generation deactivation from removing the active channel', () => {
    const bus = new EventBusService();
    const gen1 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    const gen2 = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 2 });
    bus.activateAgent(gen1.agentContext);
    bus.activateAgent(gen2.agentContext);
    const view2 = new AgentEventBusView(bus, gen2);
    const seen: number[] = [];
    view2.subscribe(TestAgentEvent, (event) => seen.push(event.value));

    bus.deactivateAgent(gen1.agentContext);
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 5 }), gen2.agentContext);

    expect(seen).toEqual([5]);
    expect(bus.listenerCounts().perAgent).toEqual({});
  });

  it('fires full-stream handlers before typed handlers within an agent channel regardless of registration order', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const order: string[] = [];
    viewA.subscribe(TestAgentEvent, () => order.push('typed'));
    viewA.subscribe(() => order.push('full'));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);

    expect(order).toEqual(['full', 'typed']);
  });

  it('delivers an agent full-stream handler before a session-level typed handler for the same event', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const order: string[] = [];
    bus.subscribe(TestAgentEvent, () => order.push('session-typed'));
    viewA.subscribe(() => order.push('agent-full'));

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 2 }), scopeA.agentContext);

    expect(order).toEqual(['agent-full', 'session-typed']);
  });

  it('disposes sharded channels when the bus itself is disposed', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);
    const seen: number[] = [];
    viewA.subscribe((event) => {
      if (event instanceof TestAgentEvent) seen.push(event.value);
    });

    bus.publish(new TestAgentEvent({ agentId: 'a', value: 1 }), scopeA.agentContext);
    bus.dispose();
    bus.publish(new TestAgentEvent({ agentId: 'a', value: 2 }), scopeA.agentContext);

    expect(seen).toEqual([1]);
    expect(bus.listenerCounts().perAgent).toEqual({});
  });

  it('does not recreate agent channels after the bus is disposed', () => {
    const bus = new EventBusService();
    const scopeA = makeAgentScopeContext({ agentId: 'a', agentScope: 'agents/a', generation: 1 });
    bus.activateAgent(scopeA.agentContext);
    const viewA = new AgentEventBusView(bus, scopeA);

    bus.dispose();

    const seen: number[] = [];
    const subscription = viewA.subscribe((event) => {
      if (event instanceof TestAgentEvent) seen.push(event.value);
    });
    expect(bus.listenerCounts().perAgent).toEqual({});
    expect(subscription).toBe(Disposable.None);
    expect(() => bus.publish(new TestAgentEvent({ agentId: 'a', value: 3 }), scopeA.agentContext)).not.toThrow();
    expect(seen).toEqual([]);
  });
});
