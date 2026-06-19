import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/di/descriptors';
import { CyclicDependencyError } from '#/di/errors';
import { InstantiationService } from '#/di/instantiationService';
import { createDecorator, type ServicesAccessor } from '#/di/instantiation';
import { ServiceCollection } from '#/di/serviceCollection';

/**
 * Cycle-detection tests trigger cycles by capturing the accessor (or the
 * container) inside the ctor body and synchronously calling `.get(peer)` —
 * this is the only way to express a circular runtime dependency until
 * ctor-arg `@IFoo` decorators land in a later phase.
 *
 * The accessor used in the ctor must be the same accessor object passed by
 * the outer `invokeFunction` so the tree-wide in-progress stack is shared.
 */

describe('Cyclic dependency detection', () => {
  it('direct self-cycle A → A throws CyclicDependencyError', () => {
    interface IA {
      tag: 'A';
    }
    const IA = createDecorator<IA>('A');
    // Capture the outer accessor inside the ctor by stashing it on a
    // class-static. The ctor calls accessor.get(IA) synchronously.
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

  it('stack is unwound after a successful resolution (no false-positive on a later get)', () => {
    interface ITagged {
      tag: string;
    }
    const IA = createDecorator<ITagged>('A');
    const IB = createDecorator<ITagged>('B');
    let accessorRef: ServicesAccessor | undefined;
    class A implements ITagged {
      tag = 'A';
    }
    class B implements ITagged {
      tag = 'B';
      constructor() {
        // Constructs A — A finishes, then we keep going.
        accessorRef!.get(IA);
      }
    }
    const ix = new InstantiationService(
      new ServiceCollection([IA, new SyncDescriptor(A)], [IB, new SyncDescriptor(B)]),
    );
    expect(() =>
      ix.invokeFunction((a) => {
        accessorRef = a;
        a.get(IB);
        // Stack must be empty now; a second resolution must not falsely
        // detect "A is in progress".
        a.get(IA);
        return null;
      }),
    ).not.toThrow();
  });

  it('cycle across parent/child boundary is detected (parent has A→B, child has B→A)', () => {
    interface IA {
      tag: 'A';
    }
    interface IB {
      tag: 'B';
    }
    const IA = createDecorator<IA>('A');
    const IB = createDecorator<IB>('B');
    let accessorRef: ServicesAccessor | undefined;

    // A is registered in parent; A's ctor depends on B.
    class A implements IA {
      tag = 'A' as const;
      constructor() {
        accessorRef!.get(IB);
      }
    }
    // B is registered in CHILD; B's ctor depends on A — completing the cycle
    // across the parent boundary.
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

  it('stack is unwound even when construction throws (next resolution sees a clean stack)', () => {
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
    // No false cycle: Boom is fully unwound from the in-progress stack.
    expect(() => ix.invokeFunction((a) => a.get(IFine))).not.toThrow();
  });
});
