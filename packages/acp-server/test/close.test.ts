import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

describe('acp-server session/close', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-close-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'advertises the close capability and closes a live session',
    async () => {
      const c = await boot();
      const init = (await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} })) as {
        agentCapabilities?: { sessionCapabilities?: { close?: unknown } };
      };
      expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      // After close the server no longer routes the session — a follow-up
      // prompt must surface invalid_params for the now-unknown sessionId.
      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow();
      await c.close();
      await expect(c.close()).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'closing an unknown sessionId is a best-effort no-op',
    async () => {
      const c = await boot();
      await expect(c.send('session/close', { sessionId: 'does-not-exist' })).resolves.toEqual({});
    },
    30_000,
  );

  it(
    'client close / server shutdown closes all active sessions cleanly',
    async () => {
      const c = await boot();
      const s1 = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const s2 = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(s1.sessionId).toBeDefined();
      expect(s2.sessionId).toBeDefined();
      await expect(c.close()).resolves.toBeUndefined();
    },
    30_000,
  );

  it(
    'server shutdown awaits in-flight session teardowns and cleans up cleanly',
    async () => {
      const c = await boot();
      const s = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const closeReq = c.send('session/close', { sessionId: s.sessionId });
      const shutdown = c.close();
      await Promise.all([closeReq, shutdown]);
    },
    30_000,
  );

  it(
    'deleteSession following an in-flight closeSession still deletes the session',
    async () => {
      const c = await boot();
      const s = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const closeReq = c.send('session/close', { sessionId: s.sessionId });
      const deleteReq = c.send('session/delete', { sessionId: s.sessionId });
      await Promise.all([closeReq, deleteReq]);

      await expect(
        c.send('session/delete', { sessionId: s.sessionId }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'server shutdown drains replacement deleteSession following an in-flight closeSession',
    async () => {
      const c = await boot();
      const s = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const closeReq = c.send('session/close', { sessionId: s.sessionId });
      const deleteReq = c.send('session/delete', { sessionId: s.sessionId });
      const shutdown = c.close();
      await Promise.all([closeReq, deleteReq, shutdown]);
    },
    30_000,
  );

  it(
    'closeSession succeeds even when concurrent deleteSession for an unknown id fails',
    async () => {
      const c = await boot();
      const unknownId = 'nonexistent-session-id';
      const deleteReq = c.send('session/delete', { sessionId: unknownId });
      const closeReq = c.send('session/close', { sessionId: unknownId });

      await expect(deleteReq).rejects.toThrow();
      await expect(closeReq).resolves.toBeDefined();
    },
    30_000,
  );

  it(
    'automatic server shutdown does not trigger unhandledRejection when session close rejects',
    async () => {
      let unhandled: unknown;
      const onUnhandled = (err: unknown) => {
        unhandled = err;
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const c = await boot();
        const s = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
          sessionId: string;
        };
        const sessionHandle = c.server.klient.session(s.sessionId);
        vi.spyOn(sessionHandle, 'close').mockRejectedValueOnce(
          new Error('forced teardown failure'),
        );
        await c.close().catch(() => {});
        await new Promise((r) => setTimeout(r, 50));
        expect(unhandled).toBeUndefined();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    },
    30_000,
  );
});
