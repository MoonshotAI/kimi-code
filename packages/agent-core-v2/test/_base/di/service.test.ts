import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { collection, type CollectionView } from '#/_base/di/collection';
import { Emitter } from '#/_base/event';
import {
  createFacadeToken,
  ref as vueRef,
  useCleanup,
  useCollectionView,
  useExpose,
  useInject,
  useLiveRef,
  useMounted,
  useReady,
  watchEffect,
  type ShallowRef,
} from '#/_base/composition-api/index';
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

const IFooValues = collection<IFoo>('service-foo-values');
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('Service — kernel construction protocol (L3)', () => {
  afterEach(() => {
    setFiberEventResolver(undefined);
  });

  it('flushes buffered capability calls before setup and owns reactive effects', async () => {
    const order: string[] = [];
    const source = vueRef(0);
    const facade = createFacadeToken<string>('service-setup-facade');
    class Unit extends Service {
      constructor(@IFooValues private readonly values: CollectionView<IFoo>) {
        super();
        this.effect(() => {
          order.push('effect-a');
          return undefined;
        });
        this.provide(IFoo, Foo);
        this.provide(IFooValues, { tag: 'foo' });
        this.effect(() => {
          order.push('effect-b');
          return undefined;
        });
      }

      override setup(): void {
        order.push('setup');
        const values = useCollectionView(this.values);
        watchEffect(() => {
          order.push(`watch:${source.value}:${values.value.map((value) => value.tag).join(',')}`);
        });
        useExpose(facade, 'ready');
        const exposed = useInject(facade);
        useMounted(() => {
          order.push(`facade:${exposed.value}`);
        });
        useCleanup(() => {
          order.push('cleanup');
        });
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Unit));
    ix.invokeFunction((a) => a.get(IBar));
    expect(order).toEqual(['effect-a', 'effect-b', 'setup', 'watch:0:foo', 'facade:ready']);
    expect(ix.invokeFunction((a) => a.get(IFoo)).tag).toBe('foo');
    expect(ix.compositionRootNode().resolve(facade)).toBe('ready');
    const child = ix.createChild(new ServiceCollection()) as InstantiationService;
    expect(child.compositionRootNode().parent).toBe(ix.compositionRootNode());
    let reentrantDeliveries = 0;
    ix.compositionRootNode().listen('test.once', () => {
      reentrantDeliveries += 1;
      ix.compositionRootNode().fire({ type: 'test.once' });
    }, { once: true });
    ix.compositionRootNode().fire({ type: 'test.once' });
    expect(reentrantDeliveries).toBe(1);

    source.value = 1;
    const withdraw = ix.fiberHost.addCollectionRecord(IFooValues, 'late', ix.ledger, { tag: 'late' });
    await flush();
    expect(order.at(-1)).toBe('watch:1:foo,late');
    withdraw();
    await flush();
    expect(order.at(-1)).toBe('watch:1:foo');

    ix.unprovide(IBar);
    await flush();
    expect(order.at(-1)).toBe('cleanup');
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    const settled = order.length;
    source.value = 2;
    await flush();
    expect(order).toHaveLength(settled);
    await ix.disposeAsync();
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

  it('keeps manually newed instances outside the container runtime', () => {
    let setups = 0;
    class Unit extends Service {
      override setup(): void {
        setups += 1;
      }
    }
    const unit = new Unit();
    expect(setups).toBe(0);
    expect(() => unit.provide(IFoo, Foo)).toThrow(/no unit runtime/);
    expect(() => unit.effect(() => undefined)).toThrow(/no unit runtime/);
    expect(() => unit.on('x', () => {})).toThrow(/no unit runtime/);
    expect(() => unit.get(IFoo)).toThrow(/no unit runtime/);
    expect(() => unit.ref(IFoo)).toThrow(/no unit runtime/);

    class Inner extends Service {
      override setup(): void {
        setups += 1;
      }
    }
    class Outer extends Service {
      readonly inner = new Inner();
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IBar, new SyncDescriptor(Outer));
    const outer = ix.invokeFunction((a) => a.get(IBar)) as unknown as Outer;
    expect(() => outer.inner.effect(() => undefined)).toThrow(/no unit runtime/);
    expect(setups).toBe(0);
    ix.dispose();
  });

  it('rethrows setup failures, rolls back buffered resources, and retires async failures through Cascade', async () => {
    let syncConstructions = 0;
    class SyncFailure extends Service {
      constructor() {
        super();
        syncConstructions += 1;
        this.provide(IFoo, Foo);
        this.provide(IFooValues, { tag: 'leaked' });
      }

      override setup(): void {
        throw new Error('setup-sync');
      }
    }
    const ix = new InstantiationService(new ServiceCollection(), true);
    let releaseCascade!: () => void;
    const cascadeGate = new Promise<void>((resolve) => {
      releaseCascade = resolve;
    });
    let cascadeBlocked = true;
    ix.cascade.configure({
      onWillCascade: () => (cascadeBlocked ? cascadeGate : undefined),
    });
    const IBlocker = createDecorator<Foo>('service-blocked-cascade');
    const IUnrelated = createDecorator<Foo>('service-unrelated-queued-provide');
    ix.provide(IBlocker, new SyncDescriptor(Foo));
    expect(ix.cascade.isInFlight(IBlocker)).toBe(true);
    ix.provide(IUnrelated, new SyncDescriptor(Foo));
    expect(ix.cascade.stateOf(IUnrelated)).toBeUndefined();
    expect(() => ix.createInstance(SyncFailure)).toThrow('setup-sync');
    expect(syncConstructions).toBe(1);
    expect(ix.cascade.isInFlight(IBlocker)).toBe(true);
    expect(ix.cascade.stateOf(IUnrelated)).toBeUndefined();
    cascadeBlocked = false;
    releaseCascade();
    await ix.cascade.whenIdle();
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    expect(ix.fiberHost.collectionView(IFooValues).items).toEqual([]);
    expect(ix.invokeFunction((a) => a.get(IBlocker))).toBeInstanceOf(Foo);
    expect(ix.invokeFunction((a) => a.get(IUnrelated))).toBeInstanceOf(Foo);
    expect(ix.cascade.stateOf(IUnrelated)).toBe('Active');

    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupCalls = 0;
    class AsyncFailure extends Service {
      override setup(): void {
        useCleanup(() => {
          cleanupCalls += 1;
          return cleanup;
        });
        useReady(Promise.reject(new Error('setup-async')));
      }
    }
    class Dependent extends Service {
      constructor(@IFoo public readonly foo: IFoo) {
        super();
      }
    }
    const IDependent = createDecorator<Dependent>('service-async-dependent');
    const services = (ix as unknown as { _services: ServiceCollection })._services;
    const failureAvailabilityStates: Array<string | undefined> = [];
    services.onDidChange(IFoo, () => {
      failureAvailabilityStates.push(ix.cascade.stateOf(IFoo));
    });
    ix.provide(IFoo, new SyncDescriptor(AsyncFailure));
    ix.provide(IDependent, new SyncDescriptor(Dependent));
    const dependent = ix.invokeFunction((a) => a.get(IDependent));
    await flush();
    expect(services.get(IFoo)).toBeInstanceOf(SyncDescriptor);
    expect(services.get(IDependent)).toBeInstanceOf(SyncDescriptor);
    expect(ix.fiberHost.materializedInstance(IFoo)).toBeUndefined();
    expect(ix.cascade.stateOf(IFoo)).toBe('Failed');
    expect(ix.cascade.stateOf(IDependent)).toBe('Pending');
    expect(failureAvailabilityStates.at(-1)).toBe('Failed');
    expect(cleanupCalls).toBe(1);

    releaseCleanup();
    await ix.cascade.whenIdle();
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow('setup-async');
    ix.provide(IFoo, new SyncDescriptor(Foo));
    expect(ix.invokeFunction((a) => a.get(IDependent))).not.toBe(dependent);
    await ix.disposeAsync();

    let anonymous: FiberHandle | undefined;
    class AnonymousFailure extends Service {
      override setup(): void {
        useReady(Promise.reject(new Error('anonymous-async')));
      }
    }
    class Provider extends Service {
      constructor() {
        super();
        anonymous = this.provide(AnonymousFailure);
      }
    }
    const IProvider = createDecorator<Provider>('service-anonymous-failure-provider');
    const ix2 = new InstantiationService(new ServiceCollection(), true);
    ix2.provide(IProvider, new SyncDescriptor(Provider));
    ix2.invokeFunction((a) => a.get(IProvider));
    await flush();
    expect(anonymous!.state).toBe(FiberState.Failed);
    await expect(anonymous!).rejects.toThrow('anonymous-async');
    await ix2.disposeAsync();
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
      vueFooRef: Readonly<ShallowRef<IFoo | undefined>> | undefined;
      constructor(@ref(IFoo) public readonly fooRef: LiveRef<IFoo>) {
        super();
      }
      override setup(): void {
        this.vueFooRef = useLiveRef(this.fooRef);
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
    expect(consumer.vueFooRef?.value).toBeUndefined();
    const provideHandle = ix.provide(IFoo, new SyncDescriptor(Foo));
    expect(consumer.fooRef.current?.tag).toBe('foo');
    expect(consumer.vueFooRef?.value?.tag).toBe('foo');
    provideHandle.dispose();
    expect(consumer.fooRef.current).toBeUndefined();
    expect(consumer.vueFooRef?.value).toBeUndefined();
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

  it('awaits deferred cleanup before rebuilding a token unit with new config', async () => {
    const configs: unknown[] = [];
    const units: Service[] = [];
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleanupCalls = 0;
    class Unit extends Service {
      constructor() {
        super();
        configs.push(this.config);
        units.push(this);
      }

      override setup(): void {
        useCleanup(() => {
          cleanupCalls += 1;
          return cleanup;
        });
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
    const services = (ix as unknown as { _services: ServiceCollection })._services;
    const retirementAvailabilityStates: Array<string | undefined> = [];
    services.onDidChange(IFoo, () => {
      retirementAvailabilityStates.push(ix.cascade.stateOf(IFoo));
    });
    const update = handle!.update({ v: 2 });
    await flush();
    expect(cleanupCalls).toBe(1);
    expect(configs).toEqual([{ v: 1 }]);
    expect(retirementAvailabilityStates).toEqual(['Unloading']);
    const repeatedDisposal = ix.fiberHost.disposeService(units[0]!);
    expect(repeatedDisposal).toBeInstanceOf(Promise);
    let repeatedSettled = false;
    const repeated = Promise.resolve(repeatedDisposal).then(() => {
      repeatedSettled = true;
    });
    await flush();
    expect(repeatedSettled).toBe(false);
    releaseCleanup();
    await Promise.all([update, repeated]);
    expect(repeatedSettled).toBe(true);
    expect(configs).toEqual([{ v: 1 }, { v: 2 }]);
    expect(units).toHaveLength(2);
    await ix.disposeAsync();
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
