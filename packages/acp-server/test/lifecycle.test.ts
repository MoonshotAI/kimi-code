import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IOAuthToolkit,
  ISessionManager,
  ISessionMcpHandle,
  IWorkspaceInstanceManager,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionSummary } from '@moonshot-ai/klient';

import { filterSessionSummariesByCwd } from '../src/server';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider } from './_helpers/scriptedProvider';

const STDIO_MCP_FIXTURE = fileURLToPath(
  new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url),
);

const OAUTH_PROVIDER_CONFIG = `[providers.test-oauth]
type = "kimi"
baseUrl = "http://localhost"

[providers.test-oauth.oauth]
storage = "file"
key = "test-key"
`;

function createFakeOAuthToolkit(): {
  readonly seed: readonly [typeof IOAuthToolkit, IOAuthToolkit];
  hasToken(): boolean;
} {
  let token: string | undefined = 'fake-token';
  const fake = {
    login: () => Promise.reject(new Error('fakeOAuthToolkit: login not implemented')),
    logout: (providerName?: string) => {
      token = undefined;
      return Promise.resolve({ providerName: providerName ?? 'test-oauth' });
    },
    getCachedAccessToken: () => Promise.resolve(token),
    tokenProvider: () => {
      throw new Error('fakeOAuthToolkit: tokenProvider not implemented');
    },
    getManagedUsage: () => Promise.reject(new Error('fakeOAuthToolkit: not implemented')),
    getManagedUserInfo: () => Promise.reject(new Error('fakeOAuthToolkit: not implemented')),
  } as unknown as IOAuthToolkit;
  return { seed: [IOAuthToolkit, fake], hasToken: () => token !== undefined };
}

describe('acp-server session lifecycle', () => {
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
    homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function sessionMcpEntries(
    c: TestClient,
    sessionId: string,
  ): Promise<readonly { readonly name: string; readonly status: string; readonly error?: string }[]> {
    await c.server.core.accessor
      .get(IWorkspaceInstanceManager)
      .getOrCreate({ root: homeDir! });
    const handle = c.server.core.accessor.get(ISessionManager).get(sessionId);
    expect(handle).toBeDefined();
    const mcp = handle!.accessor.get(ISessionMcpHandle);
    await mcp.ready;
    return mcp.connectionManager.list();
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
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const before = c.sessionUpdates().length;

      const loaded = (await c.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { configOptions?: unknown[] };
      expect(Array.isArray(loaded.configOptions)).toBe(true);
      const replayed = c
        .sessionUpdates()
        .slice(before)
        .map((m) => (m.params as { update?: { sessionUpdate?: string } }).update?.sessionUpdate)
        .filter((k) => k !== 'available_commands_update');
      expect(replayed).toEqual([]);
    },
    30_000,
  );

  it(
    'session/fork on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(
        c.send('session/fork', { sessionId: 'does-not-exist', cwd: homeDir, mcpServers: [] }),
      ).rejects.toThrow(/-32602/);
    },
    30_000,
  );

  it(
    'session/fork creates an independently promptable session carrying the source history',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-fork-'));
      await writeFakeModelConfig(homeDir);
      const scripted = createScriptedProvider();
      client = await createTestClient({ homeDir, extraSeeds: [scripted.seed] });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      scripted.mockNextText('first turn reply');
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);
      const sourceTurn = (await c.send('session/prompt', {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'hello from the source session' }],
      })) as { stopReason: string };
      expect(sourceTurn.stopReason).toBe('end_turn');

      const forked = (await c.send('session/fork', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { sessionId: string; configOptions?: unknown[]; modes?: unknown };
      expect(forked.sessionId).toMatch(/^session_/);
      expect(forked.sessionId).not.toBe(created.sessionId);
      expect(Array.isArray(forked.configOptions)).toBe(true);
      expect(forked.modes).toBeDefined();

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      const ids = listed.sessions.map((s) => s.sessionId);
      expect(ids).toContain(created.sessionId);
      expect(ids).toContain(forked.sessionId);

      scripted.mockNextText('fork reply');
      const forkTurn = (await c.send('session/prompt', {
        sessionId: forked.sessionId,
        prompt: [{ type: 'text', text: 'hello from the fork' }],
      })) as { stopReason: string };
      expect(forkTurn.stopReason).toBe('end_turn');

      const before = c.sessionUpdates().length;
      await c.send('session/load', {
        sessionId: forked.sessionId,
        cwd: homeDir,
        mcpServers: [],
      });
      const replayed = c
        .sessionUpdates()
        .slice(before)
        .map(
          (m) =>
            (m.params as { update?: { sessionUpdate?: string; content?: { text?: string } } })
              .update,
        );
      const userChunks = replayed
        .filter((u) => u?.sessionUpdate === 'user_message_chunk')
        .map((u) => u?.content?.text);
      const agentChunks = replayed
        .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
        .map((u) => u?.content?.text);
      expect(userChunks).toContain('hello from the source session');
      expect(userChunks).toContain('hello from the fork');
      expect(agentChunks).toContain('first turn reply');
      expect(agentChunks).toContain('fork reply');
    },
    30_000,
  );

  it(
    'session/delete removes the session and a second delete reports invalid_params',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };

      const deleted = await c.send('session/delete', { sessionId: created.sessionId });
      expect(deleted).toEqual({});
      await expect(
        c.send('session/prompt', { sessionId: created.sessionId, prompt: [] }),
      ).rejects.toThrow(/-32602/);

      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      expect(listed.sessions.some((s) => s.sessionId === created.sessionId)).toBe(false);

      await expect(
        c.send('session/delete', { sessionId: created.sessionId }),
      ).rejects.toThrow(/-32602/);
    },
    30_000,
  );

  it(
    'session/delete on an unknown sessionId fails with invalid_params',
    async () => {
      const c = await boot();
      await expect(c.send('session/delete', { sessionId: 'does-not-exist' })).rejects.toThrow(
        /-32602/,
      );
    },
    30_000,
  );

  it(
    'session/new connects ACP mcpServers as ephemeral session servers',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', {
        cwd: homeDir,
        mcpServers: [
          {
            name: 'mock',
            command: process.execPath,
            args: [STDIO_MCP_FIXTURE],
            env: [{ name: 'KIMI_TEST_MCP_START_DELAY_MS', value: '0' }],
          },
        ],
      })) as { sessionId: string };
      expect(created.sessionId).toMatch(/^session_/);

      const entries = await sessionMcpEntries(c, created.sessionId);
      expect(entries.find((e) => e.name === 'mock')?.status).toBe('connected');
    },
    30_000,
  );

  it(
    'session/load forwards mcpServers to the re-materialized session',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.send('session/close', { sessionId: created.sessionId });

      await c.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [
          { name: 'mock', command: process.execPath, args: [STDIO_MCP_FIXTURE], env: [] },
        ],
      });

      const entries = await sessionMcpEntries(c, created.sessionId);
      expect(entries.find((e) => e.name === 'mock')?.status).toBe('connected');
    },
    30_000,
  );

  it(
    'session/new forwards additionalDirectories to the engine workspace dirs',
    async () => {
      const c = await boot();
      const extraDir = join(homeDir!, 'extra-root');
      await mkdir(extraDir, { recursive: true });

      const created = (await c.send('session/new', {
        cwd: homeDir,
        mcpServers: [],
        additionalDirectories: [extraDir],
      })) as { sessionId: string };
      expect(created.sessionId).toMatch(/^session_/);

      const workspace = await c.server.core.accessor
        .get(IWorkspaceInstanceManager)
        .getOrCreate({ root: homeDir! });
      const dirs = workspace.program.dirs;
      await dirs.ready;
      expect(dirs.additionalDirs).toContain(extraDir);
    },
    30_000,
  );

  it(
    'a title change pushes session_info_update',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.waitForSessionUpdate('available_commands_update', 10_000);

      await c.server.klient.session(created.sessionId).setTitle('Renamed Session');

      const notification = await c.waitForSessionUpdate('session_info_update', 10_000);
      const update = (notification.params as { update?: { title?: string | null } }).update;
      expect(update?.title).toBe('Renamed Session');
    },
    30_000,
  );

  it(
    'logout drops the token and the auth gate closes again',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-logout-'));
      await writeFile(join(homeDir, 'config.toml'), OAUTH_PROVIDER_CONFIG, 'utf8');
      const toolkit = createFakeOAuthToolkit();
      client = await createTestClient({
        homeDir,
        disableAuth: false,
        extraSeeds: [toolkit.seed],
      });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      await expect
        .poll(
          async () => (await c.server.klient.global.auth.summarize()).some((s) => s.loggedIn),
          { timeout: 10_000 },
        )
        .toBe(true);

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);

      await c.send('logout', {});
      expect(toolkit.hasToken()).toBe(false);

      await expect
        .poll(
          async () => (await c.server.klient.global.auth.summarize()).some((s) => s.loggedIn),
          { timeout: 10_000 },
        )
        .toBe(false);
      await expect(c.send('session/new', { cwd: homeDir, mcpServers: [] })).rejects.toThrow(
        /[Aa]uthentication required/,
      );
    },
    30_000,
  );

  it(
    'apiKey-only config passes the auth gate without any OAuth provider',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-apikey-gate-'));
      await writeFakeModelConfig(homeDir);
      client = await createTestClient({ homeDir, disableAuth: false });
      const c = client;
      await c.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);
    },
    30_000,
  );

  it(
    'session/list filters by cwd when the client supplies one',
    async () => {
      const c = await boot();
      const otherDir = join(homeDir!, 'other-root');
      await mkdir(otherDir, { recursive: true });
      const first = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      const second = (await c.send('session/new', { cwd: otherDir, mcpServers: [] })) as {
        sessionId: string;
      };

      const filtered = (await c.send('session/list', { cwd: homeDir })) as {
        sessions: { sessionId: string; cwd: string }[];
      };
      const ids = filtered.sessions.map((s) => s.sessionId);
      expect(ids).toContain(first.sessionId);
      expect(ids).not.toContain(second.sessionId);

      const unfiltered = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      const allIds = unfiltered.sessions.map((s) => s.sessionId);
      expect(allIds).toContain(first.sessionId);
      expect(allIds).toContain(second.sessionId);
    },
    30_000,
  );
});

describe('filterSessionSummariesByCwd', () => {
  const summary = (id: string, cwd?: string): SessionSummary => ({
    id,
    workspaceId: `ws-${id}`,
    cwd,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
  });

  it('returns every session when no cwd filter is supplied', () => {
    const items = [summary('a', '/x'), summary('b'), summary('c', '/y')];
    expect(filterSessionSummariesByCwd(items, undefined)).toBe(items);
  });

  it('keeps cwd-less legacy sessions under an explicit filter', () => {
    const items = [summary('a', '/x'), summary('b'), summary('c', '/y')];
    expect(filterSessionSummariesByCwd(items, '/x').map((s) => s.id)).toEqual(['a', 'b']);
    expect(filterSessionSummariesByCwd(items, '/y').map((s) => s.id)).toEqual(['b', 'c']);
  });
});
