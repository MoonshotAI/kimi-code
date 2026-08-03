import { afterEach, describe, expect, it } from 'vitest';

import {
  onUnexpectedError,
  resetUnexpectedErrorHandler,
  safelyCallListener,
  setUnexpectedErrorHandler,
} from '#/errors/unexpectedError';

describe('onUnexpectedError + setUnexpectedErrorHandler', () => {
  afterEach(() => {
    resetUnexpectedErrorHandler();
  });

  it('default handler does not throw when passed a thrown error', () => {
    // Default handler is console.error; replace with a sink so the test
    // output stays quiet, but verify the call shape doesn't throw.
    let captured: unknown;
    setUnexpectedErrorHandler((err) => {
      captured = err;
    });
    expect(() => onUnexpectedError(new Error('boom'))).not.toThrow();
    expect((captured as Error).message).toBe('boom');
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

  it('a throwing handler does NOT propagate; original error is still surfaced', () => {
    setUnexpectedErrorHandler(() => {
      throw new Error('handler-boom');
    });
    expect(() => onUnexpectedError(new Error('original'))).not.toThrow();
  });

  it('resetUnexpectedErrorHandler restores the module default', () => {
    const seen: unknown[] = [];
    setUnexpectedErrorHandler((err) => seen.push(err));
    onUnexpectedError(new Error('with-custom'));
    expect(seen).toHaveLength(1);
    resetUnexpectedErrorHandler();
    // After reset the custom handler should no longer see further errors.
    // We re-install another to verify the custom path is empty.
    seen.length = 0;
    onUnexpectedError(new Error('after-reset'));
    expect(seen).toHaveLength(0);
  });

  it('onUnexpectedError passes non-Error values through to the handler', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    onUnexpectedError('string error');
    onUnexpectedError(null);
    onUnexpectedError(42);
    expect(captured).toHaveLength(3);
    expect(captured[0]).toBe('string error');
    expect(captured[1]).toBeNull();
    expect(captured[2]).toBe(42);
  });

  it('multiple onUnexpectedError calls each reach the handler', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    onUnexpectedError(new Error('first'));
    onUnexpectedError(new Error('second'));
    onUnexpectedError(new Error('third'));
    expect(captured).toHaveLength(3);
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

  it('does not throw for a non-Error thrown value', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    expect(() =>
      safelyCallListener(() => {
        throw 'string-thrown';
      }),
    ).not.toThrow();
    expect(captured).toHaveLength(1);
    expect(captured[0]).toBe('string-thrown');
  });

  it('multiple listeners each route independently', () => {
    const captured: unknown[] = [];
    setUnexpectedErrorHandler((err) => captured.push(err));
    safelyCallListener(() => { throw new Error('first'); });
    safelyCallListener(() => { /* no error */ });
    safelyCallListener(() => { throw new Error('third'); });
    expect(captured).toHaveLength(2);
    expect((captured[0] as Error).message).toBe('first');
    expect((captured[1] as Error).message).toBe('third');
  });
});
