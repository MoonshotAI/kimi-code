import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createDecorator,
  IOAuthToolkit,
  IAgentEnvironmentBindingService,
  ISessionContext,
  ISessionWorkdir,
  IProjectService,
  IAgentLifecycleService,
  ensureMainAgent,
  ISessionManager,
  ISessionMcpHandle,
  IProjectInstanceManager,
  SyncDescriptor,
} from '@moonshot-ai/agent-core-v2';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionSummary } from '@moonshot-ai/klient';
import { createGitWorktree } from '@moonshot-ai/testkit/fixtures';

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

  async function boot(configToml?: string): Promise<TestClient> {
    homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
    if (configToml !== undefined) await writeFile(join(homeDir, 'config.toml'), configToml, 'utf-8');
    client = await createTestClient({ homeDir });
    await client.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    return client;
  }

  async function sessionMcpEntries(
    c: TestClient,
    sessionId: string,
  ): Promise<readonly { readonly name: string; readonly status: string; readonly error?: string }[]> {
    const lease = await c.server.core.accessor
      .get(IProjectInstanceManager)
      .acquire({ cwd: homeDir! });
    try {
      const handle = c.server.core.accessor.get(ISessionManager).get(sessionId);
      expect(handle).toBeDefined();
      const mcp = handle!.accessor.get(ISessionMcpHandle);
      await mcp.ready;
      return mcp.connectionManager.list();
    } finally {
      lease.dispose();
    }
  }

  it(
    'resolves close only after the engine has finished disposing its services',
    async () => {
      homeDir = await mkdtemp(join(tmpdir(), 'acp-lifecycle-'));
      const events: string[] = [];
      let releaseDispose!: () => void;
      const disposeGate = new Promise<void>((resolve) => {
        releaseDispose = resolve;
      });
      class SlowToDispose {
        declare readonly _serviceBrand: undefined;
        async dispose(): Promise<void> {
          events.push('dispose started');
          await disposeGate;
          events.push('dispose finished');
        }
      }
      const ISlowToDispose = createDecorator<SlowToDispose>('slowToDisposeAcpTestService');
      client = await createTestClient({
        homeDir,
        extraSeeds: [[ISlowToDispose, new SyncDescriptor(SlowToDispose)]],
      });
      client.server.core.accessor.get(ISlowToDispose);

      const closing = client.server.close().then(() => {
        events.push('close resolved');
      });
      try {
        await vi.waitFor(() => expect(events).toContain('dispose started'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(events).toEqual(['dispose started']);
      } finally {
        releaseDispose();
      }
      await closing;
      expect(events).toEqual(['dispose started', 'dispose finished', 'close resolved']);
    },
    30_000,
  );

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
    'session/new bypasses an invalid configured environment default',
    async () => {
      const c = await boot('[environments]\ndefault = "missing"\n');
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      expect(created.sessionId).toMatch(/^session_/);
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
      const forkedHandle = c.server.core.accessor.get(ISessionManager).get(forked.sessionId)!;
      const forkedMain = await ensureMainAgent(forkedHandle);
      expect(forkedHandle.accessor.get(IAgentLifecycleService).handleOf(forkedMain.agentId)!
        .accessor.get(IAgentEnvironmentBindingService).current.environmentId).toBe('local');
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

      await c.send('session/close', { sessionId: created.sessionId });
      const files = await readdir(homeDir!, { recursive: true });
      const wirePath = files.find((path) => path.endsWith('wire.jsonl'))!;
      const records = (await readFile(join(homeDir!, wirePath), 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { type?: string; environmentId?: string });
      const bindingIndex = records.findIndex((record) => record.type === 'environment.set_binding');
      expect(bindingIndex).toBeGreaterThanOrEqual(0);
      records[bindingIndex]!.environmentId = `acp:${created.sessionId}`;
      await writeFile(join(homeDir!, wirePath), `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

      const legacyForked = (await c.send('session/fork', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { sessionId: string };
      const legacyHandle = c.server.core.accessor.get(ISessionManager).get(legacyForked.sessionId)!;
      const legacyMain = await ensureMainAgent(legacyHandle);
      expect(legacyHandle.accessor.get(IAgentLifecycleService).handleOf(legacyMain.agentId)!
        .accessor.get(IAgentEnvironmentBindingService).current.environmentId).toBe('local');
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
    'session/load succeeds after the host process restarts',
    async () => {
      const c = await boot();
      const created = (await c.send('session/new', { cwd: homeDir, mcpServers: [] })) as {
        sessionId: string;
      };
      await c.close();
      client = undefined;

      const restarted = await createTestClient({ homeDir: homeDir! });
      client = restarted;
      await restarted.send('initialize', { protocolVersion: 1, clientCapabilities: {} });

      const loaded = (await restarted.send('session/load', {
        sessionId: created.sessionId,
        cwd: homeDir,
        mcpServers: [],
      })) as { configOptions?: unknown[] };
      expect(Array.isArray(loaded.configOptions)).toBe(true);
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

      const lease = await c.server.core.accessor
        .get(IProjectInstanceManager)
        .acquire({ cwd: homeDir! });
      try {
        const dirs = lease.instance.program.dirs;
        await dirs.ready;
        expect(dirs.additionalDirs).toContain(extraDir);
      } finally {
        lease.dispose();
      }
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

  it(
    'session/new in a worktree joins the repository project, pins the worktree and lists it there',
    async () => {
      const c = await boot();
      const repos = join(homeDir!, 'repos');
      const { main, worktree } = await createGitWorktree({ main: join(repos, 'app'), worktree: join(repos, 'app-fix') });
      const created = (await c.send('session/new', { cwd: worktree, mcpServers: [] })) as {
        sessionId: string;
      };

      const handle = c.server.core.accessor.get(ISessionManager).get(created.sessionId)!;
      const context = handle.accessor.get(ISessionContext);
      const project = await c.server.core.accessor.get(IProjectService).get(context.workspaceId);
      expect(await realpath(project!.root)).toBe(await realpath(main));
      expect(context.cwd).toBe(worktree);
      const inWorktree = (await c.send('session/list', { cwd: worktree })) as {
        sessions: { sessionId: string; cwd: string }[];
      };
      const inMain = (await c.send('session/list', { cwd: main })) as {
        sessions: { sessionId: string }[];
      };
      expect(inWorktree.sessions).toContainEqual(
        expect.objectContaining({ sessionId: created.sessionId, cwd: worktree }),
      );
      expect(inMain.sessions.map((s) => s.sessionId)).not.toContain(created.sessionId);
    },
    30_000,
  );

  it(
    'session/list keeps a session at the main checkout and one in its worktree apart after both are closed',
    async () => {
      const c = await boot();
      const repos = join(homeDir!, 'repos');
      const { main, worktree } = await createGitWorktree({ main: join(repos, 'app'), worktree: join(repos, 'app-fix') });
      const sessionIn = async (cwd: string) =>
        ((await c.send('session/new', { cwd, mcpServers: [] })) as { sessionId: string }).sessionId;
      const atMain = await sessionIn(main);
      const inWorktree = await sessionIn(worktree);
      const manager = c.server.core.accessor.get(ISessionManager);
      const workdirs = [atMain, inWorktree].map((id) => manager.get(id)!.accessor.get(ISessionWorkdir).cwd);
      for (const id of [atMain, inWorktree]) await manager.close(id);

      const listed = async (cwd: string) =>
        ((await c.send('session/list', { cwd })) as { sessions: { sessionId: string; cwd: string }[] }).sessions.map(
          (s) => [s.sessionId, s.cwd],
        );

      expect(workdirs).toEqual([undefined, worktree]);
      expect(await listed(main)).toEqual([[atMain, main]]);
      expect(await listed(worktree)).toEqual([[inWorktree, worktree]]);
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
