import { afterEach, describe, expect, it } from 'vitest';

import type {
  CascadeEngine,
  CascadeHistoryEntry,
  UnitStateChange,
} from '#/_base/di/cascadeEngine';
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

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}


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
    ix.provide(IMid, new SyncDescriptor(Mid));
    expect(ix.cascade.stateOf(IMid)).toBe('Pending');
    expect(events).toEqual([]);

    ix.provide(IRoot, new SyncDescriptor(Root));
    expect(ix.cascade.stateOf(IRoot)).toBe('Active');
    expect(ix.cascade.stateOf(IMid)).toBe('Active');
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
    expect(ix.cascade.stateOf(IRoot)).toBeUndefined();
    expect(ix.cascade.stateOf(IMid)).toBe('Pending');
    expect(ix.cascade.stateOf(ILeaf)).toBe('Pending');
    expect(() => ix.invokeFunction((a) => a.get(IRoot))).toThrow(/unknown service/);
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

    expect(ix.cascade.history().length).toBe(historyBefore + 1);
    const entry = ix.cascade.history().at(-1)!;
    expect(entry.tornDown).toEqual(['cascade-leaf', 'cascade-mid', 'cascade-root']);
    expect(entry.rebuilt).toEqual(['cascade-root', 'cascade-mid', 'cascade-leaf']);
    expect(events).toEqual(['-leaf', '-mid', '-root', '+root2', '+mid', '+leaf']);
    expect(ix.cascade.stateOf(IMid)).toBe('Active');
    expect(ix.cascade.stateOf(ILeaf)).toBe('Active');
    const newMid = ix.invokeFunction((a) => a.get(IMid));
    expect(newMid).not.toBe(firstMid);
    expect(newMid.root).toBeInstanceOf(Root2);
    ix.dispose();
  });

  it('eager units treat an on-demand dependency as available and pull it transitively', () => {
    const ix = makeContainer();
    events = [];
    ix.provide(IMid, new SyncDescriptor(Mid));
    expect(ix.cascade.stateOf(IMid)).toBe('Pending');

    ix.provide(IRoot, new SyncDescriptor(Root), { activation: 'ondemand' });
    expect(ix.cascade.stateOf(IMid)).toBe('Active');
    expect(ix.cascade.stateOf(IRoot)).toBe('Active');
    expect(events).toEqual(['+root', '+mid']);

    const ix2 = makeContainer();
    events = [];
    ix2.provide(IExtra, new SyncDescriptor(Extra), { activation: 'ondemand' });
    expect(ix2.cascade.stateOf(IExtra)).toBe('Pending');
    expect(events).toEqual([]);
    ix2.dispose();
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
        return calls === 1 ? gate.promise : undefined;
      },
    });

    const first = ix.cascade.submit({
      action: 'unprovide',
      token: IRoot,
      reason: 'drop root',
    });
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

    expect(ix.cascade.isInFlight(IRoot)).toBe(true);
    expect(ix.invokeFunction((a) => a.get(IExtra))).toBeInstanceOf(Extra);

    gate.resolve();
    await Promise.all([first, second, third]);

    expect(calls).toBe(2);
    const history = ix.cascade.history().slice(-2);
    expect(history[0]!.changes).toEqual([{ token: 'cascade-root', action: 'unprovide' }]);
    expect(history[1]!.changes).toEqual([
      { token: 'cascade-extra', action: 'unprovide' },
      { token: 'cascade-mid', action: 'provide' },
    ]);
    expect(ix.cascade.stateOf(IExtra)).toBeUndefined();
    expect(ix.cascade.stateOf(IMid)).toBe('Pending');
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
    expect(ix.cascade.stateOf(IExtra)).toBe('Failed');
    expect(() => ix.invokeFunction((a) => a.get(IExtra))).toThrow('ctor boom');

    class NeedsExtra {
      constructor(@IExtra public readonly extra: IExtra) {}
    }
    const INeedsExtra = createDecorator<NeedsExtra>('cascade-needs-extra');
    ix.provide(INeedsExtra, new SyncDescriptor(NeedsExtra));
    expect(ix.cascade.stateOf(INeedsExtra)).toBe('Pending');

    ix.provide(IRoot, new SyncDescriptor(Root));
    expect(ix.cascade.stateOf(IExtra)).toBe('Failed');

    shouldThrow = false;
    events = [];
    return ix.cascade.update(IExtra).then(() => {
      expect(ix.cascade.stateOf(IExtra)).toBe('Active');
      expect(ix.cascade.stateOf(INeedsExtra)).toBe('Active');
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

    const first = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'feature "x" unloaded' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('feature "x" unloaded');
    expect(seen[0]!.affected).toContain('cascade-leaf');
    await Promise.resolve();
    expect(ix.cascade.isInFlight(IRoot)).toBe(true);
    gate!.resolve();
    await first;
    expect(ix.cascade.history().at(-1)!.abortWaited).toBe(true);
    expect(ix.cascade.history().at(-1)!.abortTimedOut).toBe(false);
    expect(ix.cascade.stateOf(IRoot)).toBeUndefined();

    provideChain(ix);
    const second = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'forced' });
    await second;
    const entry = ix.cascade.history().at(-1)!;
    expect(entry.abortWaited).toBe(true);
    expect(entry.abortTimedOut).toBe(true);
    expect(ix.cascade.stateOf(IRoot)).toBeUndefined();
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

    expect(() => ix.invokeFunction((a) => a.get(IRoot))).toThrow(CascadeConflictError);

    const suspended = ix.cascade.resolveWhenAvailable<IRoot>(IRoot);
    gate.resolve();
    await replace;
    const root = await suspended;
    expect(root).toBeInstanceOf(Root);

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
    expect(ix.cascade.stateOf(IA)).toBe('Pending');
    expect(ix.cascade.stateOf(IB)).toBe('Pending');
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();

    class A2 {
      readonly a = true;
    }
    ix.provide(IA, new SyncDescriptor(A2));
    expect(ix.cascade.stateOf(IA)).toBe('Active');
    expect(ix.cascade.stateOf(IB)).toBe('Active');
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();

    ix.unprovide(IA);
    expect(ix.cascade.stateOf(IB)).toBe('Pending');
    expect(ix.dependencyGraph.edges()).toHaveLength(0);
    expect(ix.dependencyGraph.findCycle((ref) => ref.token.toString())).toBeNull();
    ix.dispose();
  });

  it('12. ledger balance: arbitrary sequences leave no leaks or dangling edges', async () => {    const ix = makeContainer();
    provideChain(ix);
    expect(ledgerOf(ix).size).toBe(6);

    ix.unprovide(IMid);
    expect(ledgerOf(ix).size).toBe(3);
    expect(ix.cascade.stateOf(ILeaf)).toBe('Pending');
    expect(ix.cascade.stateOf(IMid)).toBeUndefined();

    ix.provide(IMid, new SyncDescriptor(Mid));
    expect(ix.cascade.stateOf(ILeaf)).toBe('Active');
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

      expect(ix.cascade.stateOf(IRoot)).toBeUndefined();
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
    expect(events).toEqual(['-mid', '-root']);
    expect(child.cascade.stateOf(IMid)).toBe('Pending');
    expect(parent.cascade.stateOf(IRoot)).toBeUndefined();

    parent.provide(IRoot, new SyncDescriptor(Root));
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

  it('an eager child unit pulls an on-demand ancestor dependency transitively', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root), { activation: 'ondemand' });
    const child = parent.createChild(new ServiceCollection());
    events = [];

    child.provide(IMid, new SyncDescriptor(Mid));
    expect(child.cascade.stateOf(IMid)).toBe('Active');
    expect(parent.cascade.stateOf(IRoot)).toBe('Active');
    expect(events).toEqual(['+root', '+mid']);
    parent.dispose();
  });

  it('shadowing: a child shadow of the changed token is not in the contagion set', () => {
    const parent = makeContainer();
    parent.provide(IRoot, new SyncDescriptor(Root));
    const child = parent.createChild(new ServiceCollection());
    child.provide(IRoot, new SyncDescriptor(Root, ['shadow']));
    child.provide(IMid, new SyncDescriptor(Mid));
    events = [];

    parent.unprovide(IRoot);
    expect(events).toEqual(['-root']);
    expect(child.cascade.stateOf(IMid)).toBe('Active');
    expect(child.cascade.stateOf(IRoot)).toBe('Active');
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
    expect(childB.cascade.stateOf(IMid)).toBe('Active');

    parent.unprovide(IRoot);
    expect(events).toEqual(['-mid', '-mid', '-root']);
    expect(childB.cascade.stateOf(IMid)).toBe('Pending');
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

    expect(events).toEqual(['-mid', '-root']);
    const entry = parent.cascade.history().at(-1)!;
    expect(entry.tornDown).toEqual(['cascade-root']);
    expect(parent.cascade.stateOf(IRoot)).toBeUndefined();
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
    expect(child.cascade.isInFlight(IRoot)).toBe(true);
    expect(() => child.invokeFunction((a) => a.get(IRoot))).toThrow(CascadeConflictError);

    const suspended = child.cascade.resolveWhenAvailable<IRoot>(IRoot);
    gate.resolve();
    await tx;
    const root = await suspended;
    expect(root).toBeInstanceOf(Root);
    expect(child.cascade.stateOf(IMid)).toBe('Active');
    parent.dispose();
  });
});

describe('cascade engine — introspection (debug surface)', () => {
  it('unitsSnapshot reflects unit states, in-flight, and the sticky failure', async () => {
    const ix = makeContainer();
    let stateDuringCtor: string | undefined;
    class SpyRoot implements IRoot {
      label = 'spy';
      constructor() {
        stateDuringCtor = ix.cascade.unitsSnapshot().find(
          (unit) => unit.token === 'cascade-root',
        )?.state;
      }
    }
    ix.provide(IRoot, new SyncDescriptor(SpyRoot));
    expect(stateDuringCtor).toBe('Activating');

    ix.provide(ILeaf, new SyncDescriptor(Leaf));
    class Boom implements IExtra {
      label = 'boom';
      constructor() {
        throw new Error('ctor boom');
      }
    }
    ix.provide(IExtra, new SyncDescriptor(Boom));

    const byToken = new Map(ix.cascade.unitsSnapshot().map((unit) => [unit.token, unit]));
    expect(byToken.get('cascade-root')).toMatchObject({
      state: 'Active',
      everActive: true,
      inFlight: false,
    });
    expect(byToken.get('cascade-leaf')).toMatchObject({
      state: 'Pending',
      everActive: false,
      inFlight: false,
    });
    expect(byToken.get('cascade-leaf')!.error).toBeUndefined();
    expect(byToken.get('cascade-extra')).toMatchObject({
      state: 'Failed',
      everActive: false,
      error: 'ctor boom',
    });

    const gate = deferred();
    class SlowRoot implements IRoot {
      label = 'slow';
      dispose(): void {
        return gate.promise as unknown as void;
      }
    }
    ix.provide(IRoot, new SyncDescriptor(SlowRoot));
    const done = ix.cascade.submit({ action: 'unprovide', token: IRoot, reason: 'drop root' });
    const mid = new Map(ix.cascade.unitsSnapshot().map((unit) => [unit.token, unit]));
    expect(mid.get('cascade-root')).toMatchObject({ state: 'Unloading', inFlight: true });
    gate.resolve();
    await done;
    expect(ix.cascade.unitsSnapshot().some((unit) => unit.token === 'cascade-root')).toBe(false);
    ix.dispose();
  });

  it('onDidChangeUnitState fires the transition sequence (incl. Failed with error)', () => {
    const ix = makeContainer();
    const seen: UnitStateChange[] = [];
    ix.cascade.onDidChangeUnitState((change) => { seen.push(change); });

    ix.provide(IRoot, new SyncDescriptor(Root));
    expect(seen).toEqual([
      { token: 'cascade-root', state: 'Pending' },
      { token: 'cascade-root', state: 'Activating' },
      { token: 'cascade-root', state: 'Active' },
    ]);

    ix.provide(IMid, new SyncDescriptor(Mid));
    seen.length = 0;
    ix.unprovide(IRoot);
    expect(seen).toEqual([
      { token: 'cascade-mid', state: 'Unloading' },
      { token: 'cascade-mid', state: 'Pending' },
      { token: 'cascade-root', state: 'Unloading' },
    ]);

    seen.length = 0;
    class Boom implements IExtra {
      label = 'boom';
      constructor() {
        throw new Error('ctor boom');
      }
    }
    ix.provide(IExtra, new SyncDescriptor(Boom));
    expect(seen).toEqual([
      { token: 'cascade-extra', state: 'Pending' },
      { token: 'cascade-extra', state: 'Activating' },
      { token: 'cascade-extra', state: 'Failed', error: 'ctor boom' },
    ]);
    ix.dispose();
  });

  it('onDidCascade fires once per completed transaction with the history entry', () => {
    const ix = makeContainer();
    const fired: CascadeHistoryEntry[] = [];
    ix.cascade.onDidCascade((entry) => { fired.push(entry); });

    provideChain(ix);
    expect(fired).toHaveLength(3);
    expect(fired.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(fired[2]).toBe(ix.cascade.history().at(-1));
    expect(fired[2]!.changes).toEqual([{ token: 'cascade-leaf', action: 'provide' }]);
    ix.dispose();
  });

  it('CascadeTree onDidAddEngine / onDidRemoveEngine track child containers', () => {
    const parent = makeContainer();
    const added: CascadeEngine[] = [];
    const removed: CascadeEngine[] = [];
    parent.cascadeTree.onDidAddEngine((engine) => { added.push(engine); });
    parent.cascadeTree.onDidRemoveEngine((engine) => { removed.push(engine); });

    const child = parent.createChild(new ServiceCollection());
    expect(added).toEqual([child.cascade]);
    expect(parent.cascadeTree.engines.has(child.cascade)).toBe(true);

    child.dispose();
    expect(removed).toEqual([child.cascade]);
    expect(parent.cascadeTree.engines.has(child.cascade)).toBe(false);
    parent.dispose();
  });

  it('servicesSnapshot lists token / uid and tracks provide/unprovide', () => {
    const ix = makeContainer();
    const handle = ix.provide(IRoot, new SyncDescriptor(Root));
    const root = ix.servicesSnapshot().find((service) => service.token === 'cascade-root');
    expect(root).toBeDefined();
    expect(root!.uid).toBe(handle.uid);
    expect(ix.findIdentifier('cascade-root')).toBe(IRoot);

    ix.provide(IRoot, new SyncDescriptor(Root));
    const next = ix.servicesSnapshot().find((service) => service.token === 'cascade-root');
    expect(next!.uid).toBeGreaterThan(root!.uid);

    ix.unprovide(IRoot);
    expect(ix.servicesSnapshot().some((service) => service.token === 'cascade-root')).toBe(false);
    expect(ix.findIdentifier('cascade-root')).toBeUndefined();
    ix.dispose();
  });

  it('exposes ledger / cascadeTree / children for debug introspection', () => {
    const parent = makeContainer();
    expect(parent.ledger.state).toBe('active');

    const child = parent.createChild(new ServiceCollection());
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]).toBe(child);
    expect((child as InstantiationService).cascadeTree).toBe(parent.cascadeTree);

    child.dispose();
    expect(parent.children).toHaveLength(0);
    parent.dispose();
    expect(parent.ledger.state).toBe('disposed');
  });
});
