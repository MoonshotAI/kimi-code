import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { CyclicDependencyError } from '#/di/errors';
import { InstantiationService } from '#/di/instantiationService';
import { IInstantiationService, createDecorator } from '#/di/instantiation';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * P1.1 — `@IFoo` constructor-parameter auto-injection.
 *
 * The container now reads `_util.getServiceDependencies(ctor)` and resolves
 * each entry against the container before constructing. Static (non-service)
 * arguments come first; service args are appended in decorator-position order.
 *
 * Vitest/rolldown does not parse TypeScript parameter decorators in test
 * files, so we apply them manually at runtime — same pattern as
 * `decorator.test.ts`. This is functionally identical to the TS-emitted form
 * `__metadata`/`__param` would produce: the decorator factory writes
 * `$di$dependencies` metadata onto the ctor, which is what the container
 * consumes.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function param(dec: any, target: any, index: number): void {
  (dec as (t: unknown, k: string, i: number) => void)(target, '', index);
}

describe('@IFoo auto-injection (P1.1)', () => {
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
        public readonly bar: IBar,
        public readonly baz: IBaz,
      ) {}
    }
    param(IBar, Foo, 0);
    param(IBaz, Foo, 1);
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
        public readonly baz: IBaz,
      ) {}
    }
    param(IBaz, Bar, 1);
    const ix = new InstantiationService(
      new ServiceCollection([IBaz, new SyncDescriptor(Baz)]),
    );
    const bar = ix.createInstance(Bar as new (name: string) => Bar, 'hello');
    expect(bar.name).toBe('hello');
    expect(bar.baz).toBeInstanceOf(Baz);
  });

  it('@IInstantiationService self-injection resolves to the OWNING container', () => {
    // Direct check of the self-register invariant (Phase 0 reviewer note #4):
    // the ctor must receive the live container.
    class Widget {
      constructor(public readonly label: string) {}
    }
    interface IFactoryHost {
      makeWidget(): Widget;
    }
    const IFactoryHost = createDecorator<IFactoryHost>('p1.1-IFactoryHost');
    class FactoryHost implements IFactoryHost {
      constructor(private readonly ix: IInstantiationService) {}
      makeWidget(): Widget {
        return this.ix.createInstance(Widget, 'made-by-factory');
      }
    }
    param(IInstantiationService, FactoryHost, 0);
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
      constructor(_b: IB) {
        aCtorRan = true;
      }
    }
    class BImpl implements IB {
      tag = 'B' as const;
      constructor(_a: IA) {
        bCtorRan = true;
      }
    }
    param(IB, AImpl, 0);
    param(IA, BImpl, 0);
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
    // Graph form: message comes from `findCycleSlow()`.
    expect((captured as CyclicDependencyError).message).toMatch(
      /cyclic dependency between services/i,
    );
    // No ctor body should have run (the Graph walk catches it statically).
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
      constructor(_b: IB) {}
    }
    class BImpl implements IB {
      tag = 'B' as const;
      constructor(_a: IA) {}
    }
    param(IB, AImpl, 0);
    param(IA, BImpl, 0);
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
