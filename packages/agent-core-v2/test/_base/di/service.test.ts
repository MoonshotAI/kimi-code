import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter } from '#/_base/event';
import {
  FiberProtocolError,
  FiberState,
  ScopeUnits,
  setFiberEventResolver,
  type Fiber,
  type FiberHandle,
} from '#/_base/di/fiber';
import { createDecorator, ref, type LiveRef } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Service } from '#/_base/di/service';
import { ServiceCollection } from '#/_base/di/serviceCollection';

interface IFoo {
  tag: string;
}
const IFoo = createDecorator<IFoo>('service-foo');

interface IBar {
  tag: string;
}
const IBar = createDecorator<IBar>('service-bar');

class Foo implements IFoo {
  tag = 'foo';
}

class Bar implements IBar {
  tag = 'bar';
  constructor(@IFoo public readonly foo: IFoo) {}
}

describe('Service — kernel construction protocol (L3)', () => {
  afterEach(() => {
    setFiberEventResolver(undefined);
  });

  it('flushes buffered capability calls in writing order', () => {
    const order: string[] = [];
    class Unit extends Service {
      constructor() {
        super();
        this.effect(() => {
          order.push('effect-a');
          return undefined;
        });
        this.provide(IFoo, Foo);
        this.effect(() => {
          order.push('effect-b');
          return undefined;
        });
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IBar));
    expect(order).toEqual(['effect-a', 'effect-b']);
    expect(ix.invokeFunction((a) => a.get(IFoo)).tag).toBe('foo');
    ix.dispose();
  });

  it('throws when get/ref are called during construction', () => {
    class GetInCtor extends Service {
      constructor() {
        super();
        this.get(IFoo);
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(GetInCtor));
    expect(() => ix.invokeFunction((a) => a.get(IBar))).toThrow(FiberProtocolError);
    ix.dispose();

    class RefInCtor extends Service {
      constructor() {
        super();
        this.ref(IFoo);
      }
    }
    const ix2 = new InstantiationService(new ServiceCollection(), true);
    ix2.provide(IBar, new SyncDescriptor(RefInCtor));
    expect(() => ix2.invokeFunction((a) => a.get(IBar))).toThrow(FiberProtocolError);
    ix2.dispose();
  });

  it('throws on every capability call of a manually newed instance', () => {
    class Unit extends Service {}
    const unit = new Unit();
    expect(() => unit.provide(IFoo, Foo)).toThrow(/no unit runtime/);
    expect(() => unit.effect(() => undefined)).toThrow(/no unit runtime/);
    expect(() => unit.on('x', () => {})).toThrow(/no unit runtime/);
    expect(() => unit.get(IFoo)).toThrow(/no unit runtime/);
    expect(() => unit.ref(IFoo)).toThrow(/no unit runtime/);
  });

  it('rejects a manual new nested inside another unit’s ctor', () => {
    class Inner extends Service {}
    class Outer extends Service {
      readonly inner = new Inner();
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Outer));
    const outer = ix.invokeFunction((a) => a.get(IBar)) as unknown as Outer;
    expect(() => outer.inner.effect(() => undefined)).toThrow(/no unit runtime/);
    ix.dispose();
  });

  it('attaches pending handles handed out during buffering at flush', async () => {
    let captured: FiberHandle | undefined;
    class Unit extends Service {
      constructor() {
        super();
        captured = this.provide(IFoo, Foo);
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IBar));
    expect(captured).toBeDefined();
    expect(captured!.state).toBe(FiberState.Active);
    expect(typeof captured!.uid).toBe('number');
    await expect(captured!).resolves.toMatchObject({ state: FiberState.Active });
    ix.dispose();
  });

  it('withdraws a unit-provided token when the provider is retired (连坐)', () => {
    class Provider extends Service {
      constructor() {
        super();
        this.provide(IFoo, Foo);
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IBar));
    expect(ix.invokeFunction((a) => a.get(IFoo)).tag).toBe('foo');
    ix.unprovide(IBar);
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    ix.dispose();
  });

  it('auto-activates a pending dependent once a unit provides its dependency', () => {
    class Provider extends Service {
      constructor() {
        super();
        this.provide(IFoo, Foo);
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Bar));
    expect(() => ix.invokeFunction((a) => a.get(IBar))).toThrow();
    const IProvider = createDecorator<Provider>('service-provider');
    ix.provide(IProvider, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IProvider));
    const bar = ix.invokeFunction((a) => a.get(IBar));
    expect(bar.tag).toBe('bar');
    ix.dispose();
  });

  it('checks get against the declared constructor dependencies', () => {
    class Unit extends Service {
      constructor(@IFoo public readonly foo: IFoo) {
        super();
      }
      probe(): [IFoo, unknown] {
        return [this.get(IFoo), () => this.get(IBar)];
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Unit));
    const unit = ix.invokeFunction((a) => a.get(IBar)) as unknown as Unit;
    const [foo, undeclared] = unit.probe();
    expect(foo.tag).toBe('foo');
    expect(undeclared).toThrow(/undeclared dependency/);
    ix.dispose();
  });

  it('injects a live @ref observation without a lifecycle binding', () => {
    class Consumer extends Service {
      disposed = false;
      constructor(@ref(IFoo) public readonly fooRef: LiveRef<IFoo>) {
        super();
      }
      override dispose(): void {
        this.disposed = true;
        super.dispose();
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Consumer));
    const consumer = ix.invokeFunction((a) => a.get(IBar)) as unknown as Consumer;
    expect(consumer.fooRef.current).toBeUndefined();
    const provideHandle = ix.provide(IFoo, new SyncDescriptor(Foo));
    expect(consumer.fooRef.current?.tag).toBe('foo');
    provideHandle.dispose();
    expect(consumer.disposed).toBe(false);
    ix.dispose();
  });

  it('runs function recipes against a checked facade and anchors the return disposer', () => {
    const log: string[] = [];
    class Provider extends Service {
      constructor() {
        super();
        this.provide(
          Object.assign(
            (fiber: Fiber) => {
              log.push(`run:${fiber.get(IFoo).tag}`);
              return () => {
                log.push('cleanup');
              };
            },
            { inject: [IFoo] as const },
          ),
        );
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IBar));
    expect(log).toEqual(['run:foo']);
    ix.unprovide(IBar);
    expect(log).toEqual(['run:foo', 'cleanup']);
    ix.dispose();
  });

  it('rejects a facade get of an undeclared dependency in a function recipe', () => {
    class Provider extends Service {
      constructor() {
        super();
        this.provide((fiber) => {
          fiber.get(IFoo);
        });
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Provider));
    expect(() => ix.invokeFunction((a) => a.get(IBar))).toThrow(/undeclared dependency/);
    ix.dispose();
  });

  it('rebuilds a token unit with new config on update(config)', async () => {
    const configs: unknown[] = [];
    class Unit extends Service {
      constructor() {
        super();
        configs.push(this.config);
      }
    }
    let handle: FiberHandle | undefined;
    class Provider extends Service {
      constructor() {
        super();
        handle = this.provide(IFoo, Unit, { config: { v: 1 } });
      }
    }
    const IProvider = createDecorator<Provider>('service-config-provider');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IProvider, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IProvider));
    ix.invokeFunction((a) => a.get(IFoo));
    expect(configs).toEqual([{ v: 1 }]);
    await handle!.update({ v: 2 });
    expect(configs).toEqual([{ v: 1 }, { v: 2 }]);
    ix.dispose();
  });

  it('exposes config already inside the constructor (frame-carried)', () => {
    let seen: unknown;
    class Unit extends Service {
      constructor() {
        super();
        seen = this.config;
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    class Provider extends Service {
      constructor() {
        super();
        this.provide(IFoo, Unit, { config: 42 });
      }
    }
    ix.provide(IBar, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IBar));
    ix.invokeFunction((a) => a.get(IFoo));
    expect(seen).toBe(42);
    ix.dispose();
  });

  it('supports on() over a direct Emitter and over the event resolver', () => {
    const seen: string[] = [];
    const emitter = new Emitter<string>();
    class Unit extends Service {
      constructor() {
        super();
        this.on(emitter, (e) => seen.push(`emitter:${e}`));
        this.on('domain.event', (e) => seen.push(`bus:${e}`));
      }
    }
    setFiberEventResolver((_host, event, handler) => {
      seen.push(`resolver:subscribed:${event}`);
      handler('payload');
      return { dispose: () => seen.push('resolver:disposed') };
    });
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IBar));
    emitter.fire('x');
    expect(seen).toContain('emitter:x');
    expect(seen).toContain('resolver:subscribed:domain.event');
    expect(seen).toContain('bus:payload');
    ix.unprovide(IBar);
    expect(seen).toContain('resolver:disposed');
    emitter.dispose();
    ix.dispose();
  });

  it('provides a pre-materialized instance for a token, anchored to the unit', () => {
    const foo = new Foo();
    class Provider extends Service {
      constructor() {
        super();
        this.provide(IFoo, foo);
      }
    }
    const IProvider = createDecorator<Provider>('service-instance-provider');
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IProvider, new SyncDescriptor(Provider));
    ix.invokeFunction((a) => a.get(IProvider));
    expect(ix.invokeFunction((a) => a.get(IFoo))).toBe(foo);
    ix.unprovide(IProvider);
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    ix.dispose();
  });

  it('mints one ScopeUnits token per scope kind', () => {
    expect(ScopeUnits('agent')).toBe(ScopeUnits('agent'));
    expect(ScopeUnits('agent')).not.toBe(ScopeUnits('session'));
    expect(String(ScopeUnits('agent'))).toBe('collection:scope-units:agent');
  });
});
