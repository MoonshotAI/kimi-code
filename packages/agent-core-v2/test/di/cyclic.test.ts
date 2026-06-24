import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { CyclicDependencyError } from '#/_base/di/errors';
import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';

/**
 * Cycle-detection tests trigger cycles by capturing the accessor (or the
 * container) inside the ctor body and synchronously calling `.get(peer)`.
 */

describe('Cyclic dependency detection', () => {
  it('direct self-cycle A → A throws CyclicDependencyError', () => {
    interface IA {
      tag: 'A';
    }
    const IA = createDecorator<IA>('A');
    let accessorRef: ServicesAccessor | undefined;
    class A implements IA {
      tag = 'A' as const;
      constructor() {
        accessorRef!.get(IA);
      }
    }
    const ix = new InstantiationService(new ServiceCollection([IA, new SyncDescriptor(A)]));
    expect(() =>
      ix.invokeFunction((a) => {
        accessorRef = a;
        return a.get(IA);
      }),
    ).toThrowError(CyclicDependencyError);
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
    let accessorRef: ServicesAccessor | undefined;
    class A implements IA {
      tag = 'A' as const;
      constructor() {
        accessorRef!.get(IB);
      }
    }
    class B implements IB {
      tag = 'B' as const;
      constructor() {
        accessorRef!.get(IA);
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(A)], [IB, new SyncDescriptor(B)]),
    );

    let captured: CyclicDependencyError | undefined;
    try {
      ix.invokeFunction((a) => {
        accessorRef = a;
        return a.get(IA);
      });
    } catch (e) {
      captured = e as CyclicDependencyError;
    }
    expect(captured).toBeInstanceOf(CyclicDependencyError);
    expect(captured!.path).toEqual(['A', 'B', 'A']);
    expect(captured!.message).toContain('A → B → A');
  });

  it('no-cycle chain A → B → C constructs cleanly', () => {
    interface ITagged {
      tag: string;
    }
    const IA = createDecorator<ITagged>('A');
    const IB = createDecorator<ITagged>('B');
    const IC = createDecorator<ITagged>('C');
    let accessorRef: ServicesAccessor | undefined;
    class C implements ITagged {
      tag = 'C';
    }
    class B implements ITagged {
      tag = 'B';
      constructor() {
        accessorRef!.get(IC);
      }
    }
    class A implements ITagged {
      tag = 'A';
      constructor() {
        accessorRef!.get(IB);
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection(
        [IA, new SyncDescriptor(A)],
        [IB, new SyncDescriptor(B)],
        [IC, new SyncDescriptor(C)],
      ),
    );
    expect(() =>
      ix.invokeFunction((a) => {
        accessorRef = a;
        return a.get(IA);
      }),
    ).not.toThrow();
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
    let accessorRef: ServicesAccessor | undefined;

    class A implements IA {
      tag = 'A' as const;
      constructor() {
        accessorRef!.get(IB);
      }
    }
    class B implements IB {
      tag = 'B' as const;
      constructor() {
        accessorRef!.get(IA);
      }
    }

    const parent = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(A)]),
    );
    const child = parent.createChild(new ServiceCollection([IB, new SyncDescriptor(B)]));

    let captured: CyclicDependencyError | undefined;
    try {
      child.invokeFunction((a) => {
        accessorRef = a;
        return a.get(IA);
      });
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
