import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IOAuthToolkit,
  ISessionLifecycleService,
  ISessionMcpHandle,
  IWorkspaceDirs,
  IWorkspaceLifecycleService,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it } from 'vitest';

import type { SessionSummary } from '@moonshot-ai/klient';

import { filterSessionSummariesByCwd } from '../src/server';
import { createTestClient, type TestClient } from './_helpers/acpClient';
import { writeFakeModelConfig } from './_helpers/fakeModelConfig';
import { createScriptedProvider } from './_helpers/scriptedProvider';

/** Real stdio MCP fixture server from the agent-core-v2 test suite. */
const STDIO_MCP_FIXTURE = fileURLToPath(
  new URL('../../agent-core-v2/test/mcpCore/fixtures/mock-stdio-server.mjs', import.meta.url),
);

/**
 * config.toml declaring one OAuth provider so `auth.summarize()` considers it;
 * the token itself lives in the seeded fake `IOAuthToolkit`.
 */
const OAUTH_PROVIDER_CONFIG = `[providers.test-oauth]
type = "kimi"
baseUrl = "http://localhost"

[providers.test-oauth.oauth]
storage = "file"
key = "test-key"
`;

/**
 * In-memory `IOAuthToolkit` stub: starts logged in, `logout()` clears the
 * token. Seeded at App scope so the real `OAuthService` / `AuthSummaryService`
 * chain runs against it.
 */
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

  /**
   * Read the session scope's MCP entries engine-side: workspace handler →
   * session lifecycle → the session's MCP handle (the overlay view when the
   * session was created/loaded with ephemeral `mcpServers`).
   */
  async function sessionMcpEntries(
    c: TestClient,
    sessionId: string,
  ): Promise<readonly { readonly name: string; readonly status: string }[]> {
    const handler = await c.server.core.accessor
      .get(IWorkspaceLifecycleService)
      .handlerFor({ root: homeDir! });
    const handle = handler.accessor.get(ISessionLifecycleService).get(sessionId);
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

      // One real turn on the source session so the fork has history to carry.
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
      // Same response surface as session/new.
      expect(Array.isArray(forked.configOptions)).toBe(true);
      expect(forked.modes).toBeDefined();

      // Both the source and the fork are listed.
      const listed = (await c.send('session/list', {})) as {
        sessions: { sessionId: string }[];
      };
      const ids = listed.sessions.map((s) => s.sessionId);
      expect(ids).toContain(created.sessionId);
      expect(ids).toContain(forked.sessionId);

      // The fork is wired for prompts like a session/new session.
      scripted.mockNextText('fork reply');
      const forkTurn = (await c.send('session/prompt', {
        sessionId: forked.sessionId,
        prompt: [{ type: 'text', text: 'hello from the fork' }],
      })) as { stopReason: string };
      expect(forkTurn.stopReason).toBe('end_turn');

      // History carried over: loading the fork replays the source turn (and
      // the fork's own turn).
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
      // The local ACP session state is torn down with the engine session:
      // prompting the deleted id now hits the unknown-session branch.
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

      // Engine-side assertion: the session scope's MCP handle is the overlay
      // view and the converted server ended up connected under its ACP name.
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

      // The workspace handler merges create-time dirs into its
      // (ephemeral) additional-dir set.
      const handler = await c.server.core.accessor
        .get(IWorkspaceLifecycleService)
        .handlerFor({ root: homeDir! });
      const dirs = handler.accessor.get(IWorkspaceDirs);
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

      // Retitle through the engine (the same klient the server drives) — the
      // metadata.changed event must surface as session_info_update.
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

      // Provider hydration from config.toml is async (kosongConfig initialize
      // → providerService.loadAll); wait until summarize sees the fake token.
      await expect
        .poll(
          async () => (await c.server.klient.global.auth.summarize()).some((s) => s.loggedIn),
          { timeout: 10_000 },
        )
        .toBe(true);

      // Logged in (fake token present): the gate lets session/new through.
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);

      await c.send('logout', {});
      expect(toolkit.hasToken()).toBe(false);

      // Logged out: the summarize-driven gate rejects with auth_required.
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
      // The flat fake-model config carries an inline apiKey and no OAuth
      // provider at all: the engine's readiness probe (not the OAuth-only
      // summary) must let session/new through.
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

      // No cwd → no filter: both sessions are listed.
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
    // 'b' has no cwd metadata: its workspace is unknown, not known-different,
    // so an explicit filter must not silently drop it.
    expect(filterSessionSummariesByCwd(items, '/x').map((s) => s.id)).toEqual(['a', 'b']);
    expect(filterSessionSummariesByCwd(items, '/y').map((s) => s.id)).toEqual(['b', 'c']);
  });
});
