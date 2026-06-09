import { afterEach, describe, expect, it } from 'vitest';

import { Emitter, Event } from '#/base/common/event';
import { Disposable, DisposableStore, type IDisposable } from '#/di/lifecycle';
import {
  resetUnexpectedErrorHandler,
  setUnexpectedErrorHandler,
} from '#/errors/unexpectedError';

afterEach(() => {
  resetUnexpectedErrorHandler();
});

describe('Emitter / Event', () => {
  it('fire delivers to all listeners in subscribe order', () => {
    const emitter = new Emitter<number>();
    const seen: Array<string> = [];
    emitter.event((v) => seen.push(`a:${v}`));
    emitter.event((v) => seen.push(`b:${v}`));
    emitter.event((v) => seen.push(`c:${v}`));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual(['a:1', 'b:1', 'c:1', 'a:2', 'b:2', 'c:2']);
    emitter.dispose();
  });

  it('returned IDisposable removes the listener', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    const sub = emitter.event((v) => seen.push(v));
    emitter.fire(1);
    sub.dispose();
    emitter.fire(2);
    expect(seen).toEqual([1]);
    emitter.dispose();
  });

  it('thisArg binds the listener correctly', () => {
    const emitter = new Emitter<string>();
    const ctx = { tag: 'ctx', got: [] as string[] };
    emitter.event(
      function (this: typeof ctx, v: string) {
        this.got.push(v);
      },
      ctx,
    );
    emitter.fire('hello');
    expect(ctx.got).toEqual(['hello']);
    emitter.dispose();
  });

  it('listener exception routes to onUnexpectedError and does NOT skip siblings', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
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
    emitter.event((v) => seen.push(v));
    emitter.dispose();
    emitter.fire(1);
    const sub = emitter.event((v) => seen.push(v));
    emitter.fire(2);
    expect(seen).toEqual([]);
    expect(sub).toBe(Disposable.None);
    // Disposing the None handle must not throw.
    expect(() => sub.dispose()).not.toThrow();
  });

  it('dispose is idempotent', () => {
    const emitter = new Emitter<number>();
    emitter.event(() => undefined);
    expect(() => {
      emitter.dispose();
      emitter.dispose();
    }).not.toThrow();
  });

  it('disposables array overload collects the subscription disposable', () => {
    const emitter = new Emitter<number>();
    const bag: IDisposable[] = [];
    emitter.event((_v) => undefined, undefined, bag);
    expect(bag).toHaveLength(1);
    emitter.dispose();
  });

  it('disposables DisposableStore overload collects the subscription disposable', () => {
    const emitter = new Emitter<number>();
    const store = new DisposableStore();
    const seen: number[] = [];
    emitter.event((v) => seen.push(v), undefined, store);
    emitter.fire(1);
    store.dispose();
    emitter.fire(2);
    expect(seen).toEqual([1]);
    emitter.dispose();
  });

  it('listener added during fire does NOT receive the in-flight value', () => {
    const emitter = new Emitter<number>();
    const seen: string[] = [];
    emitter.event(() => {
      seen.push('a');
      emitter.event(() => seen.push('late'));
    });
    emitter.fire(1);
    // The "late" listener was added during fire; the snapshot used for the
    // initial fire doesn't include it.
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
    const sub = Event.None((_v) => seen.push(1));
    expect(sub).toBe(Disposable.None);
    expect(seen).toHaveLength(0);
  });
});

describe('Event.once', () => {
  it('delivers exactly once then auto-disposes', () => {
    const emitter = new Emitter<number>();
    const seen: number[] = [];
    Event.once(emitter.event)((v) => seen.push(v));
    emitter.fire(1);
    emitter.fire(2);
    expect(seen).toEqual([1]);
    emitter.dispose();
  });
});

describe('Event.map', () => {
  it('projects values', () => {
    const emitter = new Emitter<number>();
    const doubled = Event.map(emitter.event, (n) => n * 2);
    const seen: number[] = [];
    doubled((v) => seen.push(v));
    emitter.fire(3);
    emitter.fire(5);
    expect(seen).toEqual([6, 10]);
    emitter.dispose();
  });
});

describe('Event.filter', () => {
  it('drops values that fail the predicate', () => {
    const emitter = new Emitter<number>();
    const evens = Event.filter(emitter.event, (n) => n % 2 === 0);
    const seen: number[] = [];
    evens((v) => seen.push(v));
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
    Event.any(a.event, b.event)((v) => seen.push(v));
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
    const sub = Event.any(a.event, b.event)((v) => seen.push(v));
    a.fire('A');
    sub.dispose();
    a.fire('A2');
    b.fire('B');
    expect(seen).toEqual(['A']);
    a.dispose();
    b.dispose();
  });
});
