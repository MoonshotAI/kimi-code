import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestClient, type TestClient } from './_helpers/acpClient';

describe('acp-server session lifecycle', () => {
  let homeDir: string | undefined;
  let client: TestClient | undefined;

  afterEach(async () => {
    if (client !== undefined) {
      await client.close();
      client = undefined;
    }
    if (homeDir !== undefined) {
      await rm(homeDir, { recursive: true, force: true });
      homeDir = undefined;
    }
  });

  async function boot(): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  it(
    'session/new creates a live session and session/list returns it',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      expect(listed.sessions.some((s) => s.sessionId === created.sessionId)).toBe(true);
    },
    30_000,
  );

  it(
    'session/resume on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(
        c.send('session/resume', { sessionId: 'does-not-exist', cwd: homeDir, mcpServers: [] }),
      ).rejects.toThrow();
    },
    30_000,
  );

  it(
    'session/load replays (empty) history and returns configOptions',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      // Drain the available_commands_update pushed after new so the load
      // replay assertion only sees load-time notifications.
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const before = c.sessionUpdates().length;

      const loaded = (await c.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { configOptions?: unknown[] };
      expect(Array.isArray(loaded.configOptions)).toBe(true);
      // A brand-new session has no persisted history, so load must not emit
      // any user/agent/tool replay chunks (only the post-load commands push).
      const replayed = c
        .sessionUpdates()
        .slice(before)
        .map((m) => (m.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate)
        .filter((k) => k !== 'available_commands_update');
      expect(replayed).toEqual([]);
    },
    30_000,
  );
});
