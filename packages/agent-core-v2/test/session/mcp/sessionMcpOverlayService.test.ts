import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ISessionMcpOverlayConnection } from '#/session/mcp/sessionMcpOverlay';
import {
  SESSION_MCP_OVERLAY_CONNECT_TIMEOUT_MS,
  SessionMcpOverlayService,
} from '#/session/mcp/sessionMcpOverlayService';

import { noopLogger } from '../../wire/stubs';

function pendingConnection(): {
  connection: ISessionMcpOverlayConnection;
  shutdown: ReturnType<typeof vi.fn>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const ready = new Promise<void>((settle) => {
    resolve = settle;
  });
  const shutdown = vi.fn(() => Promise.resolve());
  return { connection: { ready, shutdown }, shutdown, resolve };
}

describe('SessionMcpOverlayService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves ready without shutdown when the overlay connect settles in time', async () => {
    const { connection, shutdown, resolve } = pendingConnection();
    const service = new SessionMcpOverlayService(connection, noopLogger);

    resolve();
    await service.ready;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('resolves ready without shutdown when the overlay connect fails', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const connection: ISessionMcpOverlayConnection = {
      ready: Promise.reject(new Error('connect failed')),
      shutdown,
    };
    const service = new SessionMcpOverlayService(connection, noopLogger);

    await service.ready;

    expect(shutdown).not.toHaveBeenCalled();
  });

  it('gives up and shuts the overlay down once the connect timeout elapses', async () => {
    vi.useFakeTimers();
    const { connection, shutdown } = pendingConnection();
    const service = new SessionMcpOverlayService(connection, noopLogger);
    let settled = false;
    void service.ready.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SESSION_MCP_OVERLAY_CONNECT_TIMEOUT_MS);

    expect(settled).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('resolves ready only after the abandoned overlay finished shutting down', async () => {
    vi.useFakeTimers();
    let releaseShutdown!: () => void;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseShutdown = resolve;
        }),
    );
    const connection: ISessionMcpOverlayConnection = {
      ready: new Promise<void>(() => {}),
      shutdown,
    };
    const service = new SessionMcpOverlayService(connection, noopLogger);
    let settled = false;
    void service.ready.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SESSION_MCP_OVERLAY_CONNECT_TIMEOUT_MS);
    expect(settled).toBe(false);

    releaseShutdown();
    await service.ready;
    expect(settled).toBe(true);
  });
});
