import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { CyclicDependencyError } from '#/_base/di/errors';
import {
  createDecorator,
  IInstantiationService,
  type IInstantiationService as IInstantiationServiceType,
} from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';


describe('Cyclic dependency detection', () => {
  it('direct self-cycle A → A throws CyclicDependencyError', () => {
    interface IA {
      tag: 'A';
    }
    const IA = createDecorator<IA>('A');
    class A implements IA {
      tag = 'A' as const;
      constructor(@IA _self: IA) {}
    }
    const ix = new InstantiationService(new ServiceCollection([IA, new SyncDescriptor(A)]));
    expect(() => ix.invokeFunction((a) => a.get(IA))).toThrowError(CyclicDependencyError);
  });

  it('indirect cycle A → B → A includes both names in `path` in construction order', () => {
    interface IA {
      tag: 'A';
    }
    interface IB {
      tag: 'B';
    }
    const IA = createDecorator<IA>('A');
    const IB = createDecorator<IB>('B');
    class A implements IA {
      tag = 'A' as const;
      constructor(@IB _b: IB) {}
    }
    class B implements IB {
      tag = 'B' as const;
      constructor(@IA _a: IA) {}
    }
    const ix = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(A)], [IB, new SyncDescriptor(B)]),
    );

    let captured: CyclicDependencyError | undefined;
    try {
      ix.invokeFunction((a) => a.get(IA));
    } catch (e) {
      captured = e as CyclicDependencyError;
    }
    expect(captured).toBeInstanceOf(CyclicDependencyError);
    expect(captured!.path).toEqual(['A', 'B', 'A']);
    expect(captured!.message).toMatch(/cyclic dependency between services/i);
  });

  it('no-cycle chain A → B → C constructs cleanly', () => {
    interface ITagged {
      tag: string;
    }
    const IA = createDecorator<ITagged>('A');
    const IB = createDecorator<ITagged>('B');
    const IC = createDecorator<ITagged>('C');
    class C implements ITagged {
      tag = 'C';
    }
    class B implements ITagged {
      tag = 'B';
      constructor(@IC _c: ITagged) {}
    }
    class A implements ITagged {
      tag = 'A';
      constructor(@IB _b: ITagged) {}
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(A)],
        [IB, new SyncDescriptor(B)],
        [IC, new SyncDescriptor(C)],
      ),
    );
    expect(() => ix.invokeFunction((a) => a.get(IA))).not.toThrow();
  });

  it('cycle across parent/child boundary is detected', () => {
    interface IA {
      tag: 'A';
    }
    interface IB {
      tag: 'B';
    }
    const IA = createDecorator<IA>('A');
    const IB = createDecorator<IB>('B');

    class A implements IA {
      tag = 'A' as const;
      constructor(@IB _b: IB) {}
    }
    class B implements IB {
      tag = 'B' as const;
      constructor(@IA _a: IA) {}
    }

    const parent = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(A)]),
    );
    const child = parent.createChild(new ServiceCollection([IB, new SyncDescriptor(B)]));

    let captured: CyclicDependencyError | undefined;
    try {
      child.invokeFunction((a) => a.get(IA));
    } catch (e) {
      captured = e as CyclicDependencyError;
    }
    expect(captured).toBeInstanceOf(CyclicDependencyError);
    expect(captured!.path).toEqual(['A', 'B', 'A']);
  });

  it('stack is unwound even when construction throws', () => {
    interface ITagged {
      tag: string;
    }
    const IBoom = createDecorator<ITagged>('Boom');
    const IFine = createDecorator<ITagged>('Fine');

    class Boom implements ITagged {
      tag = 'boom';
      constructor() {
        throw new Error('intentional');
      }
    }
    class Fine implements ITagged {
      tag = 'fine';
    }

    const ix = new InstantiationService(
      new ServiceCollection([IBoom, new SyncDescriptor(Boom)], [IFine, new SyncDescriptor(Fine)]),
    );

    expect(() => ix.invokeFunction((a) => a.get(IBoom))).toThrowError(/intentional/);
    expect(() => ix.invokeFunction((a) => a.get(IFine))).not.toThrow();
  });
});

describe('Recursive instantiation regression (#105562)', () => {
  it('recursive invokeFunction during construction does not double-create a dependency', () => {
    interface IService1 {
      tag: 's1';
    }
    interface IService2 {
      tag: 's2';
    }
    interface IService21 {
      readonly service1: IService1;
      readonly service2: IService2;
    }
    const IService1 = createDecorator<IService1>('reentrant-s1');
    const IService2 = createDecorator<IService2>('reentrant-s2');
    const IService21 = createDecorator<IService21>('reentrant-s21');

    let service2CtorCount = 0;

    class Service1Impl implements IService1 {
      tag = 's1' as const;
      constructor(@IInstantiationService insta: IInstantiationServiceType) {
        const c = insta.invokeFunction((accessor) => accessor.get(IService2));
        expect(c).toBeTruthy();
      }
    }
    class Service2Impl implements IService2 {
      tag = 's2' as const;
      constructor() {
        service2CtorCount += 1;
      }
    }
    class Service21Impl implements IService21 {
      constructor(
        @IService2 public readonly service2: IService2,
        @IService1 public readonly service1: IService1,
      ) {}
    }

    const insta = new InstantiationService(
      new ServiceCollection(
        [IService1, new SyncDescriptor(Service1Impl)],
        [IService2, new SyncDescriptor(Service2Impl)],
        [IService21, new SyncDescriptor(Service21Impl)],
      ),
    );

    const obj = insta.invokeFunction((accessor) => accessor.get(IService21));
    expect(obj).toBeInstanceOf(Service21Impl);
    expect(obj.service1).toBeInstanceOf(Service1Impl);
    expect(obj.service2).toBeInstanceOf(Service2Impl);
    expect(service2CtorCount).toBe(1);
  });
});

describe('Sync/Async dependency loop', () => {
  interface IA {
    readonly _serviceBrand: undefined;
    doIt(): boolean;
  }
  interface IB {
    readonly _serviceBrand: undefined;
    b(): boolean;
  }

  it('sync re-entrant cycle (via createInstance in ctor) explodes with RECURSIVELY', () => {
    const IA = createDecorator<IA>('loop-sync-A');
    const IB = createDecorator<IB>('loop-sync-B');

    class BConsumer {
      constructor(@IB private readonly b: IB) {}
      doIt(): boolean {
        return this.b.b();
      }
    }
    class AService implements IA {
      readonly _serviceBrand: undefined;
      private readonly prop: BConsumer;
      constructor(@IInstantiationService insta: IInstantiationServiceType) {
        this.prop = insta.createInstance(BConsumer);
      }
      doIt(): boolean {
        return this.prop.doIt();
      }
    }
    class BService implements IB {
      readonly _serviceBrand: undefined;
      constructor(@IA _a: IA) {}
      b(): boolean {
        return true;
      }
    }

    const insta = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(AService)],
        [IB, new SyncDescriptor(BService)],
      ),
      true,
      undefined,
      true,
    );

    let captured: unknown;
    try {
      insta.invokeFunction((accessor) => accessor.get(IA));
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain('RECURSIVELY');
  });

  it('delayed A breaks the synchronous recursion but the cycle is still tracked in the global graph', () => {
    const IA = createDecorator<IA>('loop-async-A');
    const IB = createDecorator<IB>('loop-async-B');

    class BConsumer {
      constructor(@IB private readonly b: IB) {}
      doIt(): boolean {
        return this.b.b();
      }
    }
    class AService implements IA {
      readonly _serviceBrand: undefined;
      private readonly prop: BConsumer;
      constructor(@IInstantiationService insta: IInstantiationServiceType) {
        this.prop = insta.createInstance(BConsumer);
      }
      doIt(): boolean {
        return this.prop.doIt();
      }
    }
    class BService implements IB {
      readonly _serviceBrand: undefined;
      constructor(@IA _a: IA) {}
      b(): boolean {
        return true;
      }
    }

    const insta = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(AService, [], true)],
        [IB, new SyncDescriptor(BService, [])],
      ),
      true,
      undefined,
      true,
    );

    const a = insta.invokeFunction((accessor) => accessor.get(IA));
    expect(a.doIt()).toBe(true);

    const cycle = insta._globalGraph?.findCycleSlow();
    expect(cycle).toBe('loop-async-A -> loop-async-B -> loop-async-A');
  });
});
