import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { CyclicDependencyError } from '#/_base/di/errors';
import { IInstantiationService, createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';

describe('@IFoo auto-injection', () => {
  it('pure-service ctor: both @IFoo params resolve from the container', () => {
    interface IBar {
      tag: 'bar';
    }
    interface IBaz {
      tag: 'baz';
    }
    const IBar = createDecorator<IBar>('p1.1-IBar-pure');
    const IBaz = createDecorator<IBaz>('p1.1-IBaz-pure');

    class Bar implements IBar {
      tag = 'bar' as const;
    }
    class Baz implements IBaz {
      tag = 'baz' as const;
    }
    class Foo {
      constructor(
        @IBar public readonly bar: IBar,
        @IBaz public readonly baz: IBaz,
      ) {}
    }
    const IFoo = createDecorator<Foo>('p1.1-IFoo-pure');

    const ix = new InstantiationService(
      new ServiceCollection(
        [IBar, new SyncDescriptor(Bar)],
        [IBaz, new SyncDescriptor(Baz)],
        [IFoo, new SyncDescriptor(Foo)],
      ),
    );
    const foo = ix.invokeFunction((a) => a.get(IFoo));
    expect(foo).toBeInstanceOf(Foo);
    expect(foo.bar).toBeInstanceOf(Bar);
    expect(foo.baz).toBeInstanceOf(Baz);
  });

  it('mixed static prefix + service suffix via createInstance(ctor, ...rest)', () => {
    interface IBaz {
      tag: 'baz';
    }
    const IBaz = createDecorator<IBaz>('p1.1-IBaz-mixed');
    class Baz implements IBaz {
      tag = 'baz' as const;
    }
    class Bar {
      constructor(
        public readonly name: string,
        @IBaz public readonly baz: IBaz,
      ) {}
    }
    const ix = new InstantiationService(
      new ServiceCollection([IBaz, new SyncDescriptor(Baz)]),
    );
    const bar = ix.createInstance(Bar as new (name: string) => Bar, 'hello');
    expect(bar.name).toBe('hello');
    expect(bar.baz).toBeInstanceOf(Baz);
  });

  it('@IInstantiationService self-injection resolves to the OWNING container', () => {
    class Widget {
      constructor(public readonly label: string) {}
    }
    interface IFactoryHost {
      makeWidget(): Widget;
    }
    const IFactoryHost = createDecorator<IFactoryHost>('p1.1-IFactoryHost');
    class FactoryHost implements IFactoryHost {
      constructor(@IInstantiationService private readonly ix: IInstantiationService) {}
      makeWidget(): Widget {
        return this.ix.createInstance(Widget, 'made-by-factory');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([IFactoryHost, new SyncDescriptor(FactoryHost)]),
    );
    const host = ix.invokeFunction((a) => a.get(IFactoryHost));
    const w = host.makeWidget();
    expect(w).toBeInstanceOf(Widget);
    expect(w.label).toBe('made-by-factory');
  });

  it('Graph cycle: A.@IBar + B.@IA throws CyclicDependencyError before any ctor runs', () => {
    interface IA {
      tag: 'A';
    }
    interface IB {
      tag: 'B';
    }
    const IA = createDecorator<IA>('p1.1-cycle-IA');
    const IB = createDecorator<IB>('p1.1-cycle-IB');

    let aCtorRan = false;
    let bCtorRan = false;
    class AImpl implements IA {
      tag = 'A' as const;
      constructor(@IB _b: IB) {
        aCtorRan = true;
      }
    }
    class BImpl implements IB {
      tag = 'B' as const;
      constructor(@IA _a: IA) {
        bCtorRan = true;
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(AImpl)],
        [IB, new SyncDescriptor(BImpl)],
      ),
    );

    let captured: unknown;
    try {
      ix.invokeFunction((a) => a.get(IA));
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(CyclicDependencyError);
    expect((captured as CyclicDependencyError).message).toMatch(
      /cyclic dependency between services/i,
    );
    expect(aCtorRan).toBe(false);
    expect(bCtorRan).toBe(false);
  });

  it('shared dependency: two services inject the same dependency and both get the same instance', () => {
    interface IShared {
      id: number;
    }
    const IShared = createDecorator<IShared>('p1.1-shared');
    interface IUserA {
      dep: IShared;
    }
    interface IUserB {
      dep: IShared;
    }
    const IUserA = createDecorator<IUserA>('p1.1-userA');
    const IUserB = createDecorator<IUserB>('p1.1-userB');

    let sharedCtorCount = 0;
    class SharedImpl implements IShared {
      id = 42;
      constructor() {
        sharedCtorCount += 1;
      }
    }
    class UserAImpl implements IUserA {
      constructor(@IShared public readonly dep: IShared) {}
    }
    class UserBImpl implements IUserB {
      constructor(@IShared public readonly dep: IShared) {}
    }

    const ix = new InstantiationService(
      new ServiceCollection(
        [IShared, new SyncDescriptor(SharedImpl)],
        [IUserA, new SyncDescriptor(UserAImpl)],
        [IUserB, new SyncDescriptor(UserBImpl)],
      ),
    );
    const a = ix.invokeFunction((acc) => acc.get(IUserA));
    const b = ix.invokeFunction((acc) => acc.get(IUserB));
    expect(a.dep).toBe(b.dep);
    expect(a.dep.id).toBe(42);
    expect(sharedCtorCount).toBe(1);
  });

  it('deeply nested dependency chain resolves all levels', () => {
    interface ILevel1 { tag: string; }
    interface ILevel2 { tag: string; }
    interface ILevel3 { tag: string; }
    interface ILevel4 { tag: string; }
    const ILevel1 = createDecorator<ILevel1>('p1.1-chain-l1');
    const ILevel2 = createDecorator<ILevel2>('p1.1-chain-l2');
    const ILevel3 = createDecorator<ILevel3>('p1.1-chain-l3');
    const ILevel4 = createDecorator<ILevel4>('p1.1-chain-l4');

    class Level4 implements ILevel4 { tag = 'L4'; }
    class Level3 implements ILevel3 {
      tag = 'L3';
      constructor(@ILevel4 public readonly d4: ILevel4) {}
    }
    class Level2 implements ILevel2 {
      tag = 'L2';
      constructor(@ILevel3 public readonly d3: ILevel3) {}
    }
    class Level1 implements ILevel1 {
      tag = 'L1';
      constructor(@ILevel2 public readonly d2: ILevel2) {}
    }

    const ix = new InstantiationService(
      new ServiceCollection(
        [ILevel1, new SyncDescriptor(Level1)],
        [ILevel2, new SyncDescriptor(Level2)],
        [ILevel3, new SyncDescriptor(Level3)],
        [ILevel4, new SyncDescriptor(Level4)],
      ),
    );
    const l1 = ix.invokeFunction((a) => a.get(ILevel1));
    expect(l1.tag).toBe('L1');
    expect(l1.d2.tag).toBe('L2');
    expect(l1.d2.d3.tag).toBe('L3');
    expect(l1.d2.d3.d4.tag).toBe('L4');
  });

  it('strict mode throws when resolving an unregistered service', () => {
    interface IUnknown { tag: string; }
    const IUnknown = createDecorator<IUnknown>('p1.1-unknown');
    interface IKnown { tag: string; }
    const IKnown = createDecorator<IKnown>('p1.1-known');
    class Known implements IKnown { tag = 'known'; }

    const ix = new InstantiationService(
      new ServiceCollection([IKnown, new SyncDescriptor(Known)]),
      true,
    );
    expect(() => ix.invokeFunction((a) => a.get(IUnknown))).toThrow();
  });

  it('cross-container Graph cycle: parent A→@IB, child B→@IA throws Cyclic', () => {
    interface IA {
      tag: 'A';
    }
    interface IB {
      tag: 'B';
    }
    const IA = createDecorator<IA>('p1.1-xcycle-IA');
    const IB = createDecorator<IB>('p1.1-xcycle-IB');

    class AImpl implements IA {
      tag = 'A' as const;
      constructor(@IB _b: IB) {}
    }
    class BImpl implements IB {
      tag = 'B' as const;
      constructor(@IA _a: IA) {}
    }
    const parent = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(AImpl)]),
    );
    const child = parent.createChild(
      new ServiceCollection([IB, new SyncDescriptor(BImpl)]),
    );
    expect(() =>
      child.invokeFunction((a) => a.get(IA)),
    ).toThrowError(CyclicDependencyError);
  });
});
