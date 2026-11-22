import { describe, expect, it } from 'vitest';

import type { ISessionMcpOverlayConnection } from '#/session/mcp/sessionMcpOverlay';
import { SessionMcpOverlayService } from '#/session/mcp/sessionMcpOverlayService';

describe('SessionMcpOverlayService', () => {
  it('exposes the overlay connection readiness as its own', async () => {
    let resolve!: () => void;
    const connection: ISessionMcpOverlayConnection = {
      ready: new Promise<void>((settle) => {
        resolve = settle;
      }),
      shutdown: () => Promise.resolve(),
    };
    const service = new SessionMcpOverlayService(connection);
    let settled = false;
    void service.ready.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    resolve();
    await service.ready;
    expect(settled).toBe(true);
  });
});
