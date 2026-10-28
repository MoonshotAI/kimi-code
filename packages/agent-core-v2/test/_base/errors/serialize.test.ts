import { describe, expect, it } from 'vitest';

import '#/errors';

import { Error2 } from '#/_base/errors/errors';
import { fromErrorPayload, toErrorPayload } from '#/_base/errors/serialize';
import { APIStatusError, LlmError } from '#/llm-adapter/contract/errors';

describe('toErrorPayload', () => {
  it('passes a coded error through with registry retryability and details', () => {
    const payload = toErrorPayload(new APIStatusError(429, 'slow down'));
    expect(payload).toMatchObject({
      code: 'provider.rate_limit',
      message: 'slow down',
      name: 'APIStatusError',
      details: { statusCode: 429 },
      retryable: true,
    });
  });

  it('removes KAP statusCode details while preserving the remaining internal metadata', () => {
    const payload = toErrorPayload(
      new Error2('internal', 'KAP request failed', {
        details: { statusCode: 503, operation: 'kap-request' },
      }),
    );

    expect(payload.code).toBe('internal');
    expect(payload.details).toEqual({ operation: 'kap-request' });
    expect(payload).not.toHaveProperty('details.statusCode');
  });

  it('treats null details as absent instead of failing serialization', () => {
    const error = { code: 'internal', message: 'null details', details: null };

    expect(() => toErrorPayload(error)).not.toThrow();
    expect(toErrorPayload(error).details).toBeUndefined();
  });

  it('retains actual HTTP 503 metadata for canonical and legacy model errors', () => {
    const legacy = new APIStatusError(503, 'legacy unavailable', 'req-legacy-503', null, 'trace-legacy-503');
    const canonical = new LlmError({
      kind: 'status',
      message: 'canonical unavailable',
      statusCode: 503,
      requestId: 'req-canonical-503',
      retryAfterMs: null,
      headers: { 'x-trace-id': 'trace-canonical-503' },
    });

    expect(toErrorPayload(legacy).details).toEqual({
      statusCode: 503,
      requestId: 'req-legacy-503',
      traceId: 'trace-legacy-503',
    });
    expect(toErrorPayload(canonical).details).toEqual({
      statusCode: 503,
      requestId: 'req-canonical-503',
      traceId: 'trace-canonical-503',
    });
  });

  it('preserves stream request and trace metadata without adding an HTTP status', () => {
    const stream = new LlmError({
      kind: 'rate_limit',
      message: 'stream rate limit',
      requestId: 'req-stream',
      retryAfterMs: null,
      headers: { 'x-trace-id': 'trace-stream' },
    });
    const payload = toErrorPayload(stream);

    expect(payload.details).toEqual({ requestId: 'req-stream', traceId: 'trace-stream' });
    expect(payload).not.toHaveProperty('details.statusCode');
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
      details: { operation: 'outer-operation' },
      cause: new Error2('provider.connection_error', 'inner'),
    });
    const revived = fromErrorPayload(toErrorPayload(original));
    expect(revived).toBeInstanceOf(Error2);
    expect(revived.code).toBe('provider.api_error');
    expect(revived.details).toMatchObject({ operation: 'outer-operation' });
    expect(revived.cause).toBeInstanceOf(Error2);
    expect((revived.cause as Error2).code).toBe('provider.connection_error');
  });
});
