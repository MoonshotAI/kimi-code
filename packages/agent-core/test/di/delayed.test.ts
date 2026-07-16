import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { InstantiationService } from '#/di/instantiationService';
import { IInstantiationService, createDecorator, type IInstantiationService as IInstantiationServiceType } from '#/di/instantiation';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P1.2 — `supportsDelayedInstantiation: true` returns a Proxy that defers
 * real construction until the first non-event property access.
 *
 * Vitest runs in Node — `requestIdleCallback` is absent, so the
 * `GlobalIdleValue` polyfill uses `setTimeout`. Since our assertions read
 * `.value` synchronously via a Proxy `get`, the idle callback is
 * pre-empted by the synchronous access (which calls `_handle.dispose()`
 * then runs the executor inline). Tests therefore see deterministic
 * synchronous behavior.
 */

describe('Delayed instantiation Proxy (P1.2)', () => {
  it('does NOT construct the real instance at container.get(IFoo)', () => {
    let ctorCount = 0;
    interface IFoo {
      kind: 'foo';
    }
    class Foo implements IFoo {
      kind = 'foo' as const;
      constructor() {
        ctorCount += 1;
      }
    }
    const IFoo = createDecorator<IFoo>('p1.2-IFoo-noctor');
    const ix = new InstantiationService(
      new ServiceCollection([
        IFoo,
        new SyncDescriptor(Foo, [], /* supportsDelayedInstantiation */ true),
      ]),
    );
    // Container resolution must succeed without triggering the ctor.
    const proxy = ix.invokeFunction((a) => a.get(IFoo));
    expect(proxy).toBeDefined();
    expect(ctorCount).toBe(0);
  });

  it('reading a non-event property triggers real construction', () => {
    let ctorCount = 0;
    interface IFoo {
      kind: 'foo';
      describe(): string;
    }
    class Foo implements IFoo {
      kind = 'foo' as const;
      constructor() {
        ctorCount += 1;
      }
      describe(): string {
        return 'real-foo';
      }
    }
    const IFoo = createDecorator<IFoo>('p1.2-IFoo-trigger');
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo, [], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(IFoo));
    expect(ctorCount).toBe(0);
    const result = proxy.describe();
    expect(result).toBe('real-foo');
    expect(ctorCount).toBe(1);
  });

  it('`instance instanceof Foo` returns true even before materialisation', () => {
    interface IFoo {
      kind: 'foo';
    }
    class Foo implements IFoo {
      kind = 'foo' as const;
    }
    const IFoo = createDecorator<IFoo>('p1.2-IFoo-instanceof');
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo, [], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(IFoo));
    // getPrototypeOf trap returns `Foo.prototype` so `instanceof` works
    // without forcing the real ctor.
    expect(proxy instanceof Foo).toBe(true);
  });

  it('parked onDid* listeners fire after the proxy materialises', () => {
    type Listener<E> = (e: E) => void;
    type EventLike<E> = (cb: Listener<E>) => { dispose(): void };
    interface IFoo {
      onDidChange: EventLike<string>;
      describe(): string;
      fire(payload: string): void;
    }
    class Foo implements IFoo {
      private readonly _listeners: Listener<string>[] = [];
      readonly onDidChange: EventLike<string> = (cb) => {
        this._listeners.push(cb);
        return {
          dispose: () => {
            const idx = this._listeners.indexOf(cb);
            if (idx >= 0) this._listeners.splice(idx, 1);
          },
        };
      };
      describe(): string {
        return 'materialised';
      }
      fire(payload: string): void {
        for (const cb of [...this._listeners]) cb(payload);
      }
    }
    const IFoo = createDecorator<IFoo>('p1.2-IFoo-events');
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo, [], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(IFoo));

    // Subscribe BEFORE materialisation — listener is parked into the
    // earlyListeners LinkedList keyed by 'onDidChange'.
    const received: string[] = [];
    const sub = proxy.onDidChange((p) => received.push(p));
    expect(typeof sub.dispose).toBe('function');

    // Trigger materialisation by reading a non-event method, then fire
    // the real event — the parked listener was replayed against the real
    // event during materialisation, so it must receive the payload.
    expect(proxy.describe()).toBe('materialised');
    proxy.fire('hello-world');
    expect(received).toEqual(['hello-world']);
  });

  it('materialises delayed services in a child scope and records implicit dependency cycles', () => {
    interface IA {
      _serviceBrand: undefined;
      doIt(): boolean;
    }
    interface IB {
      _serviceBrand: undefined;
      b(): boolean;
    }
    const IA = createDecorator<IA>('delayed-graph-A');
    const IB = createDecorator<IB>('delayed-graph-B');

    class BConsumer {
      constructor(private readonly b: IB) {}
      doIt(): boolean {
        return this.b.b();
      }
    }
    (IB as unknown as (t: unknown, k: string, i: number) => void)(
      BConsumer,
      '',
      0,
    );

    class AService implements IA {
      _serviceBrand: undefined;
      private readonly consumer: BConsumer;
      constructor(ix: IInstantiationServiceType) {
        this.consumer = ix.createInstance(BConsumer);
      }
      doIt(): boolean {
        return this.consumer.doIt();
      }
    }
    (IInstantiationService as unknown as (t: unknown, k: string, i: number) => void)(
      AService,
      '',
      0,
    );

    class BService implements IB {
      _serviceBrand: undefined;
      constructor(public readonly a: IA) {}
      b(): boolean {
        return true;
      }
    }
    (IA as unknown as (t: unknown, k: string, i: number) => void)(
      BService,
      '',
      0,
    );

    class ExposedInstantiationService extends InstantiationService {
      cycle(): string | undefined {
        return this._globalGraph?.findCycleSlow();
      }
    }

    const ix = new ExposedInstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(AService, [], true)],
        [IB, new SyncDescriptor(BService)],
      ),
      true,
      undefined,
      true,
    );

    const a = ix.invokeFunction((accessor) => accessor.get(IA));
    expect(a.doIt()).toBe(true);
    expect(ix.cycle()).toBe('delayed-graph-A -> delayed-graph-B -> delayed-graph-A');
  });

  it('a delayed service with static arguments materialises correctly', () => {
    let ctorCount = 0;
    interface IGreeter {
      greet(name: string): string;
    }
    class Greeter implements IGreeter {
      constructor(public readonly prefix: string) {
        ctorCount += 1;
      }
      greet(name: string): string {
        return `${this.prefix} ${name}`;
      }
    }
    const IGreeter = createDecorator<IGreeter>('p1.2-delayed-static');
    const ix = new InstantiationService(
      new ServiceCollection([IGreeter, new SyncDescriptor(Greeter, ['Hello'], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(IGreeter));
    expect(ctorCount).toBe(0);
    expect(proxy.greet('World')).toBe('Hello World');
    expect(ctorCount).toBe(1);
  });

  it('multiple delayed services can be resolved independently', () => {
    interface IA { tag: 'A'; }
    interface IB { tag: 'B'; }
    const IA = createDecorator<IA>('p1.2-multi-A');
    const IB = createDecorator<IB>('p1.2-multi-B');
    class AImpl implements IA { tag = 'A' as const; }
    class BImpl implements IB { tag = 'B' as const; }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(AImpl, [], true)],
        [IB, new SyncDescriptor(BImpl, [], true)],
      ),
    );
    const proxyA = ix.invokeFunction((a) => a.get(IA));
    const proxyB = ix.invokeFunction((a) => a.get(IB));
    expect(proxyA.tag).toBe('A');
    expect(proxyB.tag).toBe('B');
  });

  it('materialisation error propagates to the caller', () => {
    interface IFoo { go(): void; }
    const IFoo = createDecorator<IFoo>('p1.2-delayed-error');
    class Foo implements IFoo {
      go(): void {
        throw new Error('materialisation-boom');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo, [], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(IFoo));
    expect(() => proxy.go()).toThrowError(/materialisation-boom/);
  });

  it('reading a property returns the real value after materialisation', () => {
    interface ICounter { count: number; }
    const ICounter = createDecorator<ICounter>('p1.2-delayed-prop');
    class Counter implements ICounter {
      count = 42;
    }
    const ix = new InstantiationService(
      new ServiceCollection([ICounter, new SyncDescriptor(Counter, [], true)]),
    );
    const proxy = ix.invokeFunction((a) => a.get(ICounter));
    expect(proxy.count).toBe(42);
  });
});
