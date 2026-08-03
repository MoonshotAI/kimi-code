import { afterEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { CascadeConflictError } from '#/_base/di/errors';
import { createDecorator } from '#/_base/di/instantiation';
import { InstantiationService } from '#/_base/di/instantiationService';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import type { Ledger } from '#/_base/lifecycle/ledger';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res as (value?: T | PromiseLike<T>) => void;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function ledgerOf(ix: InstantiationService): Ledger {
  return (ix as unknown as { _ledger: Ledger })._ledger;
}

/** Flush all pending microtask chains (async teardown hops). */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ------------------------------------------------------------------ fixtures

interface IRoot {
  label: string;
}
const IRoot = createDecorator<IRoot>('cascade-root');

interface IMid {
  root: IRoot;
}
const IMid = createDecorator<IMid>('cascade-mid');

interface ILeaf {
  mid: IMid;
}
const ILeaf = createDecorator<ILeaf>('cascade-leaf');

interface IExtra {
  label: string;
}
const IExtra = createDecorator<IExtra>('cascade-extra');

/** Shared per-test event log; fixtures push construct/dispose events. */
let events: string[] = [];

class Root implements IRoot {
  label = 'root';
  constructor(public readonly tag = 'root') {
    events.push(`+${this.tag}`);
  }
  dispose(): void {
    events.push(`-${this.tag}`);
  }
}

class Mid implements IMid {
  constructor(@IRoot public readonly root: IRoot) {
    events.push('+mid');
  }
  dispose(): void {
    events.push('-mid');
  }
}

class Leaf implements ILeaf {
  constructor(@IMid public readonly mid: IMid) {
    events.push('+leaf');
  }
  dispose(): void {
    events.push('-leaf');
  }
}

class Extra implements IExtra {
  label = 'extra';
  constructor() {
    events.push('+extra');
  }
  dispose(): void {
    events.push('-extra');
  }
}

function makeContainer(strict = true): InstantiationService {
  return new InstantiationService(new ServiceCollection(), strict);
}

function provideChain(ix: InstantiationService): void {
  ix.provide(IRoot, new SyncDescriptor(Root));
  ix.provide(IMid, new SyncDescriptor(Mid));
  ix.provide(ILeaf, new SyncDescriptor(Leaf));
}

afterEach(() => {
  events = [];
});

describe('cascade engine — mechanism matrix', () => {
  it('1. provide X auto-activates dependents from Pending', () => {
    const ix = makeContainer();
    events = [];
    // Dependent provided before its dependency: goes to the waiting area.
    ix.provide(IMid, new SyncDescriptor(Mid));
    expect(ix.cascade.unitState(IMid)).toBe('Pending');
    expect(events).toEqual([]);

    ix.provide(IRoot, new SyncDescriptor(Root));
    expect(ix.cascade.unitState(IRoot)).toBe('Active');
    expect(ix.cascade.unitState(IMid)).toBe('Active');
    expect(events).toEqual(['+root', '+mid']);
    ix.dispose();
  });

  it('2. unprovide X tears transitive dependents down in reverse topo order, back to Pending', () => {
    const ix = makeContainer();
    provideChain(ix);
    events = [];
    const mid = ix.invokeFunction((a) => a.get(IMid)) as Mid;
    const leaf = ix.invokeFunction((a) => a.get(ILeaf)) as Leaf;

    ix.unprovide(IRoot);

    expect(events).toEqual(['-leaf', '-mid', '-root']);
    expect(ix.cascade.unitState(IRoot)).toBeUndefined(); // removed, not a state
    expect(ix.cascade.unitState(IMid)).toBe('Pending');
    expect(ix.cascade.unitState(ILeaf)).toBe('Pending');
    expect(() => ix.invokeFunction((a) => a.get(IRoot))).toThrow(/unknown service/);
    // The waiting area retains recipes with the missing token indexed.
    expect(ix.cascade.pendingSnapshot().get('cascade-mid')).toEqual(['cascade-root']);
    void mid;
    void leaf;
    ix.dispose();
  });

  it('3. re-provide rebuilds the waiting area in topo order with fresh instances', () => {
    const ix = makeContainer();
    provideChain(ix);
    const firstMid = ix.invokeFunction((a) => a.get(IMid));
    const firstLeaf = ix.invokeFunction((a) => a.get(ILeaf));
    ix.unprovide(IRoot);
    events = [];

    ix.provide(IRoot, new SyncDescriptor(Root));

    expect(events).toEqual(['+root', '+mid', '+leaf']);
    const secondMid = ix.invokeFunction((a) => a.get(IMid));
    const secondLeaf = ix.invokeFunction((a) => a.get(ILeaf));
    expect(secondMid).not.toBe(firstMid);
    expect(secondLeaf).not.toBe(firstLeaf);
    expect(secondMid.root).toBe(ix.invokeFunction((a) => a.get(IRoot)));
    ix.dispose();
  });

  it('4. replace is a single transaction: dependents rebuild against the new generation', () => {
    const ix = makeContainer();
    provideChain(ix);
    const firstMid = ix.invokeFunction((a) => a.get(IMid));
    events = [];

    // Replace the root recipe in one transaction.
    class Root2 implements IRoot {
      label = 'root2';
      constructor() {
        events.push('+root2');
      }
      dispose(): void {
        events.push('-root2');
      }
    }
    const historyBefore = ix.cascade.history().length;
    ix.provide(IRoot, new SyncDescriptor(Root2));

    // One transaction covered teardown + rebuild; nothing lingered in Pending.
    expect(ix.cascade.history().length).toBe(historyBefore + 1);
    const entry = ix.cascade.history().at(-1)!;
    expect(entry.tornDown).toEqual(['cascade-leaf', 'cascade-mid', 'cascade-root']);
    expect(entry.rebuilt).toEqual(['cascade-root', 'cascade-mid', 'cascade-leaf']);
    expect(events).toEqual(['-leaf', '-mid', '-root', '+root2', '+mid', '+leaf']);
    expect(ix.cascade.unitState(IMid)).toBe('Active');
    expect(ix.cascade.unitState(ILeaf)).toBe('Active');
    const newMid = ix.invokeFunction((a) => a.get(IMid));
    expect(newMid).not.toBe(firstMid);
    expect(newMid.root).toBeInstanceOf(Root2);
    ix.dispose();
  });

  it('5/6. requests submitted during a cascade queue up and merge their contagion sets', async () => {
    const ix = makeContainer();
    ix.provide(IRoot, new SyncDescriptor(Root));
    ix.provide(IExtra, new SyncDescriptor(Extra));
    const gate = deferred();
    const hookCalls: string[][] = [];
    let calls = 0;
    ix.cascade.configure({
      onWillCascade: (affected) => {
        calls += 1;
        hookCalls.push(affected.map(String));
        // Park only the first transaction at the abort wait.
        return calls === 1 ? gate.promise : undefined;
      },
    });

    const first = ix.cascade.submit({
      action: 'unprovide',
      token: IRoot,
      reason: 'drop root',
    });
    // These two queue behind the in-flight transaction and merge into one.
    const second = ix.cascade.submit({
      action: 'unprovide',
      token: IExtra,
      reason: 'drop extra',
    });
    const third = ix.cascade.submit({
      action: 'provide',
      token: IMid,
      descriptor: new SyncDescriptor(Mid),
      reason: 'add mid',
    });

    // Queued changes are not applied while the first transaction is in flight.
    expect(ix.cascade.isInFlight(IRoot)).toBe(true);
    // A token outside the in-flight contagion set resolves normally.
    expect(ix.invokeFunction((a) => a.get(IExtra))).toBeInstanceOf(Extra);

    gate.resolve();
    await Promise.all([first, second, third]);

    // Three requests, two transactions: the queued two merged (one hook call each).
    expect(calls).toBe(2);
    // (The first two history entries are the initial provides.)
    const history = ix.cascade.history().slice(-2);
    expect(history[0]!.changes).toEqual([{ token: 'cascade-root', action: 'unprovide' }]);
    expect(history[1]!.changes).toEqual([
      { token: 'cascade-extra', action: 'unprovide' },
      { token: 'cascade-mid', action: 'provide' },
    ]);
    expect(ix.cascade.unitState(IExtra)).toBeUndefined();
    // Mid's dependency is gone: it waits.
    expect(ix.cascade.unitState(IMid)).toBe('Pending');
    ix.dispose();
  });

  it('7. construction failure is sticky Failed; update() reloads', () => {
    const ix = makeContainer();
    let shouldThrow = true;
    class Flaky implements IExtra {
      label = 'flaky';
      constructor() {
        if (shouldThrow) {
          throw new Error('ctor boom');
        }
        events.push('+flaky');
      }
    }
    ix.provide(IExtra, new SyncDescriptor(Flaky));
    expect(ix.cascade.unitState(IExtra)).toBe('Failed');
    // Resolving a failed unit rethrows the recorded error.
    expect(() => ix.invokeFunction((a) => a.get(IExtra))).toThrow('ctor boom');

    // A dependent of a Failed unit waits.
    class NeedsExtra {
      constructor(@IExtra public readonly extra: IExtra) {}
    }
    const INeedsExtra = createDecorator<NeedsExtra>('cascade-needs-extra');
    ix.provide(INeedsExtra, new SyncDescriptor(NeedsExtra));
    expect(ix.cascade.unitState(INeedsExtra)).toBe('Pending');

    // Sticky: an unrelated transaction does not retry the failed unit.
    ix.provide(IRoot, new SyncDescriptor(Root));
    expect(ix.cascade.unitState(IExtra)).toBe('Failed');

    // Explicit update() recovers it (and wakes its dependent).
    shouldThrow = false;
    events = [];
    return ix.cascade.update(IExtra).then(() => {
      expect(ix.cascade.unitState(IExtra)).toBe('Active');
      expect(ix.cascade.unitState(INeedsExtra)).toBe('Active');
      expect(events).toEqual(['+flaky']);
      ix.dispose();
    });
  });

  it('8. async disposers tear down serially in reverse topo order', async () => {
    const ix = makeContainer();
    const gates = { root: deferred(), mid: deferred(), leaf: deferred() };
    const makeAsync = (label: string, gate: Promise<void>) =>
      class {
        dispose(): void {
          events.push(`${label}-start`);
          return gate.then(() => {
            events.push(`${label}-end`);
          }) as unknown as void;
        }
      };
    class AsyncRoot extends makeAsync('root', gates.root.promise) implements IRoot {
      label = 'root';
    }
    class AsyncMid extends makeAsync('mid', gates.mid.promise) implements IMid {
      constructor(@IRoot public readonly root: IRoot) {
        super();
      }
    }
    class AsyncLeaf extends makeAsync('leaf', gates.leaf.promise) implements ILeaf {
      constructor(@IMid public readonly mid: IMid) {
        super();
      }
    }
    ix.provide(IRoot, new SyncDescriptor(AsyncRoot));
    ix.provide(IMid, new SyncDescriptor(AsyncMid));
    ix.provide(ILeaf, new SyncDescriptor(AsyncLeaf));
    events = [];

    const done = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'async teardown' });
    // Reverse topo: leaf starts first; mid must not start until leaf finishes.
    expect(events).toEqual(['leaf-start']);
    gates.root.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['leaf-start']);
    gates.leaf.resolve();
    await flushMicrotasks();
    expect(events).toEqual(['leaf-start', 'leaf-end', 'mid-start']);
    gates.mid.resolve();
    await done;
    expect(events).toEqual(['leaf-start', 'leaf-end', 'mid-start', 'mid-end', 'root-start', 'root-end']);
    ix.dispose();
  });

  it('9. the abort hook cancels in-flight work (bounded wait), then forces through on timeout', async () => {
    const ix = makeContainer();
    provideChain(ix);
    const seen: { affected: string[]; reason: string }[] = [];
    let gate: { promise: Promise<void>; resolve: () => void } | undefined;
    ix.cascade.configure({
      abortWaitMs: 30,
      onWillCascade: (affected, reason) => {
        seen.push({ affected: affected.map((ref) => ref.token.toString()), reason });
        gate = deferred();
        return gate.promise;
      },
    });

    // (a) the cascade waits for the abort to complete.
    const first = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'feature "x" unloaded' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('feature "x" unloaded');
    expect(seen[0]!.affected).toContain('cascade-leaf');
    await Promise.resolve();
    expect(ix.cascade.isInFlight(IRoot)).toBe(true); // still waiting
    gate!.resolve();
    await first;
    expect(ix.cascade.history().at(-1)!.abortWaited).toBe(true);
    expect(ix.cascade.history().at(-1)!.abortTimedOut).toBe(false);
    expect(ix.cascade.unitState(IRoot)).toBeUndefined();

    // (b) an abort that never completes is forced after the bounded wait.
    provideChain(ix);
    const second = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'forced' });
    await second; // never resolved the gate — the bound fired
    const entry = ix.cascade.history().at(-1)!;
    expect(entry.abortWaited).toBe(true);
    expect(entry.abortTimedOut).toBe(true);
    expect(ix.cascade.unitState(IRoot)).toBeUndefined();
    ix.dispose();
  });

  it('10. a resolution hitting the in-flight subgraph suspends and completes after the transaction', async () => {
    const ix = makeContainer();
    provideChain(ix);
    const gate = deferred();
    ix.cascade.configure({ onWillCascade: () => gate.promise, resolveTimeoutMs: 50 });

    const replace = ix.cascade.submit({
      action: 'provide',
      token: IRoot,
      descriptor: new SyncDescriptor(Root),
      reason: 'replace root',
    });
    expect(ix.cascade.isInFlight(IRoot)).toBe(true);

    // The sync path cannot suspend: it fails fast.
    expect(() => ix.invokeFunction((a) => a.get(IRoot))).toThrow(CascadeConflictError);

    // The async path suspends until the transaction completes.
    const suspended = ix.cascade.resolveWhenAvailable<IRoot>(IRoot);
    gate.resolve();
    await replace;
    const root = await suspended;
    expect(root).toBeInstanceOf(Root);

    // Timeout variant: a transaction that parks forever rejects suspended resolutions.
    const parked = deferred();
    ix.cascade.configure({ onWillCascade: () => parked.promise });
    void ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'parked' });
    await expect(ix.cascade.resolveWhenAvailable(IRoot)).rejects.toThrow(CascadeConflictError);
    parked.resolve();
    await ix.cascade.whenIdle();
    ix.dispose();
  });

  it('11. cycle detection holds under dynamic edge add/remove', () => {
    const ix = makeContainer();
    // Cyclic recipes provided dynamically: neither can satisfy its dependency,
    // so both wait — no construction, no spurious failure.
    const IA = createDecorator<{ a: true }>('cascade-cyc-a');
    const IB = createDecorator<{ b: true }>('cascade-cyc-b');
    class A {
      constructor(@IB public readonly b: unknown) {}
    }
    class B {
      constructor(@IA public readonly a: unknown) {}
    }
    ix.provide(IA, new SyncDescriptor(A));
    ix.provide(IB, new SyncDescriptor(B));
    expect(ix.cascade.unitState(IA)).toBe('Pending');
    expect(ix.cascade.unitState(IB)).toBe('Pending');
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();

    // Break the cycle: replace A with an independent recipe; both activate.
    class A2 {
      readonly a = true;
    }
    ix.provide(IA, new SyncDescriptor(A2));
    expect(ix.cascade.unitState(IA)).toBe('Active');
    expect(ix.cascade.unitState(IB)).toBe('Active');
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();

    // Dynamic chain teardown keeps the graph acyclic and edge-free.
    ix.unprovide(IA);
    expect(ix.cascade.unitState(IB)).toBe('Pending');
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();
    ix.dispose();
  });

  it('12. ledger balance: arbitrary sequences leave no leaks or dangling edges', async () => {    const ix = makeContainer();
    provideChain(ix);
    // 3 live instances + 3 provide entries on the book.
    expect(ledgerOf(ix).size).toBe(6);

    ix.unprovide(IMid);
    // Left on the book: the root instance entry + root/leaf provide entries.
    expect(ledgerOf(ix).size).toBe(3);
    // Leaf is Pending (waiting on mid); mid is removed; root is Active.
    expect(ix.cascade.unitState(ILeaf)).toBe('Pending');
    expect(ix.cascade.unitState(IMid)).toBeUndefined();

    ix.provide(IMid, new SyncDescriptor(Mid));
    expect(ix.cascade.unitState(ILeaf)).toBe('Active');
    expect(ledgerOf(ix).size).toBe(6);

    await ix.cascade.update(IRoot);
    expect(ledgerOf(ix).size).toBe(6);
    expect(ix.dependencyGraph.edges()).toHaveLength(2);

    ix.unprovide(ILeaf);
    ix.unprovide(IMid);
    ix.unprovide(IRoot);
    expect(ledgerOf(ix).size).toBe(0);
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();
    expect(ix.cascade.pendingSnapshot().size).toBe(0);

    ix.dispose();
    expect(ledgerOf(ix).size).toBe(0);
  });

  it('13. replacing with a concrete instance cascades into live dependents (D1)', () => {
    const ix = makeContainer();
    provideChain(ix);
    const firstMid = ix.invokeFunction((a) => a.get(IMid));
    const replacement = new Root('root2');
    events = [];

    ix.provide(IRoot, replacement);

    // Same transaction: dependents were torn down and rebuilt against the instance.
    expect(events).toEqual(['-leaf', '-mid', '-root', '+mid', '+leaf']);
    const newMid = ix.invokeFunction((a) => a.get(IMid));
    expect(newMid).not.toBe(firstMid);
    expect(newMid.root).toBe(replacement);
    expect(ix.invokeFunction((a) => a.get(IRoot))).toBe(replacement);
    ix.dispose();
  });

  it('14. a rejecting abort hook is logged, never a veto (best-effort §4.5)', async () => {
    const reported: unknown[] = [];
    const { setUnexpectedErrorHandler, resetUnexpectedErrorHandler } = await import(
      '#/_base/errors/unexpectedError'
    );
    setUnexpectedErrorHandler((err) => { reported.push(err); });
    try {
      const ix = makeContainer();
      provideChain(ix);
      ix.cascade.configure({
        onWillCascade: () => Promise.reject(new Error('abort hook blew up')),
      });

      await ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'forced anyway' });

      expect(ix.cascade.unitState(IRoot)).toBeUndefined();
      expect(() => ix.invokeFunction((a) => a.get(IRoot))).toThrow(/unknown service/);
      expect(ix.cascade.history().at(-1)!.abortWaited).toBe(true);
      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toContain('abort hook blew up');
      ix.dispose();
    } finally {
      resetUnexpectedErrorHandler();
    }
  });
});

describe('cascade engine — cross-scope orchestration (D9)', () => {
  it('a parent change cascades into child-scope dependents and rebuilds them', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    child.provide(IMid, new SyncDescriptor(Mid));
    events = [];

    parent.unprovide(IRoot);
    // Global reverse topo: the child unit dies before its parent dependency.
    expect(events).toEqual(['-mid', '-root']);
    expect(child.cascade.unitState(IMid)).toBe('Pending');
    expect(parent.cascade.unitState(IRoot)).toBeUndefined();

    parent.provide(IRoot, new SyncDescriptor(Root));
    // Global topo rebuild: parent first, then the child dependent.
    expect(events).toEqual(['-mid', '-root', '+root', '+mid']);
    const mid = child.invokeFunction((a) => a.get(IMid));
    expect(mid.root).toBe(parent.invokeFunction((a) => a.get(IRoot)));
    parent.dispose();
  });

  it('orders a three-level chain globally: deepest first for teardown, reverse for rebuild', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    child.provide(IMid, new SyncDescriptor(Mid));
    const grandchild = child.createChild(new ServiceCollection());
    grandchild.provide(ILeaf, new SyncDescriptor(Leaf));
    events = [];

    parent.unprovide(IRoot);
    expect(events).toEqual(['-leaf', '-mid', '-root']);

    parent.provide(IRoot, new SyncDescriptor(Root));
    expect(events).toEqual(['-leaf', '-mid', '-root', '+root', '+mid', '+leaf']);
    parent.dispose();
  });

  it('shadowing: a child shadow of the changed token is not in the contagion set', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    // The child registers its own IRoot; the child's Mid binds the shadow.
    child.provide(IRoot, new SyncDescriptor(Root, ['shadow']));
    child.provide(IMid, new SyncDescriptor(Mid));
    events = [];

    parent.unprovide(IRoot);
    // Only the parent's own root is retired; the child's shadow and its
    // dependent are untouched.
    expect(events).toEqual(['-root']);
    expect(child.cascade.unitState(IMid)).toBe('Active');
    expect(child.cascade.unitState(IRoot)).toBe('Active');
    const mid = child.invokeFunction((a) => a.get(IMid));
    expect(mid.root).toBe(child.invokeFunction((a) => a.get(IRoot)));
    parent.dispose();
  });

  it('siblings are isolated: one child scope\'s change never touches the other', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const childA = parent.createChild(new ServiceCollection());
    const childB = parent.createChild(new ServiceCollection());
    childA.provide(IMid, new SyncDescriptor(Mid));
    childB.provide(IMid, new SyncDescriptor(Mid));
    events = [];

    childA.unprovide(IMid);
    expect(events).toEqual(['-mid']);
    expect(childB.cascade.unitState(IMid)).toBe('Active');

    // But a parent change reaches both subtrees.
    parent.unprovide(IRoot);
    expect(events).toEqual(['-mid', '-mid', '-root']);
    expect(childB.cascade.unitState(IMid)).toBe('Pending');
    parent.dispose();
  });

  it('a descendant scope dying mid-transaction is skipped idempotently', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    child.provide(IMid, new SyncDescriptor(Mid));
    events = [];
    parent.cascade.configure({
      onWillCascade: () => {
        child.dispose();
      },
    });

    parent.unprovide(IRoot);

    // The child's own dispose already retired mid; the cascade skips the dead
    // scope's units and completes its own teardown.
    expect(events).toEqual(['-mid', '-root']);
    const entry = parent.cascade.history().at(-1)!;
    expect(entry.tornDown).toEqual(['cascade-root']);
    expect(parent.cascade.unitState(IRoot)).toBeUndefined();
    parent.dispose();
  });

  it('the in-flight guard and suspension work across scopes', async () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    child.provide(IMid, new SyncDescriptor(Mid));
    const gate = deferred();
    parent.cascade.configure({ onWillCascade: () => gate.promise });

    const tx = parent.cascade.submit({
      action: 'provide',
      token: IRoot,
      descriptor: new SyncDescriptor(Root),
      reason: 'replace root',
    });
    // The child sees its ancestor's token as in flight.
    expect(child.cascade.isInFlight(IRoot)).toBe(true);
    expect(() => child.invokeFunction((a) => a.get(IRoot))).toThrow(CascadeConflictError);

    const suspended = child.cascade.resolveWhenAvailable<IRoot>(IRoot);
    gate.resolve();
    await tx;
    const root = await suspended;
    expect(root).toBeInstanceOf(Root);
    expect(child.cascade.unitState(IMid)).toBe('Active');
    parent.dispose();
  });
});
