import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import {
  IInstantiationService,
  createDecorator,
  type IInstantiationService as IInstantiationServiceType,
} from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';

interface ILogger {
  log(msg: string): void;
  name: string;
}
const ILogger = createDecorator<ILogger>('logger');

class ConsoleLogger implements ILogger {
  name = 'console';
  log(_m: string): void {}
}
class ChildLogger implements ILogger {
  name = 'child';
  log(_m: string): void {}
}

describe('InstantiationService.createChild', () => {
  it('child inherits parent services', () => {
    const parent = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(ConsoleLogger)]),
    );
    const child = parent.createChild(new ServiceCollection());
    const fromChild = child.invokeFunction((a) => a.get(ILogger));
    expect(fromChild).toBeInstanceOf(ConsoleLogger);

    const fromParent = parent.invokeFunction((a) => a.get(ILogger));
    expect(fromChild).toBe(fromParent);
  });

  it('child shadowing: child registration overrides parent', () => {
    const parent = new InstantiationService(
      new ServiceCollection([ILogger, new SyncDescriptor(ConsoleLogger)]),
    );
    const child = parent.createChild(
      new ServiceCollection([ILogger, new SyncDescriptor(ChildLogger)]),
    );
    const fromChild = child.invokeFunction((a) => a.get(ILogger));
    const fromParent = parent.invokeFunction((a) => a.get(ILogger));
    expect(fromChild).toBeInstanceOf(ChildLogger);
    expect(fromParent).toBeInstanceOf(ConsoleLogger);
    expect(fromChild).not.toBe(fromParent);
  });

  it('constructs parent-owned descriptors in the parent scope when resolved from a child', () => {
    interface IDep {
      tag: string;
    }
    const IDep = createDecorator<IDep>('owner-scope-dep');
    class ParentDep implements IDep {
      tag = 'parent';
    }
    class ChildDep implements IDep {
      tag = 'child';
    }
    class ParentOwned {
      constructor(@IDep public readonly dep: IDep) {}
    }

    const IParentOwned = createDecorator<ParentOwned>('owner-scope-parent-owned');

    const parent = new InstantiationService(
      new ServiceCollection(
        [IDep, new SyncDescriptor(ParentDep)],
        [IParentOwned, new SyncDescriptor(ParentOwned)],
      ),
    );
    const child = parent.createChild(
      new ServiceCollection([IDep, new SyncDescriptor(ChildDep)]),
    );

    const fromChild = child.invokeFunction((a) => a.get(IParentOwned));
    const fromParent = parent.invokeFunction((a) => a.get(IParentOwned));
    expect(fromChild).toBe(fromParent);
    expect(fromChild.dep).toBeInstanceOf(ParentDep);
    expect(fromChild.dep.tag).toBe('parent');
  });

  it('injects the parent instantiation service into parent-owned services resolved from a child', () => {
    class ParentOwned {
      constructor(@IInstantiationService public readonly ix: IInstantiationServiceType) {}
    }
    const IParentOwned = createDecorator<ParentOwned>('owner-scope-parent-ix');

    const parent = new InstantiationService(
      new ServiceCollection([IParentOwned, new SyncDescriptor(ParentOwned)]),
    );
    const child = parent.createChild(new ServiceCollection());

    const instance = child.invokeFunction((a) => a.get(IParentOwned));
    expect(instance.ix).toBe(parent);
    expect(instance.ix).not.toBe(child);
  });

  it('sibling isolation: two children of the same parent do not share scoped services', () => {
    interface IScoped {
      tag: string;
    }
    const IScoped = createDecorator<IScoped>('scoped');
    class ScopedA implements IScoped {
      tag = 'A';
    }
    class ScopedB implements IScoped {
      tag = 'B';
    }

    const parent = new InstantiationService();
    const childA = parent.createChild(
      new ServiceCollection([IScoped, new SyncDescriptor(ScopedA)]),
    );
    const childB = parent.createChild(
      new ServiceCollection([IScoped, new SyncDescriptor(ScopedB)]),
    );

    expect(childA.invokeFunction((a) => a.get(IScoped).tag)).toBe('A');
    expect(childB.invokeFunction((a) => a.get(IScoped).tag)).toBe('B');

    expect(parent.invokeFunction((a) => a.get(IScoped))).toBeUndefined();
  });

  it('dispose order: A→B→C construction yields C→B→A teardown', () => {
    const events: string[] = [];
    interface ITagged {
      tag: string;
    }
    const IA = createDecorator<ITagged>('A');
    const IB = createDecorator<ITagged>('B');
    const IC = createDecorator<ITagged>('C');
    class A implements ITagged, IDisposable {
      tag = 'A';
      dispose(): void {
        events.push('disposed A');
      }
    }
    class B implements ITagged, IDisposable {
      tag = 'B';
      dispose(): void {
        events.push('disposed B');
      }
    }
    class C implements ITagged, IDisposable {
      tag = 'C';
      dispose(): void {
        events.push('disposed C');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(A)],
        [IB, new SyncDescriptor(B)],
        [IC, new SyncDescriptor(C)],
      ),
    );
    ix.invokeFunction((a) => {
      a.get(IA);
      a.get(IB);
      a.get(IC);
    });
    ix.dispose();
    expect(events).toEqual(['disposed C', 'disposed B', 'disposed A']);
  });

  it('does not dispose pre-built service instances from the ServiceCollection', () => {
    const events: string[] = [];
    interface IFoo {
      tag: string;
    }
    const IFoo = createDecorator<IFoo>('prebuilt-not-disposed');
    class Foo implements IFoo, IDisposable {
      tag = 'foo';
      dispose(): void {
        events.push('disposed');
      }
    }
    const instance = new Foo();
    const ix = new InstantiationService(new ServiceCollection([IFoo, instance]));
    expect(ix.invokeFunction((a) => a.get(IFoo))).toBe(instance);
    ix.dispose();
    expect(events).toEqual([]);
  });

  it('idempotent dispose: second call is a no-op', () => {
    const events: string[] = [];
    interface IFoo {
      tag: string;
    }
    const IFoo = createDecorator<IFoo>('foo');
    class Foo implements IFoo, IDisposable {
      tag = 'foo';
      dispose(): void {
        events.push('disposed');
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([IFoo, new SyncDescriptor(Foo)]),
    );
    ix.invokeFunction((a) => a.get(IFoo));
    ix.dispose();
    ix.dispose();
    expect(events).toEqual(['disposed']);
  });

  it('parent dispose propagates to children', () => {
    const events: string[] = [];
    interface IParentSvc {
      tag: string;
    }
    interface IChildSvc {
      tag: string;
    }
    const IParentSvc = createDecorator<IParentSvc>('parentSvc');
    const IChildSvc = createDecorator<IChildSvc>('childSvc');
    class ParentSvc implements IParentSvc, IDisposable {
      tag = 'parent';
      dispose(): void {
        events.push('disposed parent svc');
      }
    }
    class ChildSvc implements IChildSvc, IDisposable {
      tag = 'child';
      dispose(): void {
        events.push('disposed child svc');
      }
    }

    const parent = new InstantiationService(
      new ServiceCollection([IParentSvc, new SyncDescriptor(ParentSvc)]),
    );
    const child = parent.createChild(
      new ServiceCollection([IChildSvc, new SyncDescriptor(ChildSvc)]),
    );

    parent.invokeFunction((a) => a.get(IParentSvc));
    child.invokeFunction((a) => a.get(IChildSvc));

    parent.dispose();

    expect(events).toEqual(['disposed child svc', 'disposed parent svc']);
  });

  it('disposing a child clears it from parent so parent.dispose does not double-dispose', () => {
    const events: string[] = [];
    interface ISvc {
      tag: string;
    }
    const ISvc = createDecorator<ISvc>('svc');
    class Svc implements ISvc, IDisposable {
      tag = 'svc';
      dispose(): void {
        events.push('disposed');
      }
    }

    const parent = new InstantiationService();
    const child = parent.createChild(
      new ServiceCollection([ISvc, new SyncDescriptor(Svc)]),
    );
    child.invokeFunction((a) => a.get(ISvc));
    child.dispose();
    parent.dispose();
    expect(events).toEqual(['disposed']);
  });

  it('use-after-dispose: invokeFunction / createInstance / createChild throw', () => {
    const ix = new InstantiationService();
    ix.dispose();
    expect(() => {
      ix.invokeFunction((_a) => undefined);
    }).toThrowError(/disposed/);
    expect(() => {
      ix.createInstance(class A {
        value = 'a';
      });
    }).toThrowError(/disposed/);
    expect(() => {
      ix.createChild(new ServiceCollection());
    }).toThrowError(/disposed/);
  });

  it('parent singleton is created once regardless of parent/child resolution order', () => {
    interface ISvc {
      tag: string;
    }
    const ISvc = createDecorator<ISvc>('child-ctor-counter-svc');

    let count = 0;
    class CtorCounter1 implements ISvc {
      tag = 'svc';
      constructor() {
        count += 1;
      }
    }
    let parent = new InstantiationService(
      new ServiceCollection([ISvc, new SyncDescriptor(CtorCounter1)]),
    );
    parent.invokeFunction((a) => a.get(ISvc));
    let child = parent.createChild(new ServiceCollection());
    child.invokeFunction((a) => a.get(ISvc));
    expect(count).toBe(1);
    parent.dispose();

    count = 0;
    class CtorCounter2 implements ISvc {
      tag = 'svc';
      constructor() {
        count += 1;
      }
    }
    parent = new InstantiationService(
      new ServiceCollection([ISvc, new SyncDescriptor(CtorCounter2)]),
    );
    child = parent.createChild(new ServiceCollection());
    parent.invokeFunction((a) => a.get(ISvc));
    child.invokeFunction((a) => a.get(ISvc));
    expect(count).toBe(1);
    parent.dispose();
  });

  it('disposing a child leaves the parent usable', () => {
    interface IB {
      value: number;
    }
    const IB = createDecorator<IB>('child-dispose-leaves-parent-B');
    class BImpl implements IB {
      value = 1;
    }

    const parent = new InstantiationService(new ServiceCollection([IB, new BImpl()]));
    const child = parent.createChild(new ServiceCollection());

    expect(parent.invokeFunction((a) => a.get(IB).value)).toBe(1);
    expect(child.invokeFunction((a) => a.get(IB).value)).toBe(1);

    child.dispose();

    expect(parent.invokeFunction((a) => a.get(IB).value)).toBe(1);
    expect(() => child.invokeFunction((a) => a.get(IB))).toThrow(/disposed/);

    parent.dispose();
  });
});

describe('Disposable base class', () => {
  it('insertion order on dispose', () => {
    const events: string[] = [];
    class Child implements IDisposable {
      constructor(public readonly label: string) {}
      dispose(): void {
        events.push(`disposed ${this.label}`);
      }
    }
    class Owner extends Disposable {
      constructor() {
        super();
        this._register(new Child('first'));
        this._register(new Child('second'));
        this._register(new Child('third'));
      }
    }
    const o = new Owner();
    o.dispose();
    expect(events).toEqual(['disposed first', 'disposed second', 'disposed third']);
  });

  it('idempotent dispose on the base class', () => {
    const events: string[] = [];
    class Child implements IDisposable {
      dispose(): void {
        events.push('disposed');
      }
    }
    class Owner extends Disposable {
      constructor() {
        super();
        this._register(new Child());
      }
    }
    const o = new Owner();
    o.dispose();
    o.dispose();
    expect(events).toEqual(['disposed']);
  });

  it('register-after-dispose: child is torn down immediately, not leaked', () => {
    const events: string[] = [];
    class Child implements IDisposable {
      dispose(): void {
        events.push('disposed');
      }
    }
    class Owner extends Disposable {
      addLate(): void {
        this._register(new Child());
      }
    }
    const o = new Owner();
    o.dispose();
    o.addLate();
    expect(events).toEqual(['disposed']);
  });

  it('continues teardown and rethrows if one child throws', () => {
    const events: string[] = [];
    class GoodChild implements IDisposable {
      dispose(): void {
        events.push('good');
      }
    }
    class BadChild implements IDisposable {
      dispose(): void {
        events.push('bad-attempted');
        throw new Error('boom');
      }
    }
    class TailChild implements IDisposable {
      dispose(): void {
        events.push('tail');
      }
    }
    class Owner extends Disposable {
      constructor() {
        super();
        this._register(new GoodChild());
        this._register(new BadChild());
        this._register(new TailChild());
      }
    }
    const o = new Owner();
    expect(() => { o.dispose(); }).toThrow('boom');
    expect(events).toEqual(['good', 'bad-attempted', 'tail']);
  });
});
