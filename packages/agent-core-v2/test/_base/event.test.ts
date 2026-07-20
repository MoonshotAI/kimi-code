import { afterEach, describe, expect, it } from 'vitest';

import { Disposable, DisposableStore, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, Event } from '#/_base/event';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';

afterEach(() => {
  resetUnexpectedErrorHandler();
});

function captureThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Emitter / Event', () => {
  it('fire delivers to all listeners in subscribe order', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event((value) => seen.push(`a:${value}`));
    emitter.event((value) => seen.push(`b:${value}`));
    emitter.event((value) => seen.push(`c:${value}`));

    emitter.fire(1);
    emitter.fire(2);

    expect(seen).toEqual(['a:1', 'b:1', 'c:1', 'a:2', 'b:2', 'c:2']);
    emitter.dispose();
  });

  it('returned IDisposable removes the listener', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const subscription = emitter.event((value) => seen.push(value));

    emitter.fire(1);
    subscription.dispose();
    emitter.fire(2);

    expect(seen).toEqual([1]);
    emitter.dispose();
  });

  it('binds thisArg so the listener sees the supplied context', () => {
    const emitter = new Emitter<string>();
    const context = { tag: 'ctx', got: [] as string[] };

    emitter.event(
      function (this: typeof context, value: string) {
        this.got.push(value);
      },
      context,
    );
    emitter.fire('hello');

    expect(context.got).toEqual(['hello']);
    emitter.dispose();
  });

  it('listener exception routes to onUnexpectedError and does not skip siblings', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((error) => captured.push(error));
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event(() => {
      seen.push('a');
    });
    emitter.event(() => {
      throw new Error('listener-boom');
    });
    emitter.event(() => {
      seen.push('c');
    });

    emitter.fire(1);

    expect(seen).toEqual(['a', 'c']);
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('listener-boom');
    emitter.dispose();
  });

  it('dispose makes fire a no-op and event subscribe returns Disposable.None', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    emitter.event((value) => seen.push(value));

    emitter.dispose();
    emitter.fire(1);
    const subscription = emitter.event((value) => seen.push(value));
    emitter.fire(2);

    expect(seen).toEqual([]);
    expect(subscription).toBe(Disposable.None);
    expect(() => subscription.dispose()).not.toThrow();
  });

  it('disposables array overload collects the subscription disposable', () => {
    const emitter = new Emitter<number>();
    const bag: IDisposable[] = [];

    emitter.event(() => undefined, undefined, bag);

    expect(bag).toHaveLength(1);
    emitter.dispose();
  });

  it('disposables DisposableStore overload collects the subscription disposable', () => {
    const emitter = new Emitter<number>();
    const store = new DisposableStore();
    const seen: number[] = [];

    emitter.event((value) => seen.push(value), undefined, store);
    emitter.fire(1);
    store.dispose();
    emitter.fire(2);

    expect(seen).toEqual([1]);
    emitter.dispose();
  });

  it('listener added during fire does not receive the in-flight value', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event(() => {
      seen.push('a');
      emitter.event(() => seen.push('late'));
    });

    emitter.fire(1);
    expect(seen).toEqual(['a']);
    emitter.fire(2);
    expect(seen).toEqual(['a', 'a', 'late']);
    emitter.dispose();
  });

  it('listener removing itself during fire does not corrupt iteration', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    const subA = emitter.event(() => {
      seen.push('a');
      subA.dispose();
    });
    emitter.event(() => seen.push('b'));

    emitter.fire(1);
    emitter.fire(2);

    expect(seen).toEqual(['a', 'b', 'b']);
    emitter.dispose();
  });
});

describe('Event.None', () => {
  it('returns Disposable.None and never fires', () => {
    const seen: number[] = [];
    const subscription = Event.None(() => seen.push(1));

    expect(subscription).toBe(Disposable.None);
    expect(seen).toHaveLength(0);
  });
});

describe('Event.once', () => {
  it('delivers exactly once then auto-disposes', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    Event.once(emitter.event)((value) => seen.push(value));

    emitter.fire(1);
    emitter.fire(2);

    expect(seen).toEqual([1]);
    emitter.dispose();
  });
});

describe('Event.map', () => {
  it('projects values', () => {
    const emitter = new Emitter<number>();
    const doubled = Event.map(emitter.event, (value) => value * 2);
    const seen: number[] = [];

    doubled((value) => seen.push(value));
    emitter.fire(3);
    emitter.fire(5);

    expect(seen).toEqual([6, 10]);
    emitter.dispose();
  });
});

describe('Event.filter', () => {
  it('drops values that fail the predicate', () => {
    const emitter = new Emitter<number>();
    const evens = Event.filter(emitter.event, (value) => value % 2 === 0);
    const seen: number[] = [];

    evens((value) => seen.push(value));
    emitter.fire(1);
    emitter.fire(2);
    emitter.fire(3);
    emitter.fire(4);

    expect(seen).toEqual([2, 4]);
    emitter.dispose();
  });
});

describe('Event.any', () => {
  it('forwards any source fire to the subscriber', () => {
    const a = new Emitter<string>();
    const b = new Emitter<string>();
    const seen: string[] = [];
    Event.any(a.event, b.event)((value) => seen.push(value));

    a.fire('A');
    b.fire('B');
    a.fire('A2');

    expect(seen).toEqual(['A', 'B', 'A2']);
    a.dispose();
    b.dispose();
  });

  it('disposing the combined subscription detaches from all sources', () => {
    const a = new Emitter<string>();
    const b = new Emitter<string>();
    const seen: string[] = [];
    const subscription = Event.any(a.event, b.event)((value) => seen.push(value));

    a.fire('A');
    subscription.dispose();
    a.fire('A2');
    b.fire('B');

    expect(seen).toEqual(['A']);
    a.dispose();
    b.dispose();
  });

  it('disposing the combined subscription disposes all source subscriptions before throwing AggregateError', () => {
    const order: string[] = [];
    const first: Event<string> = () => ({
      dispose: () => {
        order.push('first');
        throw new Error('first-dispose');
      },
    });
    const second: Event<string> = () => ({
      dispose: () => {
        order.push('second');
        throw new Error('second-dispose');
      },
    });

    const error = captureThrown(() => {
      Event.any(first, second)(() => undefined).dispose();
    });

    expect(order).toEqual(['first', 'second']);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((err) => (err as Error).message)).toEqual([
      'first-dispose',
      'second-dispose',
    ]);
  });
});
