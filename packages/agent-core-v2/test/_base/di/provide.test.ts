import { describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { AvailabilityChange } from '#/_base/di/serviceCollection';

interface IFoo {
  tag: string;
}
const IFoo = createDecorator<IFoo>('provide-foo');

interface IBar {
  tag: string;
}
const IBar = createDecorator<IBar>('provide-bar');

class Foo implements IFoo, IDisposable {
  tag = 'foo';
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
}

class Bar implements IBar {
  tag = 'bar';
  constructor(@IFoo public readonly foo: IFoo) {}
}

describe('InstantiationService.provide/unprovide (L1)', () => {
  it('provides a service at runtime and resolves it', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo));
    expect(foo).toBeInstanceOf(Foo);
    ix.dispose();
  });

  it('unprovide removes the token; strict resolution then throws', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.invokeFunction((a) => a.get(IFoo));
    ix.unprovide(IFoo);
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    ix.dispose();
  });

  it('unprovide retires the materialized instance', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    expect(foo.disposed).toBe(false);
    ix.unprovide(IFoo);
    expect(foo.disposed).toBe(true);
    ix.dispose();
  });

  it('reprovide retires the old generation and resolves a fresh instance', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const first = ix.invokeFunction((a) => a.get(IFoo)) as Foo;

    ix.provide(IFoo, new SyncDescriptor(Foo));
    expect(first.disposed).toBe(true);

    const second = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    ix.dispose();
    expect(second.disposed).toBe(true);
  });

  it('stamps every generation with a container-monotonic uid', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const h1 = ix.provide(IFoo, new SyncDescriptor(Foo));
    const h2 = ix.provide(IBar, new SyncDescriptor(Bar));
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const uidAfter = (ix as unknown as { _services: ServiceCollection })._services.uidOf(IFoo)!;
    expect(h2.uid).toBeGreaterThan(h1.uid);
    expect(uidAfter).toBeGreaterThan(h2.uid);
    ix.dispose();
  });

  it('fires availability events with { oldUid, newUid } on provide/unprovide', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const changes: AvailabilityChange[] = [];
    const services = (ix as unknown as { _services: ServiceCollection })._services;
    services.onDidChange(IFoo, (change) => changes.push(change));

    const h1 = ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const uid2 = services.uidOf(IFoo)!;
    ix.unprovide(IFoo);

    expect(changes).toEqual([
      { oldUid: undefined, newUid: h1.uid },
      { oldUid: h1.uid, newUid: uid2 },
      { oldUid: uid2, newUid: undefined },
    ]);
    ix.dispose();
  });

  it('the provide handle is a ledger entry: disposing it unprovides', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    const handle = ix.provide(IFoo, new SyncDescriptor(Foo));
    handle.dispose();
    expect(() => ix.invokeFunction((a) => a.get(IFoo))).toThrow(/unknown service/);
    ix.dispose();
  });

  it('container teardown retires provided services exactly once', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    const foo = ix.invokeFunction((a) => a.get(IFoo)) as Foo;
    let calls = 0;
    const origDispose = foo.dispose.bind(foo);
    foo.dispose = () => {
      calls += 1;
      origDispose();
    };
    ix.dispose();
    expect(calls).toBe(1);
  });
});

describe('persistent dependency graph (L2 substrate)', () => {
  it('records constructor-injection edges for materialized services', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const edges = ix.dependencyGraph.edges();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      consumer: { scope: ix, token: IBar },
      dependency: { scope: ix, token: IFoo },
      kind: 'instance',
    });
    ix.dispose();
  });

  it('affectedSet computes the transitive dependents of a changed token', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const tokens = (refs: readonly { token: unknown }[]): unknown[] =>
      refs.map((ref) => ref.token);
    expect(tokens(ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]))).toEqual([IFoo, IBar]);
    expect(tokens(ix.dependencyGraph.affectedSet([{ scope: ix, token: IBar }]))).toEqual([IBar]);
    ix.dispose();
  });

  it('orders the affected set: dependents first for teardown, dependencies first for rebuild', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    const affected = ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]);
    const tokens = (refs: readonly { token: unknown }[]): unknown[] =>
      refs.map((ref) => ref.token);
    expect(tokens(ix.dependencyGraph.reverseTopoOrder(affected))).toEqual([IBar, IFoo]);
    expect(tokens(ix.dependencyGraph.topoOrder(affected))).toEqual([IFoo, IBar]);
    ix.dispose();
  });

  it('retiring a consumer removes its edges', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));

    ix.unprovide(IBar);
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    const remaining = ix.dependencyGraph.affectedSet([{ scope: ix, token: IFoo }]);
    expect(remaining.map((ref) => ref.token)).toEqual([IFoo]);
    ix.dispose();
  });

  it('container teardown leaves the graph empty (no dangling edges)', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    ix.provide(IBar, new SyncDescriptor(Bar));
    ix.invokeFunction((a) => a.get(IBar));
    ix.dispose();
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
  });

  it('does not track createInstance products (leaves)', () => {
    const ix = new InstantiationService(new ServiceCollection(), true);
    ix.provide(IFoo, new SyncDescriptor(Foo));
    class Leaf {
      constructor(@IFoo public readonly foo: IFoo) {}
    }
    ix.createInstance(Leaf);
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    ix.dispose();
  });
});

describe('TestInstantiationService.set rerouting', () => {
  it('set() on a materialized token retires the previous generation', async () => {
    const { TestInstantiationService } = await import('#/_base/di/testInstantiationService');
    const ix = new TestInstantiationService(new ServiceCollection(), true);
    ix.set(IFoo, new SyncDescriptor(Foo));
    const first = ix.get(IFoo) as Foo;
    ix.set(IFoo, new SyncDescriptor(Foo));
    expect(first.disposed).toBe(true);
    const second = ix.get(IFoo) as Foo;
    expect(second).not.toBe(first);
    ix.dispose();
  });

  it('set() returns the previous value like before', async () => {
    const { TestInstantiationService } = await import('#/_base/di/testInstantiationService');
    const ix = new TestInstantiationService(new ServiceCollection(), true);
    const seeded = new Foo();
    expect(ix.set(IFoo, seeded)).toBeUndefined();
    expect(ix.set(IFoo, new Foo())).toBe(seeded);
    ix.dispose();
  });
});
