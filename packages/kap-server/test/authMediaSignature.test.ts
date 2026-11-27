import { describe, expect, it, vi } from 'vitest';

import { createAuthHook } from '../src/middleware/auth';

const SIGNED_PATH = '/api/v1/sessions/session-1/fs/media/clip.mp4:download';
const SIGNATURE = 'valid-signature';

function request(
  overrides: { method?: string; url?: string; headers?: Record<string, string> } = {},
): Record<string, unknown> {
  return {
    method: 'GET',
    url: `${SIGNED_PATH}?allow_external_symlinks=true&signature=${SIGNATURE}`,
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  };
}

function reply(): {
  status: number;
  payload: unknown;
  code(status: number): unknown;
  send(payload: unknown): unknown;
} {
  const state = {
    status: 200,
    payload: undefined as unknown,
    code(status: number) {
      state.status = status;
      return state;
    },
    send(payload: unknown) {
      state.payload = payload;
      return state;
    },
  };
  return state;
}

function hook(opts: { recordFailure?: (ip: string) => void } = {}) {
  return createAuthHook(
    { getToken: () => 'bearer-token', isValid: (candidate: string) => candidate === 'bearer-token' } as never,
    {
      limiter: { recordFailure: opts.recordFailure ?? (() => {}), isBanned: () => false },
      validateCredential: async (candidate) => candidate === 'bearer-token',
      validateMediaSignature: (candidate) => candidate === SIGNATURE,
    },
  );
}

describe('signed media requests', () => {
  it('authorizes a workspace file download with a valid signature and no bearer header', async () => {
    const response = reply();
    await hook()(request() as never, response as never);
    expect(response.payload).toBeUndefined();
    expect(response.status).toBe(200);
  });

  it('rejects an invalid signature', async () => {
    const response = reply();
    await hook()(
      request({ url: `${SIGNED_PATH}?signature=wrong` }) as never,
      response as never,
    );
    expect(response.status).toBe(401);
  });

  it('does not count signature attempts toward the auth failure limiter', async () => {
    const recordFailure = vi.fn();
    const response = reply();
    await hook({ recordFailure })(
      request({ url: `${SIGNED_PATH}?signature=wrong` }) as never,
      response as never,
    );
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('does not authorize signed requests on other API routes', async () => {
    const response = reply();
    await hook()(
      request({ url: '/api/v1/sessions/session-1/media/file-1?signature=' + SIGNATURE }) as never,
      response as never,
    );
    expect(response.status).toBe(401);
  });

  it('does not authorize signed requests with a non-GET method', async () => {
    const response = reply();
    await hook()(request({ method: 'POST' }) as never, response as never);
    expect(response.status).toBe(401);
  });

  it('still authorizes requests carrying a bearer token', async () => {
    const response = reply();
    await hook()(
      request({ url: SIGNED_PATH, headers: { authorization: 'Bearer bearer-token' } }) as never,
      response as never,
    );
    expect(response.payload).toBeUndefined();
  });
});