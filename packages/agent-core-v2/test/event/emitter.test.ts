import { describe, expect, it } from 'vitest';

import { AsyncEmitter, handleVetos, type IWaitUntil, type IWaitUntilData } from '#/_base/event';

interface TestEvent extends IWaitUntil {
  readonly value: number;
}

function fire(
  emitter: AsyncEmitter<TestEvent>,
  data: IWaitUntilData<TestEvent>,
  signal = new AbortController().signal,
): Promise<void> {
  return emitter.fireAsync(data, signal);
}

describe('AsyncEmitter', () => {
  it('resolves without delivering when there are no listeners', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    await expect(fire(emitter, { value: 1 })).resolves.toBeUndefined();
  });

  it('awaits every waitUntil promise before resolving', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    const order: string[] = [];
    emitter.event((e) => {
      e.waitUntil(
        new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          order.push('a');
        }),
      );
      e.waitUntil(
        Promise.resolve().then(() => {
          order.push('b');
        }),
      );
    });
    await fire(emitter, { value: 1 });
    expect(order.sort()).toEqual(['a', 'b']);
  });

  it('delivers to listeners sequentially in registration order', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    const order: string[] = [];
    emitter.event((e) => {
      e.waitUntil(
        new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          order.push('first-done');
        }),
      );
      order.push('first');
    });
    emitter.event(() => {
      order.push('second');
    });
    await fire(emitter, { value: 1 });
    expect(order).toEqual(['first', 'first-done', 'second']);
  });

  it('exposes the abort signal and data fields on the event', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    const ac = new AbortController();
    let seen: { value: number; aborted: boolean } | undefined;
    emitter.event((e) => {
      seen = { value: e.value, aborted: e.signal.aborted };
    });
    await fire(emitter, { value: 42 }, ac.signal);
    expect(seen).toEqual({ value: 42, aborted: false });
  });

  it('rejects waitUntil calls made after the synchronous delivery phase', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    let captured: TestEvent | undefined;
    emitter.event((e) => {
      captured = e;
    });
    await fire(emitter, { value: 1 });
    expect(captured).toBeDefined();
    expect(() => captured!.waitUntil(Promise.resolve())).toThrow(/asynchronously/);
  });

  it('stops delivering once the signal is aborted', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    const ac = new AbortController();
    const seen: string[] = [];
    emitter.event((e) => {
      seen.push('first');
      e.waitUntil(
        Promise.resolve().then(() => {
          ac.abort();
        }),
      );
    });
    emitter.event(() => {
      seen.push('second');
    });
    await fire(emitter, { value: 1 }, ac.signal);
    expect(seen).toEqual(['first']);
  });

  it('isolates a throwing listener and still delivers to the rest', async () => {
    const emitter = new AsyncEmitter<TestEvent>();
    const seen: string[] = [];
    emitter.event(() => {
      throw new Error('boom');
    });
    emitter.event(() => {
      seen.push('ok');
    });
    await fire(emitter, { value: 1 });
    expect(seen).toEqual(['ok']);
  });
});

describe('handleVetos', () => {
  const noop = (): void => {};

  it('returns false when there are no vetos', async () => {
    await expect(handleVetos([], noop)).resolves.toBe(false);
  });

  it('short-circuits to true on a synchronous veto', async () => {
    await expect(handleVetos([false, true, Promise.resolve(true)], noop)).resolves.toBe(true);
  });

  it('returns false when all vetos are false', async () => {
    await expect(handleVetos([false, Promise.resolve(false)], noop)).resolves.toBe(false);
  });

  it('returns true when a promise veto resolves to true', async () => {
    await expect(handleVetos([false, Promise.resolve(true)], noop)).resolves.toBe(true);
  });

  it('treats a rejected promise veto as a veto and reports the error', async () => {
    const errors: unknown[] = [];
    const result = await handleVetos([Promise.reject(new Error('boom'))], (e) => errors.push(e));
    expect(result).toBe(true);
    expect(errors).toHaveLength(1);
  });
});
