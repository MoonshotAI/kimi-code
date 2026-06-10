import { APIStatusError } from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { ErrorCodes, toKimiErrorPayload } from '../../src/errors';

describe('toKimiErrorPayload', () => {
  it('classifies provider 403 responses as auth errors', () => {
    const payload = toKimiErrorPayload(
      new APIStatusError(403, 'access_terminated: Access was terminated', 'req-403'),
    );

    expect(payload).toMatchObject({
      code: ErrorCodes.PROVIDER_AUTH_ERROR,
      message: 'access_terminated: Access was terminated',
      name: 'APIStatusError',
      details: {
        statusCode: 403,
        requestId: 'req-403',
      },
      retryable: false,
    });
  });
});
