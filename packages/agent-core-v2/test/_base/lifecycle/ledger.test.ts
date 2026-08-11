import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';
import { LedgerDisposedError } from '#/_base/lifecycle/errors';
import { Ledger } from '#/_base/lifecycle/ledger';
import type { Disposer, TeardownReason } from '#/_base/lifecycle/disposer';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('Ledger', () => {
  describe('teardown ordering', () => {
    it('tears down entries in strict reverse registration order', () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.register(() => { events.push('first'); }, 'first');
      ledger.register(() => { events.push('second'); }, 'second');
      ledger.register(() => { events.push('third'); }, 'third');
      void ledger.teardown();
      expect(events).toEqual(['third', 'second', 'first']);
      expect(ledger.state).toBe('disposed');
    });

    it('completes synchronously when every entry is synchronous', () => {
      const ledger = new Ledger('test');
      ledger.register(() => {}, 'a');
      ledger.register(() => {}, 'b');
      const out = ledger.teardown();
      expect(out).toBeUndefined();
      expect(ledger.state).toBe('disposed');
      expect(ledger.isDisposed).toBe(true);
    });

    it('mixes sync and async entries: async entries suspend teardown, order holds', async () => {
      const events: string[] = [];
      const gate = deferred();
      const ledger = new Ledger('test');
      ledger.register(() => { events.push('sync-1'); }, 'sync-1');
      ledger.register(async () => {
        events.push('async-start');
        await gate.promise;
        events.push('async-end');
      }, 'async');
      ledger.register(() => { events.push('sync-3'); }, 'sync-3');

      const out = ledger.teardown();
      expect(out).toBeInstanceOf(Promise);
      expect(ledger.state).toBe('disposing');
      expect(events).toEqual(['sync-3', 'async-start']);

      gate.resolve();
      await out;
      expect(events).toEqual(['sync-3', 'async-start', 'async-end', 'sync-1']);
      expect(ledger.state).toBe('disposed');
    });

    it('awaits each entry serially: the next disposer starts only after the previous resolves', async () => {
      const events: string[] = [];
      const gates = [deferred(), deferred()];
      const ledger = new Ledger('test');
      ledger.register(async () => {
        events.push('a-start');
        await gates[0]!.promise;
        events.push('a-end');
      }, 'a');
      ledger.register(async () => {
        events.push('b-start');
        await gates[1]!.promise;
        events.push('b-end');
      }, 'b');

      const out = ledger.teardown();
      expect(events).toEqual(['b-start']);
      gates[0]!.resolve();
      await Promise.resolve();
      expect(events).toEqual(['b-start']);
      gates[1]!.resolve();
      await out;
      expect(events).toEqual(['b-start', 'b-end', 'a-start', 'a-end']);
    });
  });

  describe('registration guards', () => {
    it('throws when registering into a disposed ledger', () => {
      const ledger = new Ledger('test');
      void ledger.teardown();
      expect(() => ledger.register(() => {}, 'late')).toThrow(LedgerDisposedError);
      expect(() => ledger.effect(() => () => {}, 'late')).toThrow(LedgerDisposedError);
      expect(() => ledger.createChild('late')).toThrow(LedgerDisposedError);
    });

    it('throws when registering while teardown is in flight', async () => {
      const gate = deferred();
      const ledger = new Ledger('test');
      let caught: unknown;
      ledger.register(async () => {
        await gate.promise;
        try {
          ledger.register(() => {}, 'late');
        } catch (error) {
          caught = error;
        }
      }, 'slow');

      const out = ledger.teardown();
      gate.resolve();
      await out;
      expect(caught).toBeInstanceOf(LedgerDisposedError);
      expect(ledger.state).toBe('disposed');
    });
  });

  describe('uninterruptible rollback', () => {
    const reported: unknown[] = [];

    afterEach(() => {
      reported.length = 0;
      resetUnexpectedErrorHandler();
    });

    it('a throwing entry is reported (with label) and teardown continues', () => {
      setUnexpectedErrorHandler((err) => { reported.push(err); });
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.register(() => { events.push('first'); }, 'first');
      ledger.register(() => {
        events.push('bad-attempted');
        throw new Error('boom');
      }, 'bad');
      ledger.register(() => { events.push('third'); }, 'third');

      expect(() => ledger.teardown()).not.toThrow();
      expect(events).toEqual(['third', 'bad-attempted', 'first']);
      expect(ledger.state).toBe('disposed');
      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toContain('boom');
      expect((reported[0] as Error).message).toContain('bad');
    });

    it('a rejecting async entry is reported and teardown continues', async () => {
      setUnexpectedErrorHandler((err) => { reported.push(err); });
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.register(() => { events.push('first'); }, 'first');
      ledger.register(async () => {
        events.push('bad-attempted');
        throw new Error('async boom');
      }, 'bad');
      ledger.register(() => { events.push('third'); }, 'third');

      await ledger.teardown();
      expect(events).toEqual(['third', 'bad-attempted', 'first']);
      expect(reported).toHaveLength(1);
      expect((reported[0] as Error).message).toContain('async boom');
    });
  });

  describe('construction failure auto-rollback', () => {
    it('sync iterator: a mid-iteration throw rolls back already-yielded disposers in reverse', () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      expect(() =>
        ledger.effect(function* () {
          yield () => { events.push('undo-1'); };
          yield () => { events.push('undo-2'); };
          throw new Error('construct failed');
        }, 'gen'),
      ).toThrow('construct failed');
      expect(events).toEqual(['undo-2', 'undo-1']);
      expect(ledger.size).toBe(0);
    });

    it('async iterator: a mid-iteration throw rolls back already-yielded disposers in reverse', async () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      // eslint-disable-next-line require-yield
      const body = async function* (): AsyncGenerator<Disposer> {
        yield () => { events.push('undo-1'); };
        yield () => { events.push('undo-2'); };
        throw new Error('async construct failed');
      };
      const entry = ledger.effect(body, 'gen');
      const reported: unknown[] = [];
      setUnexpectedErrorHandler((err) => { reported.push(err); });
      try {
        await ledger.teardown();
        expect(events).toEqual(['undo-2', 'undo-1']);
        expect(reported).toHaveLength(1);
        expect((reported[0] as Error).message).toContain('async construct failed');
      } finally {
        resetUnexpectedErrorHandler();
      }
      expect(entry.disposed).toBe(true);
    });
  });

  describe('effect return forms', () => {
    it('void body: entry exists for introspection, nothing to roll back', () => {
      const ledger = new Ledger('test');
      ledger.effect(() => {}, 'noop');
      expect(ledger.size).toBe(1);
      expect(ledger.entries()[0]).toMatchObject({ label: 'noop', kind: 'effect' });
      void ledger.teardown();
      expect(ledger.state).toBe('disposed');
    });

    it('plain disposer', () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.effect(() => () => { events.push('disposed'); }, 'fx');
      void ledger.teardown();
      expect(events).toEqual(['disposed']);
    });

    it('Promise<disposer>: teardown awaits the promise then runs the disposer', async () => {
      const events: string[] = [];
      const gate = deferred<Disposer>();
      const ledger = new Ledger('test');
      ledger.effect(() => gate.promise, 'async-fx');
      ledger.register(() => { events.push('first'); }, 'first');

      const out = ledger.teardown();
      expect(events).toEqual(['first']);
      gate.resolve(() => { events.push('async-disposed'); });
      await out;
      expect(events).toEqual(['first', 'async-disposed']);
    });

    it('sync iterator: yields are rolled back in reverse at teardown', () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.effect(function* () {
        events.push('setup-1');
        yield () => { events.push('undo-1'); };
        events.push('setup-2');
        yield () => { events.push('undo-2'); };
      }, 'gen');
      expect(events).toEqual(['setup-1', 'setup-2']);
      void ledger.teardown();
      expect(events).toEqual(['setup-1', 'setup-2', 'undo-2', 'undo-1']);
    });

    it('async iterator: yields are rolled back in reverse at teardown', async () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      const body = async function* (): AsyncGenerator<Disposer> {
        yield () => { events.push('undo-1'); };
        yield () => { events.push('undo-2'); };
      };
      ledger.effect(body, 'gen');
      await ledger.teardown();
      expect(events).toEqual(['undo-2', 'undo-1']);
    });
  });

  describe('child ledgers', () => {
    it('a child ledger is one entry of the parent and tears down with it', () => {
      const events: string[] = [];
      const parent = new Ledger('parent');
      parent.register(() => { events.push('parent-entry'); }, 'parent-entry');
      const child = parent.createChild('child');
      child.register(() => { events.push('child-entry'); }, 'child-entry');

      void parent.teardown();
      expect(events).toEqual(['child-entry', 'parent-entry']);
      expect(child.state).toBe('disposed');
      expect(parent.state).toBe('disposed');
    });

    it('a child torn down directly detaches from the parent', () => {
      const events: string[] = [];
      const parent = new Ledger('parent');
      const child = parent.createChild('child');
      child.register(() => { events.push('child-entry'); }, 'child-entry');

      void child.teardown();
      expect(events).toEqual(['child-entry']);
      expect(parent.entries()).toHaveLength(0);

      void parent.teardown();
      expect(events).toEqual(['child-entry']);
    });
  });

  describe('introspection', () => {
    it('entries() renders the book as a tree', () => {
      const parent = new Ledger('parent');
      parent.register(() => {}, 'a');
      parent.effect(() => () => {}, 'fx');
      const child = parent.createChild('child-scope');
      child.register(() => {}, 'child-a');

      expect(parent.entries()).toEqual([
        { label: 'a', kind: 'disposer', stack: undefined, children: undefined },
        { label: 'fx', kind: 'effect', stack: undefined, children: undefined },
        {
          label: 'child-scope',
          kind: 'ledger',
          stack: undefined,
          children: [
            { label: 'child-a', kind: 'disposer', stack: undefined, children: undefined },
          ],
        },
      ]);
    });

    it('captures the registration stack when enabled', () => {
      Ledger.captureStacks = true;
      try {
        const ledger = new Ledger('test');
        ledger.register(() => {}, 'traced');
        expect(ledger.entries()[0]!.stack).toContain('Ledger registration');
      } finally {
        Ledger.captureStacks = false;
      }
    });
  });

  describe('idempotency', () => {
    it('teardown is idempotent: disposers run exactly once', async () => {
      const spy = vi.fn();
      const ledger = new Ledger('test');
      ledger.register(spy, 'spy');
      void ledger.teardown();
      void ledger.teardown();
      await ledger.teardown();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a concurrent teardown joins the in-flight one', async () => {
      const gate = deferred();
      const spy = vi.fn(async () => { await gate.promise; });
      const ledger = new Ledger('test');
      ledger.register(spy, 'spy');
      const first = ledger.teardown();
      const second = ledger.teardown();
      expect(second).toBe(first);
      gate.resolve();
      await first;
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('entry.dispose is idempotent and removes the entry from the book', () => {
      const spy = vi.fn();
      const ledger = new Ledger('test');
      const entry = ledger.register(spy, 'spy');
      void entry.dispose();
      void entry.dispose();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(entry.disposed).toBe(true);
      expect(ledger.size).toBe(0);
    });

    it('entry.release removes the entry without running its disposer', () => {
      const spy = vi.fn();
      const ledger = new Ledger('test');
      const entry = ledger.register(spy, 'spy');
      entry.release();
      entry.release();
      expect(entry.disposed).toBe(true);
      void ledger.teardown();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('reason propagation', () => {
    it.each(['scope-close', 'cascade', 'unload'] as TeardownReason[])(
      'teardown(%s) reaches every disposer, including effect forms',
      async (reason) => {
        const seen: TeardownReason[] = [];
        const ledger = new Ledger('test');
        ledger.register((r) => { seen.push(r); }, 'plain');
        ledger.effect(() => (r) => { seen.push(r); }, 'fx');
        ledger.effect(function* (): Generator<Disposer> {
          yield (r) => { seen.push(r); };
        }, 'gen');
        const child = ledger.createChild('child');
        child.register((r) => { seen.push(r); }, 'child-plain');

        await ledger.teardown(reason);
        expect(seen).toEqual([reason, reason, reason, reason]);
      },
    );

    it('entry.dispose(reason) propagates the reason', () => {
      const seen: TeardownReason[] = [];
      const ledger = new Ledger('test');
      const entry = ledger.register((r) => { seen.push(r); }, 'plain');
      void entry.dispose('cascade');
      expect(seen).toEqual(['cascade']);
    });
  });

  describe('clear', () => {
    it('tears down current entries but keeps the ledger active', () => {
      const events: string[] = [];
      const ledger = new Ledger('test');
      ledger.register(() => { events.push('a'); }, 'a');
      void ledger.clear();
      expect(events).toEqual(['a']);
      expect(ledger.state).toBe('active');
      ledger.register(() => { events.push('b'); }, 'b');
      void ledger.teardown();
      expect(events).toEqual(['a', 'b']);
    });
  });
});
