import { describe, expect, it, vi } from 'vitest';

import { createAuthHook } from '../src/middleware/auth';
import {
  createMediaSignatureService,
  type MediaSignatureService,
  type MediaSignatureTarget,
} from '../src/services/mediaSignature/mediaSignatureService';

const SESSION_ID = 'session-1';
const FILE_PATH = 'media/clip.mp4';
const DIRECT_PATH = `/api/v1/sessions/${SESSION_ID}/fs/${FILE_PATH}:download`;
const PROXY_PATH = `/api/v1/hosts/host-1/proxy/api/v1/sessions/${SESSION_ID}/fs/${FILE_PATH}:download`;

function target(overrides: Partial<MediaSignatureTarget> = {}): MediaSignatureTarget {
  return {
    sessionId: SESSION_ID,
    path: FILE_PATH,
    allowExternalSymlinks: true,
    ...overrides,
  };
}

function signedUrl(
  service: MediaSignatureService,
  url: string,
  overrides: Partial<MediaSignatureTarget> = {},
  includeSymlinkFlag = true,
): string {
  const issued = service.issue(target(overrides));
  const params = new URLSearchParams({ signature: issued.signature });
  if (includeSymlinkFlag) params.set('allow_external_symlinks', 'true');
  return `${url}?${params.toString()}`;
}

function request(url: string, overrides: { method?: string; headers?: Record<string, string> } = {}): Record<string, unknown> {
  return {
    method: 'GET',
    url,
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

function setup(opts: { recordFailure?: (ip: string) => void } = {}): {
  service: MediaSignatureService;
  hook: ReturnType<typeof createAuthHook>;
} {
  const service = createMediaSignatureService();
  return {
    service,
    hook: createAuthHook(
      { getToken: () => 'bearer-token', isValid: (candidate: string) => candidate === 'bearer-token' } as never,
      {
        limiter: { recordFailure: opts.recordFailure ?? (() => {}), isBanned: () => false },
        validateCredential: async (candidate) => candidate === 'bearer-token',
        validateMediaSignature: (signed, candidate) => service.validate(signed, candidate),
      },
    ),
  };
}

describe('signed media requests', () => {
  it('authorizes a workspace file download with a valid signature and no bearer header', async () => {
    const { service, hook } = setup();
    const response = reply();
    await hook(request(signedUrl(service, DIRECT_PATH)) as never, response as never);
    expect(response.payload).toBeUndefined();
    expect(response.status).toBe(200);
  });

  it('authorizes a proxied host download with a locally issued signature', async () => {
    const { service, hook } = setup();
    const response = reply();
    await hook(request(signedUrl(service, PROXY_PATH)) as never, response as never);
    expect(response.payload).toBeUndefined();
  });

  it('rejects a signature replayed against a different path', async () => {
    const { service, hook } = setup();
    const response = reply();
    const replayed = signedUrl(service, DIRECT_PATH).replace(FILE_PATH, 'media/other.mp4');
    await hook(request(replayed) as never, response as never);
    expect(response.status).toBe(401);
  });

  it('rejects a signature replayed against a different session', async () => {
    const { service, hook } = setup();
    const response = reply();
    const replayed = signedUrl(service, DIRECT_PATH).replace(SESSION_ID, 'session-2');
    await hook(request(replayed) as never, response as never);
    expect(response.status).toBe(401);
  });

  it('rejects a signature when the external symlink flag differs', async () => {
    const { service, hook } = setup();
    const response = reply();
    await hook(
      request(signedUrl(service, DIRECT_PATH, {}, false)) as never,
      response as never,
    );
    expect(response.status).toBe(401);
  });

  it('rejects an invalid signature', async () => {
    const { hook } = setup();
    const response = reply();
    await hook(
      request(`${DIRECT_PATH}?allow_external_symlinks=true&signature=wrong`) as never,
      response as never,
    );
    expect(response.status).toBe(401);
  });

  it('does not count signature attempts toward the auth failure limiter', async () => {
    const recordFailure = vi.fn();
    const { hook } = setup({ recordFailure });
    const response = reply();
    await hook(
      request(`${DIRECT_PATH}?allow_external_symlinks=true&signature=wrong`) as never,
      response as never,
    );
    expect(recordFailure).not.toHaveBeenCalled();
  });

  it('does not authorize signed requests on other API routes', async () => {
    const { service, hook } = setup();
    const response = reply();
    const otherPath = `/api/v1/sessions/${SESSION_ID}/media/file-1`;
    await hook(request(signedUrl(service, otherPath)) as never, response as never);
    expect(response.status).toBe(401);
  });

  it('does not authorize signed requests with a non-GET method', async () => {
    const { service, hook } = setup();
    const response = reply();
    await hook(
      request(signedUrl(service, DIRECT_PATH), { method: 'POST' }) as never,
      response as never,
    );
    expect(response.status).toBe(401);
  });

  it('still authorizes requests carrying a bearer token', async () => {
    const { hook } = setup();
    const response = reply();
    await hook(
      request(DIRECT_PATH, { headers: { authorization: 'Bearer bearer-token' } }) as never,
      response as never,
    );
    expect(response.payload).toBeUndefined();
  });
});