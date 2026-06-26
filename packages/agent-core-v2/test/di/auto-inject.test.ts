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
