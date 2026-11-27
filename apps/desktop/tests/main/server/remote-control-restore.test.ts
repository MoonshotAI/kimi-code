import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  restoreRemoteControlOnStartup,
  shouldRestoreRemoteControl,
} from '../../../src/main/server/remote-control-restore';

const mocks = vi.hoisted(() => ({
  state: { restoreEnabled: false, previousEnabled: false },
  warn: vi.fn(),
}));

vi.mock('../../../src/main/app/ui-state', () => ({
  getRemoteControlRestoreState: () => mocks.state,
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { warn: mocks.warn },
}));

function response(ok: boolean, status: number, payload: unknown): Response {
  return { ok, status, json: async () => payload } as Response;
}

describe('Remote Control startup restore', () => {
  beforeEach(() => {
    mocks.state = { restoreEnabled: false, previousEnabled: false };
    vi.clearAllMocks();
  });

  it('restores only when the preference and the previous switch are both on', () => {
    expect(shouldRestoreRemoteControl({ restoreEnabled: true, previousEnabled: true })).toBe(true);
    expect(shouldRestoreRemoteControl({ restoreEnabled: true, previousEnabled: false })).toBe(false);
    expect(shouldRestoreRemoteControl({ restoreEnabled: false, previousEnabled: true })).toBe(false);
    expect(shouldRestoreRemoteControl({ restoreEnabled: false, previousEnabled: false })).toBe(false);
  });

  it('enables Remote Control with the server credential', async () => {
    mocks.state = { restoreEnabled: true, previousEnabled: true };
    const fetcher = vi.fn(async () => response(true, 200, { code: 0, data: { enabled: true } }));
    const finished = vi.fn();

    await restoreRemoteControlOnStartup('http://127.0.0.1:58627', 'secret', fetcher, finished);

    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:58627/api/v1/remote-control', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
      },
      body: JSON.stringify({ enabled: true }),
      signal: expect.any(AbortSignal),
    });
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('does not call the server when the previous switch was off', async () => {
    mocks.state = { restoreEnabled: true, previousEnabled: false };
    const fetcher = vi.fn();

    await restoreRemoteControlOnStartup('http://127.0.0.1:58627', undefined, fetcher);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps startup non-blocking when restoration fails', async () => {
    mocks.state = { restoreEnabled: true, previousEnabled: true };
    const fetcher = vi.fn(async () => response(false, 503, null));

    await expect(
      restoreRemoteControlOnStartup('http://127.0.0.1:58627', undefined, fetcher),
    ).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith(
      '[kimi-desktop] failed to restore Remote Control state: HTTP 503',
    );
  });

  it('reports a business error returned with HTTP 200', async () => {
    mocks.state = { restoreEnabled: true, previousEnabled: true };
    const fetcher = vi.fn(async () =>
      response(true, 200, { code: 40928, msg: 'Remote Control is already running' }),
    );

    await restoreRemoteControlOnStartup('http://127.0.0.1:58627', undefined, fetcher);

    expect(mocks.warn).toHaveBeenCalledWith(
      '[kimi-desktop] failed to restore Remote Control state: Remote Control is already running',
    );
  });
});
