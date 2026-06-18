import { describe, expect, it } from 'vitest';

import {
  Disposable,
  DisposableMap,
  DisposableSet,
  DisposableStore,
  AsyncReferenceCollection,
  ImmortalReference,
  MandatoryMutableDisposable,
  MutableDisposable,
  ReferenceCollection,
  RefCountedDisposable,
  combinedDisposable,
  dispose,
  disposeIfDisposable,
  thenIfNotDisposed,
  thenRegisterOrDispose,
  toDisposable,
  type IReference,
  type IDisposable,
} from '#/di/lifecycle';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/errors/unexpectedError';

function makeRecorder(label: string, store: string[]): IDisposable {
  return {
    dispose() {
      store.push(label);
    },
  };
}

function makeThrower(message: string): IDisposable {
  return {
    dispose() {
      throw new Error(message);
    },
  };
}

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function expectErrorMessage(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(message);
}

function expectAggregateMessages(error: unknown, messages: string[]): void {
  expect(error).toBeInstanceOf(AggregateError);
  const aggregate = error as AggregateError;
  expect(aggregate.message).toBe('Encountered errors while disposing of store');
  expect(aggregate.errors.map((err) => (err as Error).message)).toEqual(messages);
}

describe('dispose', () => {
  it('disposes one value', () => {
    const order: string[] = [];
    const rec = makeRecorder('a', order);
    expect(dispose(rec)).toBe(rec);
    expect(order).toEqual(['a']);
  });

  it('disposes all iterable entries before rethrowing one child error', () => {
    const order: string[] = [];
    const error = captureThrown(() =>
      dispose([
        makeRecorder('a', order),
        makeThrower('dispose-one'),
        makeRecorder('c', order),
      ]),
    );

    expect(order).toEqual(['a', 'c']);
    expectErrorMessage(error, 'dispose-one');
  });

  it('disposes all iterable entries before throwing AggregateError for multiple child errors', () => {
    const order: string[] = [];
    const error = captureThrown(() =>
      dispose([
        makeRecorder('a', order),
        makeThrower('dispose-one'),
        makeThrower('dispose-two'),
        makeRecorder('d', order),
      ]),
    );

    expect(order).toEqual(['a', 'd']);
    expectAggregateMessages(error, ['dispose-one', 'dispose-two']);
  });

  it('returns a new empty array for array input', () => {
    const values = [makeRecorder('a', [])];
    const disposed = dispose(values);

    expect(values).toHaveLength(1);
    expect(disposed).toEqual([]);
    expect(disposed).not.toBe(values);
  });
});

describe('disposeIfDisposable', () => {
  it('disposes all disposable entries before rethrowing one child error', () => {
    const order: string[] = [];
    const values = [
      makeRecorder('a', order),
      makeThrower('dispose-if'),
      makeRecorder('c', order),
    ];

    const error = captureThrown(() => disposeIfDisposable(values));

    expect(order).toEqual(['a', 'c']);
    expectErrorMessage(error, 'dispose-if');
  });

  it('collects multiple child errors into AggregateError', () => {
    const order: string[] = [];
    const values = [
      makeRecorder('a', order),
      makeThrower('dispose-if-one'),
      {},
      makeThrower('dispose-if-two'),
      makeRecorder('e', order),
    ];

    const error = captureThrown(() => disposeIfDisposable(values));

    expect(order).toEqual(['a', 'e']);
    expectAggregateMessages(error, ['dispose-if-one', 'dispose-if-two']);
  });
});

describe('Disposable.None', () => {
  it('dispose is a no-op and is idempotent', () => {
    expect(() => { Disposable.None.dispose(); }).not.toThrow();
    expect(() => { Disposable.None.dispose(); }).not.toThrow();
  });
});

describe('toDisposable', () => {
  it('invokes fn exactly once', () => {
    let calls = 0;
    const d = toDisposable(() => {
      calls += 1;
    });
    d.dispose();
    d.dispose();
    expect(calls).toBe(1);
  });

  it('throws cleanup errors', () => {
    const d = toDisposable(() => {
      throw new Error('function-dispose');
    });

    const error = captureThrown(() => { d.dispose(); });

    expectErrorMessage(error, 'function-dispose');
    expect(() => { d.dispose(); }).not.toThrow();
  });
});

describe('combinedDisposable', () => {
  it('disposes all children in insertion order', () => {
    const order: string[] = [];
    const d = combinedDisposable(
      makeRecorder('a', order),
      makeRecorder('b', order),
      makeRecorder('c', order),
    );
    d.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('continues even if a child throws, then rethrows the child error', () => {
    const order: string[] = [];
    const d = combinedDisposable(
      makeRecorder('a', order),
      makeThrower('child-boom'),
      makeRecorder('c', order),
    );

    const error = captureThrown(() => { d.dispose(); });

    expect(order).toEqual(['a', 'c']);
    expectErrorMessage(error, 'child-boom');
  });

  it('collects multiple child errors into AggregateError', () => {
    const order: string[] = [];
    const d = combinedDisposable(
      makeRecorder('a', order),
      makeThrower('child-one'),
      makeThrower('child-two'),
      makeRecorder('d', order),
    );

    const error = captureThrown(() => { d.dispose(); });

    expect(order).toEqual(['a', 'd']);
    expectAggregateMessages(error, ['child-one', 'child-two']);
  });

  it('is idempotent — second dispose is a no-op', () => {
    const order: string[] = [];
    const d = combinedDisposable(makeRecorder('a', order));
    d.dispose();
    d.dispose();
    expect(order).toEqual(['a']);
  });
});

describe('MutableDisposable', () => {
  it('value setter disposes the prior value', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    expect(order).toEqual([]);
    slot.value = makeRecorder('b', order);
    expect(order).toEqual(['a']);
    slot.value = undefined;
    expect(order).toEqual(['a', 'b']);
  });

  it('throws errors from the previous value when replacing it', () => {
    const slot = new MutableDisposable<IDisposable>();
    const previous = makeThrower('slot-previous');
    const next = makeRecorder('next', []);
    slot.value = previous;

    const error = captureThrown(() => {
      slot.value = next;
    });

    expectErrorMessage(error, 'slot-previous');
    expect(slot.value).toBe(previous);
  });

  it('same value assignment is a no-op (does not dispose itself)', () => {
    const order: string[] = [];
    const rec = makeRecorder('a', order);
    const slot = new MutableDisposable<IDisposable>();
    slot.value = rec;
    slot.value = rec;
    expect(order).toEqual([]);
  });

  it('dispose disposes the current value and is idempotent', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    slot.dispose();
    slot.dispose();
    expect(order).toEqual(['a']);
  });

  it('post-dispose assignment disposes the new value immediately', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.dispose();
    slot.value = makeRecorder('a', order);
    expect(order).toEqual(['a']);

    expect(slot.value).toBeUndefined();
  });

  it('post-dispose assignment throws if immediate disposal fails', () => {
    const slot = new MutableDisposable<IDisposable>();
    slot.dispose();

    const error = captureThrown(() => {
      slot.value = makeThrower('slot-after-dispose');
    });

    expectErrorMessage(error, 'slot-after-dispose');
  });

  it('clear disposes without closing the slot', () => {
    const order: string[] = [];
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeRecorder('a', order);
    slot.clear();
    expect(order).toEqual(['a']);
    slot.value = makeRecorder('b', order);
    slot.dispose();
    expect(order).toEqual(['a', 'b']);
  });

  it('clear throws current value cleanup errors', () => {
    const slot = new MutableDisposable<IDisposable>();
    const previous = makeThrower('slot-clear');
    slot.value = previous;

    const error = captureThrown(() => { slot.clear(); });

    expectErrorMessage(error, 'slot-clear');
    expect(slot.value).toBe(previous);
  });

  it('dispose throws current value cleanup errors', () => {
    const slot = new MutableDisposable<IDisposable>();
    slot.value = makeThrower('slot-dispose');

    const error = captureThrown(() => { slot.dispose(); });

    expectErrorMessage(error, 'slot-dispose');
    expect(slot.value).toBeUndefined();
  });
});

describe('DisposableStore', () => {
  it('add returns the child', () => {
    const store = new DisposableStore();
    const rec = makeRecorder('a', []);
    expect(store.add(rec)).toBe(rec);
    store.dispose();
  });

  it('dispose tears down children in insertion order', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeRecorder('b', order));
    store.add(makeRecorder('c', order));
    store.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('clear disposes children but keeps the store usable', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeRecorder('b', order));
    store.clear();
    expect(order).toEqual(['a', 'b']);
    store.add(makeRecorder('c', order));
    store.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('delete removes a child AND disposes it', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    const rec = makeRecorder('a', order);
    store.add(rec);
    store.delete(rec);
    expect(order).toEqual(['a']);

    store.dispose();
    expect(order).toEqual(['a']);
  });

  it('deleteAndLeak removes a child WITHOUT disposing it', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    const rec = makeRecorder('a', order);
    store.add(rec);
    store.deleteAndLeak(rec);
    store.dispose();
    expect(order).toEqual([]);
  });

  it('post-dispose add disposes the incoming child immediately', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.dispose();
    store.add(makeRecorder('a', order));
    expect(order).toEqual(['a']);
    expect(store.isDisposed).toBe(true);
  });

  it('is idempotent — second dispose is a no-op', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.dispose();
    store.dispose();
    expect(order).toEqual(['a']);
  });

  it('post-dispose add throws if immediate child disposal fails', () => {
    const store = new DisposableStore();
    store.dispose();

    const error = captureThrown(() => store.add(makeThrower('store-add-closed')));

    expectErrorMessage(error, 'store-add-closed');
  });

  it('continues even if a child throws, then rethrows the child error', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeThrower('store-child-boom'));
    store.add(makeRecorder('c', order));

    const error = captureThrown(() => { store.dispose(); });

    expect(order).toEqual(['a', 'c']);
    expectErrorMessage(error, 'store-child-boom');
  });

  it('collects multiple child errors into AggregateError', () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.add(makeRecorder('a', order));
    store.add(makeThrower('store-one'));
    store.add(makeThrower('store-two'));
    store.add(makeRecorder('d', order));

    const error = captureThrown(() => { store.dispose(); });

    expect(order).toEqual(['a', 'd']);
    expectAggregateMessages(error, ['store-one', 'store-two']);
  });

  it('clear removes children even when disposal throws', () => {
    const store = new DisposableStore();
    store.add(makeThrower('store-clear'));

    const error = captureThrown(() => { store.clear(); });

    expectErrorMessage(error, 'store-clear');
    expect(() => { store.clear(); }).not.toThrow();
  });

  it('delete throws child cleanup errors', () => {
    const store = new DisposableStore();
    const child = makeThrower('store-delete');
    store.add(child);

    const error = captureThrown(() => { store.delete(child); });

    expectErrorMessage(error, 'store-delete');
    expect(() => { store.dispose(); }).not.toThrow();
  });

  it('assertNotDisposed reports through onUnexpectedError after disposal', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    const store = new DisposableStore();
    store.dispose();

    store.assertNotDisposed();

    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('Object disposed');
    resetUnexpectedErrorHandler();
  });
});

describe('MandatoryMutableDisposable', () => {
  it('always exposes a value and disposes replacements', () => {
    const order: string[] = [];
    const first = makeRecorder('a', order);
    const second = makeRecorder('b', order);
    const slot = new MandatoryMutableDisposable(first);

    expect(slot.value).toBe(first);
    slot.value = second;
    expect(order).toEqual(['a']);
    expect(slot.value).toBe(second);
    slot.dispose();
    expect(order).toEqual(['a', 'b']);
  });
});

describe('RefCountedDisposable', () => {
  it('disposes the inner value when the final reference is released', () => {
    const order: string[] = [];
    const counted = new RefCountedDisposable(makeRecorder('a', order));

    expect(counted.acquire()).toBe(counted);
    expect(counted.release()).toBe(counted);
    expect(order).toEqual([]);
    counted.release();
    expect(order).toEqual(['a']);
  });
});

describe('ReferenceCollection', () => {
  class TestCollection extends ReferenceCollection<number> {
    created = 0;
    destroyed: Array<[string, number]> = [];

    protected createReferencedObject(key: string): number {
      this.created += 1;
      return key.length;
    }

    protected destroyReferencedObject(key: string, object: number): void {
      this.destroyed.push([key, object]);
    }
  }

  it('shares references by key and destroys after the last release', () => {
    const collection = new TestCollection();

    const first = collection.acquire('abcd');
    const second = collection.acquire('abcd');
    expect(first.object).toBe(4);
    expect(second.object).toBe(first.object);
    expect(collection.created).toBe(1);

    first.dispose();
    expect(collection.destroyed).toEqual([]);
    second.dispose();
    expect(collection.destroyed).toEqual([['abcd', 4]]);
  });

  it('reference dispose is idempotent', () => {
    const collection = new TestCollection();
    const ref = collection.acquire('x');

    ref.dispose();
    ref.dispose();

    expect(collection.destroyed).toEqual([['x', 1]]);
  });
});

describe('AsyncReferenceCollection', () => {
  class AsyncTestCollection extends ReferenceCollection<Promise<number>> {
    destroyed: string[] = [];

    protected createReferencedObject(key: string): Promise<number> {
      if (key === 'reject') return Promise.reject(new Error('async-reference'));
      return Promise.resolve(key.length);
    }

    protected destroyReferencedObject(key: string): void {
      this.destroyed.push(key);
    }
  }

  it('unwraps promised references', async () => {
    const collection = new AsyncTestCollection();
    const asyncCollection = new AsyncReferenceCollection(collection);

    const ref = await asyncCollection.acquire('abc');
    expect(ref.object).toBe(3);
    ref.dispose();
    expect(collection.destroyed).toEqual(['abc']);
  });

  it('disposes the underlying reference when the promise rejects', async () => {
    const collection = new AsyncTestCollection();
    const asyncCollection = new AsyncReferenceCollection(collection);

    await expect(asyncCollection.acquire('reject')).rejects.toThrow('async-reference');
    expect(collection.destroyed).toEqual(['reject']);
  });
});

describe('ImmortalReference', () => {
  it('keeps the object available after dispose', () => {
    const ref: IReference<string> = new ImmortalReference('value');

    ref.dispose();

    expect(ref.object).toBe('value');
  });
});

describe('thenIfNotDisposed', () => {
  it('runs the continuation when still alive', async () => {
    let value = 0;
    const disposable = thenIfNotDisposed(Promise.resolve(123), (result) => {
      value = result;
    });

    await Promise.resolve();

    expect(value).toBe(123);
    disposable.dispose();
  });

  it('skips the continuation after disposal', async () => {
    let value = 0;
    const disposable = thenIfNotDisposed(Promise.resolve(123), (result) => {
      value = result;
    });

    disposable.dispose();
    await Promise.resolve();

    expect(value).toBe(0);
  });
});

describe('thenRegisterOrDispose', () => {
  it('registers the resolved disposable when the store is alive', async () => {
    const order: string[] = [];
    const store = new DisposableStore();
    const child = makeRecorder('a', order);

    await expect(thenRegisterOrDispose(Promise.resolve(child), store)).resolves.toBe(
      child,
    );
    expect(order).toEqual([]);
    store.dispose();
    expect(order).toEqual(['a']);
  });

  it('disposes the resolved disposable when the store has already been disposed', async () => {
    const order: string[] = [];
    const store = new DisposableStore();
    store.dispose();

    const child = makeRecorder('a', order);
    await expect(thenRegisterOrDispose(Promise.resolve(child), store)).resolves.toBe(
      child,
    );
    expect(order).toEqual(['a']);
  });
});

describe('DisposableMap', () => {
  it('clearAndDisposeAll clears entries even when disposal throws', () => {
    const map = new DisposableMap<string>();
    map.set('a', makeThrower('map-clear'));

    const error = captureThrown(() => { map.clearAndDisposeAll(); });

    expectErrorMessage(error, 'map-clear');
    expect(map.size).toBe(0);
  });

  it('collects clearAndDisposeAll child errors into AggregateError', () => {
    const order: string[] = [];
    const map = new DisposableMap<string>();
    map.set('a', makeRecorder('a', order));
    map.set('b', makeThrower('map-one'));
    map.set('c', makeThrower('map-two'));
    map.set('d', makeRecorder('d', order));

    const error = captureThrown(() => { map.clearAndDisposeAll(); });

    expect(order).toEqual(['a', 'd']);
    expectAggregateMessages(error, ['map-one', 'map-two']);
    expect(map.size).toBe(0);
  });

  it('throws errors from overwritten values', () => {
    const map = new DisposableMap<string>();
    const previous = makeThrower('map-overwrite');
    const next = makeRecorder('next', []);
    map.set('a', previous);

    const error = captureThrown(() => { map.set('a', next); });

    expectErrorMessage(error, 'map-overwrite');
    expect(map.get('a')).toBe(previous);
  });

  it('deleteAndDispose throws child cleanup errors', () => {
    const map = new DisposableMap<string>();
    map.set('a', makeThrower('map-delete'));

    const error = captureThrown(() => { map.deleteAndDispose('a'); });

    expectErrorMessage(error, 'map-delete');
    expect(map.has('a')).toBe(true);
  });
});

describe('DisposableSet', () => {
  it('clearAndDisposeAll clears values even when disposal throws', () => {
    const set = new DisposableSet();
    set.add(makeThrower('set-clear'));

    const error = captureThrown(() => { set.clearAndDisposeAll(); });

    expectErrorMessage(error, 'set-clear');
    expect(set.size).toBe(0);
  });

  it('collects clearAndDisposeAll child errors into AggregateError', () => {
    const order: string[] = [];
    const set = new DisposableSet();
    set.add(makeRecorder('a', order));
    set.add(makeThrower('set-one'));
    set.add(makeThrower('set-two'));
    set.add(makeRecorder('d', order));

    const error = captureThrown(() => { set.clearAndDisposeAll(); });

    expect(order).toEqual(['a', 'd']);
    expectAggregateMessages(error, ['set-one', 'set-two']);
    expect(set.size).toBe(0);
  });

  it('deleteAndDispose throws child cleanup errors after removing the value', () => {
    const set = new DisposableSet();
    const value = makeThrower('set-delete');
    set.add(value);

    const error = captureThrown(() => { set.deleteAndDispose(value); });

    expectErrorMessage(error, 'set-delete');
    expect(set.has(value)).toBe(false);
  });
});

describe('Disposable base class', () => {
  it('insertion-order teardown', () => {
    const order: string[] = [];
    class Owner extends Disposable {
      add(label: string): void {
        this._register(makeRecorder(label, order));
      }
    }
    const owner = new Owner();
    owner.add('a');
    owner.add('b');
    owner.add('c');
    owner.dispose();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('registering self throws', () => {
    class Owner extends Disposable {
      registerSelf(): void {
        this._register(this);
      }
    }
    const owner = new Owner();
    expect(() => { owner.registerSelf(); }).toThrow(
      /Cannot register a disposable on itself/,
    );
    owner.dispose();
  });
});
