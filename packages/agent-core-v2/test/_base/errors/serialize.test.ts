import { describe, expect, it } from 'vitest';

import '#/errors';

import { Error2 } from '#/_base/errors/errors';
import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';

describe('toErrorPayload', () => {
  it('passes a coded error through with registry retryability and details', () => {
    const payload = toErrorPayload(
      new Error2('provider.rate_limit', 'slow down', {
        name: 'APIStatusError',
        details: { requestId: 'req-1' },
      }),
    );
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'APIStatusError',
      details: { requestId: 'req-1' },
      retryable: true,
    });
  });

  it('keeps a status code only when it matches the direct model error status', () => {
    const modelError = Object.assign(
      new Error2('provider.api_error', 'model failure', {
        details: { statusCode: 503, requestId: 'req-model' },
      }),
      { statusCode: 503 },
    );

    expect(toErrorPayload(modelError).details).toEqual({ statusCode: 503, requestId: 'req-model' });
  });

  it('strips KAP-only or mismatched status codes and preserves other diagnostics', () => {
    const kapError = new Error2('internal', 'KAP request failed', {
      details: { statusCode: 503, operation: 'kap-request' },
    });
    const mismatched = Object.assign(
      new Error2('provider.api_error', 'model failure', {
        details: { statusCode: 503, requestId: 'req-model' },
      }),
      { statusCode: 502 },
    );

    expect(toErrorPayload(kapError).details).toEqual({ operation: 'kap-request' });
    expect(toErrorPayload(mismatched).details).toEqual({ requestId: 'req-model' });
  });

  it('tolerates a null details value at runtime', () => {
    const error = Object.assign(new Error2('internal', 'failure'), { details: null });
    expect(toErrorPayload(error).details).toBeUndefined();
  });

  it('collapses an uncoded Error to internal', () => {
    const payload = toErrorPayload(new Error('boom'));
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('boom');
  });

  it('stringifies non-error throws', () => {
    expect(toErrorPayload('nope').code).toBe('internal');
    expect(toErrorPayload(undefined).code).toBe('internal');
  });

  it('serializes the cause chain recursively', () => {
    const payload = toErrorPayload(
      new Error2('provider.api_error', 'translated', {
        cause: new Error2('provider.connection_error', 'socket reset'),
      }),
    );
    expect(payload.code).toBe('provider.api_error');
    expect(payload.cause).toMatchObject({
      code: 'provider.connection_error',
      message: 'socket reset',
    });
  });

  it('caps cause recursion for pathologically deep chains', () => {
    let error: Error2 | undefined;
    for (let i = 0; i < 20; i += 1) {
      error = new Error2('internal', `layer ${i}`, error === undefined ? undefined : { cause: error });
    }
    const payload = toErrorPayload(error!);
    let depth = 0;
    let current = payload;
    while (current.cause !== undefined) {
      depth += 1;
      current = current.cause;
    }
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe('fromErrorPayload', () => {
  it('rehydrates a Error2 with its cause chain', () => {
    const original = new Error2('provider.api_error', 'outer', {
      details: { requestId: 'req-outer' },
      cause: new Error2('provider.connection_error', 'inner'),
    });
    const revived = fromErrorPayload(toErrorPayload(original));
    expect(revived).toBeInstanceOf(Error2);
    expect(revived.code).toBe('provider.api_error');
    expect(revived.details).toMatchObject({ requestId: 'req-outer' });
    expect(revived.cause).toBeInstanceOf(Error2);
    expect((revived.cause as Error2).code).toBe('provider.connection_error');
  });

  it('preserves a verified model HTTP status across repeated serialization', () => {
    const original = Object.assign(
      new Error2('provider.api_error', 'model failure', {
        name: 'APIStatusError',
        details: { statusCode: 503, requestId: 'req-model' },
      }),
      { statusCode: 503 },
    );
    const revived = fromErrorPayload(toErrorPayload(original));
    expect(revived).toMatchObject({ statusCode: 503 });
    expect(toErrorPayload(revived).details).toMatchObject({
      statusCode: 503,
      requestId: 'req-model',
    });
  });

  it('does not promote KAP details into a direct model HTTP status', () => {
    const revived = fromErrorPayload({
      code: 'internal',
      message: 'KAP failure',
      name: 'Error2',
      details: { statusCode: 503 },
      retryable: false,
    });
    expect(revived).not.toHaveProperty('statusCode');
  });
});
