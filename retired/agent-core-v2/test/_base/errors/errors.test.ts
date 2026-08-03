import { afterEach, describe, expect, it } from 'vitest';

import {
  onUnexpectedError,
  resetUnexpectedErrorHandler,
  safelyCallListener,
  setUnexpectedErrorHandler,
} from '#/_base/errors/unexpectedError';

describe('onUnexpectedError + setUnexpectedErrorHandler', () => {
  afterEach(() => {
    resetUnexpectedErrorHandler();
  });

  it('default handler does not throw when passed a thrown error', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => {
      captured.push(err);
    });

    expect(() => onUnexpectedError(new Error('boom'))).not.toThrow();
    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('boom');
  });

  it('setUnexpectedErrorHandler replaces the previous handler', () => {
    const aSeen: unknown[] = [];
    const bSeen: unknown[] = [];

    setUnexpectedErrorHandler((err) => aSeen.push(err));
    setUnexpectedErrorHandler((err) => bSeen.push(err));
    onUnexpectedError(new Error('after-replace'));

    expect(aSeen).toHaveLength(0);
    expect(bSeen).toHaveLength(1);
  });

  it('a throwing handler does not propagate', () => {
    setUnexpectedErrorHandler(() => {
      throw new Error('handler-boom');
    });

    expect(() => onUnexpectedError(new Error('original'))).not.toThrow();
  });

  it('multiple errors in sequence all reach the handler', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));

    onUnexpectedError(new Error('first'));
    onUnexpectedError(new Error('second'));
    onUnexpectedError(new Error('third'));
    expect(captured).toHaveLength(3);
    expect((captured[0] as Error).message).toBe('first');
    expect((captured[2] as Error).message).toBe('third');
  });

  it('resetUnexpectedErrorHandler restores the module default', () => {
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((err) => seen.push(err));
    onUnexpectedError(new Error('with-custom'));
    expect(seen).toHaveLength(1);

    seen.length = 0;
    resetUnexpectedErrorHandler();
    onUnexpectedError(new Error('after-reset'));

    expect(seen).toHaveLength(0);
  });
});

describe('safelyCallListener', () => {
  afterEach(() => {
    resetUnexpectedErrorHandler();
  });

  it('invokes the listener', () => {
    let called = false;

    safelyCallListener(() => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it('routes a thrown error to the installed handler', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));

    expect(() =>
      safelyCallListener(() => {
        throw new Error('listener-boom');
      }),
    ).not.toThrow();

    expect(captured).toHaveLength(1);
    expect((captured[0] as Error).message).toBe('listener-boom');
  });

  it('safelyCallListener with multiple listeners: each error is individually routed', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));

    safelyCallListener(() => {
      throw new Error('first');
    });
    safelyCallListener(() => {
      throw new Error('second');
    });

    expect(captured).toHaveLength(2);
    expect((captured[0] as Error).message).toBe('first');
    expect((captured[1] as Error).message).toBe('second');
  });

  it('safelyCallListener with a non-error thrown value is still routed', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));

    safelyCallListener(() => {
      throw 'string-throw';
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('string-throw');
  });
});
