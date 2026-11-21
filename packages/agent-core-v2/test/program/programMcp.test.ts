import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import { loadMcpServers } from '#/app/mcpConfig/configLoader';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import {
  McpConnectionManager,
  type McpConnectionView,
  type McpServerEntry,
} from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { ProgramMcp, suppressedUserServers } from '#/program/programMcp';
import type { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import type { WatchChange } from '#human/utils/watch';

import { stubLog } from '../_base/log/stubs';
import { stubAgentIdentity } from '../app/agentIdentity/stubs';
import {
  createMemoryMcpOAuthStore,
  cwdStdioFixture,
  startInProcessHttpMcpServer,
  stdioFixture,
} from '../mcpCore/stubs';

const watchFires = new Map<string, Emitter<WatchChange>>();
const disposedWatches: string[] = [];

vi.mock('#human/utils/watch', () => {
  const watch = (path: string) => {
    let emitter = watchFires.get(path);
    if (emitter === undefined) {
      emitter = new Emitter<WatchChange>();
      watchFires.set(path, emitter);
    }
    return {
      ready: Promise.resolve(),
      onDidChange: emitter.event,
      dispose: () => {
        disposedWatches.push(path);
      },
    };
  };
  return {
    watch,
    watchCandidates: (root: string) => watch(root),
  };
});

const fs = new HostFileSystem();

function stdioServer(): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [stdioFixture] };
}

function ephemeralStdio(): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [stdioFixture], environment_id: 'local' };
}

function disabledStdio(command: string): McpServerConfig {
  return { transport: 'stdio', command, enabled: false };
}

function disabledHttp(): McpServerConfig {
  return { transport: 'http', url: 'https://example.com/mcp', enabled: false };
}

async function writeMcpJson(path: string, servers: Record<string, McpServerConfig>): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }), 'utf8');
  return path;
}

async function readCwd(view: McpConnectionView, name: string): Promise<string> {
  const resolved = view.resolved(name);
  if (resolved === undefined) throw new Error(`expected ${name} to be connected`);
  const result = await resolved.client.callTool('get_cwd', {});
  return realpathSync((result.content[0] as { type: 'text'; text: string }).text);
}

function names(view: McpConnectionView): string[] {
  return view.list().map((entry) => entry.name).toSorted();
}

describe('ProgramMcp', () => {
  let tempDirs: string[];
  let homeDir: string;
  let primary: string;
  let dirsChanges: Emitter<void>;
  let projectDirs: string[];
  let projectChanges: Emitter<void>;
  let oauth: McpOAuthService;
  let track2: Mock;
  let tracked: Array<string | undefined>;
  let programs: ProgramMcp[];

  beforeEach(() => {
    tempDirs = [];
    homeDir = temp('kimi-program-mcp-home-');
    primary = temp('kimi-program-mcp-root-');
    dirsChanges = new Emitter<void>();
    projectDirs = [];
    projectChanges = new Emitter<void>();
    oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    track2 = vi.fn();
    tracked = [];
    programs = [];
    watchFires.clear();
    disposedWatches.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.allSettled(programs.map((program) => program.dispose()));
    await oauth.dispose();
    dirsChanges.dispose();
    projectChanges.dispose();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function temp(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function createProgramMcp(): ProgramMcp {
    const environment = Object.assign(
      new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'] }),
      { process: new HostProcessService() },
    );
    const lease = {
      environment,
      track: <T,>(resource: T, sessionId?: string): T => {
        tracked.push(sessionId);
        return resource;
      },
      dispose: () => {},
    };
    const rootDirs = {
      get primary() {
        return primary;
      },
      onDidChange: dirsChanges.event,
    } as unknown as IWorkspaceDirs;
    const program = new ProgramMcp({
      bootstrap: { homeDir } as never,
      config: { ready: Promise.resolve(), onDidSectionChange: Event.None, get: () => undefined } as never,
      configStore: { onDidWrite: Event.None } as never,
      identity: stubAgentIdentity(),
      log: stubLog(),
      oauth,
      plugins: {
        enabledMcpServers: async () => ({}),
        mcpServerEntries: async () => [],
        onDidReload: Event.None,
      } as never,
      telemetry: { track2 } as never,
      environments: {
        _serviceBrand: undefined,
        inspect: () => environment,
        acquire: () => lease,
        acquireWhenReady: async () => lease,
      } as unknown as IEnvironmentService,
      hostFs: fs,
      project: {
        current: async () => ({ root: primary, additionalDirs: [...projectDirs] }),
        onDidChange: projectChanges.event,
      },
      rootDirs,
      trust: {
        ready: Promise.resolve(),
        get: async () => true,
        isTrusted: () => true,
        onDidChange: Event.None,
      } as never,
    });
    programs.push(program);
    return program;
  }

  async function checkout(prefix = 'kimi-program-mcp-wt-'): Promise<string> {
    const dir = temp(prefix);
    await mkdir(join(dir, '.git'));
    projectDirs.push(dir);
    return dir;
  }

  function userFile(): string {
    return join(homeDir, 'mcp.json');
  }

  function projectFile(dir: string): string {
    return join(dir, '.kimi-code', 'mcp.json');
  }

  function plainHandle(view: { sessionHandle: ProgramMcp['root']['sessionHandle'] }, sessionId = 'session') {
    return view.sessionHandle({ sessionId, ephemeral: {} }).handle;
  }

  it('suppressedUserServers keeps only the names every live anchor defines', () => {
    expect([...suppressedUserServers([new Set(['a', 'b']), new Set(['b', 'c'])])]).toEqual(['b']);
    expect([...suppressedUserServers([new Set(['a', 'b'])])].toSorted()).toEqual(['a', 'b']);
    expect(suppressedUserServers([]).size).toBe(0);
  });

  it('serves a name the user file and the project both define only from the project layer', async () => {
    await writeMcpJson(userFile(), { shared: disabledHttp(), userOnly: disabledStdio('user-only') });
    await writeMcpJson(projectFile(primary), {
      shared: disabledStdio('project-shared'),
      projectOnly: disabledStdio('project-only'),
    });

    const program = createProgramMcp();
    await program.root.ready;

    const expected = Object.keys(await loadMcpServers({ fs, cwd: primary, homeDir })).toSorted();
    expect(names(program.root.view())).toEqual(expected);
    expect([...program.root.configuredNames()].toSorted()).toEqual(expected);
    expect(program.root.view().get('shared')?.transport).toBe('stdio');
    const handle = plainHandle(program.root);
    const user = handle.upsertTarget!('userOnly');
    const anchor = handle.upsertTarget!('shared');
    expect(anchor).not.toBe(user);
    expect(user.get('shared')).toBeUndefined();
    expect(anchor.get('shared')?.status).toBe('disabled');
  });

  it('shares one anchor layer between workdirs and shuts it down with the last one, keeping OAuth credentials', async () => {
    const url = 'https://mcp.example.test/mcp';
    const wt = await checkout();
    await writeMcpJson(projectFile(wt), { remote: { transport: 'http', url, auth: 'oauth', enabled: false } });
    await oauth.getProvider('remote', url).saveTokens({ access_token: 'a', token_type: 'Bearer' });
    const program = createProgramMcp();
    await program.root.ready;

    const first = await program.workdir(wt);
    const second = await program.workdir(wt);
    await Promise.all([first.ready, second.ready]);
    const manager = plainHandle(first).upsertTarget!('remote');
    expect(plainHandle(second).upsertTarget!('remote')).toBe(manager);
    expect(manager.get('remote')?.status).toBe('disabled');

    first.dispose();
    expect(manager.get('remote')?.status).toBe('disabled');
    second.dispose();

    await vi.waitFor(() => {
      expect(manager.list()).toEqual([]);
    });
    expect((await oauth.tokenState('remote', url)).hasTokens).toBe(true);
  });

  it('starts a pinned anchor stdio server in the anchor while the root view stays on the project root', async () => {
    const wt = await checkout();
    await writeMcpJson(projectFile(wt), { cwd: { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture] } });
    await writeMcpJson(projectFile(primary), {
      rootCwd: { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture] },
    });
    const program = createProgramMcp();
    const pinned = await program.workdir(wt);
    await Promise.all([program.root.ready, pinned.ready]);

    expect(pinned.anchor).toBe(wt);
    expect(names(pinned.view())).toEqual(['cwd']);
    expect(names(program.root.view())).toEqual(['rootCwd']);
    await expect(readCwd(pinned.view(), 'cwd')).resolves.toBe(realpathSync(wt));
    await expect(readCwd(program.root.view(), 'rootCwd')).resolves.toBe(realpathSync(primary));
    pinned.dispose();
  }, 20000);

  it('lets the user layer serve a name only some live anchors define and suppresses it again on release', async () => {
    const wt = await checkout();
    await writeMcpJson(userFile(), { shared: disabledHttp() });
    await writeMcpJson(projectFile(primary), { shared: disabledStdio('project') });
    await writeMcpJson(projectFile(wt), { other: disabledStdio('wt') });
    const program = createProgramMcp();
    await program.root.ready;
    const user = plainHandle(program.root).upsertTarget!('userOnly');
    expect(user.get('shared')).toBeUndefined();

    const pinned = await program.workdir(wt);
    await pinned.ready;
    expect(user.get('shared')?.status).toBe('disabled');
    expect(pinned.view().get('shared')?.transport).toBe('http');
    expect(program.root.view().get('shared')?.transport).toBe('stdio');

    pinned.dispose();
    await vi.waitFor(() => {
      expect(user.get('shared')?.status).toBe('removed');
    });
    expect(program.root.view().get('shared')?.transport).toBe('stdio');
  });

  it('settles a pinned session only after the user servers its anchor stops suppressing have connected', async () => {
    const wt = await checkout();
    await writeMcpJson(userFile(), { shared: stdioServer() });
    await writeMcpJson(projectFile(primary), { shared: disabledStdio('project') });
    await writeMcpJson(projectFile(wt), { other: disabledStdio('wt') });
    const program = createProgramMcp();
    await program.root.ready;
    expect(program.root.view().get('shared')?.status).toBe('disabled');

    const pinned = await program.workdir(wt);
    const handle = plainHandle(pinned, 'pinned-session');
    await handle.ready;

    expect(handle.connectionManager.get('shared')).toMatchObject({ transport: 'stdio', status: 'connected' });
    expect(handle.isBaselineServer('shared')).toBe(true);
    pinned.dispose();
  }, 20000);

  it('hands a session the user server when its anchor drops an override another live anchor never defined', async () => {
    const wt = await checkout();
    await writeMcpJson(userFile(), { shared: stdioServer() });
    await writeMcpJson(projectFile(primary), {
      shared: { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture] },
    });
    await writeMcpJson(projectFile(wt), { other: disabledStdio('wt') });
    const program = createProgramMcp();
    const pinned = await program.workdir(wt);
    const handle = plainHandle(program.root, 'root-session');
    await Promise.all([handle.ready, pinned.ready]);
    const user = handle.upsertTarget!('userOnly');
    const anchor = handle.upsertTarget!('shared');
    expect(user.get('shared')?.status).toBe('connected');
    expect(handle.connectionManager.resolved('shared')?.client).toBe(anchor.resolved('shared')?.client);
    const statuses: McpServerEntry[] = [];
    const unsubscribe = handle.connectionManager.onStatusChange((entry) => statuses.push(entry));
    const overrideRemoved = new Promise<void>((resolve) => {
      const stop = anchor.onStatusChange((entry) => {
        if (entry.name !== 'shared' || entry.status !== 'removed') return;
        stop();
        resolve();
      });
    });

    await writeMcpJson(projectFile(primary), {});
    watchFires.get(primary)?.fire({ path: projectFile(primary), action: 'modified', kind: 'file' });
    await overrideRemoved;
    unsubscribe();

    expect(statuses.map((entry) => [entry.name, entry.status, entry.toolCount])).toEqual([['shared', 'connected', 4]]);
    const resolved = handle.connectionManager.resolved('shared');
    expect(resolved?.client).toBe(user.resolved('shared')?.client);
    expect(resolved?.tools.map((tool) => tool.name).toSorted()).toEqual(['boom', 'echo', 'read_env', 'whoami']);
    pinned.dispose();
  }, 20000);

  it('moves a pinned workdir to the root anchor when its directory leaves the project and stops watching it', async () => {
    const wt = await checkout();
    await writeMcpJson(projectFile(primary), { rootServer: disabledStdio('root') });
    await writeMcpJson(projectFile(wt), { wtServer: disabledStdio('wt') });
    const program = createProgramMcp();
    await program.root.ready;
    const pinned = await program.workdir(join(wt, 'src'));
    await pinned.ready;
    expect(pinned.anchor).toBe(wt);
    expect(names(pinned.view())).toEqual(['wtServer']);
    const wtManager = plainHandle(pinned).upsertTarget!('wtServer');

    projectDirs = [];
    projectChanges.fire();
    await vi.waitFor(() => {
      expect(pinned.anchor).toBe(primary);
    });
    await pinned.ready;

    expect(names(pinned.view())).toEqual(['rootServer']);
    expect(pinned.configuredNames()).toEqual(['rootServer']);
    await vi.waitFor(() => {
      expect(wtManager.list()).toEqual([]);
    });
    expect(disposedWatches).toContain(wt);
    pinned.dispose();
  });

  it('keeps a pinned workdir on its anchor when the project changes without moving it', async () => {
    const wt = await checkout();
    await writeMcpJson(projectFile(wt), { wtServer: disabledStdio('wt') });
    const program = createProgramMcp();
    await program.root.ready;
    const pinned = await program.workdir(wt);
    await pinned.ready;
    const statuses: McpServerEntry[] = [];
    const unsubscribe = pinned.view().onStatusChange((entry) => statuses.push(entry));

    projectChanges.fire();
    const second = await program.workdir(wt);

    expect(pinned.anchor).toBe(wt);
    expect(statuses).toEqual([]);
    expect(names(pinned.view())).toEqual(['wtServer']);
    unsubscribe();
    second.dispose();
    pinned.dispose();
  });

  it('moves the root view and its sessions to the new primary project servers', async () => {
    const next = temp('kimi-program-mcp-next-');
    await writeMcpJson(projectFile(primary), { first: disabledStdio('first') });
    await writeMcpJson(projectFile(next), { second: disabledHttp() });
    const program = createProgramMcp();
    await program.root.ready;
    const firstManager = plainHandle(program.root).upsertTarget!('first');
    const handle = plainHandle(program.root);
    const statuses: McpServerEntry[] = [];
    const unsubscribe = handle.connectionManager.onStatusChange((entry) => statuses.push(entry));

    primary = next;
    dirsChanges.fire();

    expect(program.root.anchor).toBe(next);
    await vi.waitFor(() => {
      expect(names(program.root.view())).toEqual(['second']);
    });
    expect(names(handle.connectionManager)).toEqual(['second']);
    expect(program.root.configuredNames()).toEqual(['second']);
    expect(firstManager.list()).toEqual([]);
    expect(statuses.map((entry) => [entry.name, entry.status])).toEqual([
      ['first', 'removed'],
      ['second', 'disabled'],
    ]);

    await writeMcpJson(projectFile(next), { second: disabledStdio('updated') });
    watchFires.get(next)?.fire({ path: projectFile(next), action: 'modified', kind: 'file' });
    await vi.waitFor(() => {
      expect(program.root.view().get('second')?.transport).toBe('stdio');
    });
    unsubscribe();
  });

  it('reconnects cwd-less user stdio servers in the new primary', async () => {
    const next = temp('kimi-program-mcp-next-');
    await writeMcpJson(userFile(), { userCwd: { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture] } });
    const program = createProgramMcp();
    await program.root.ready;
    await expect(readCwd(program.root.view(), 'userCwd')).resolves.toBe(realpathSync(primary));

    primary = next;
    dirsChanges.fire();

    await vi.waitFor(async () => {
      await expect(readCwd(program.root.view(), 'userCwd')).resolves.toBe(realpathSync(next));
    }, { timeout: 10000, interval: 100 });
  }, 20000);

  it('reports the initial MCP load once, for the root view only', async () => {
    const wt = await checkout();
    await writeMcpJson(projectFile(primary), { alpha: stdioServer() });
    await writeMcpJson(projectFile(wt), { beta: stdioServer() });
    const program = createProgramMcp();
    await program.root.ready;
    await vi.waitFor(() => {
      expect(track2).toHaveBeenCalledWith('mcp_connected', { server_count: 1, total_count: 1 });
    });

    const pinned = await program.workdir(wt);
    await pinned.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(track2).toHaveBeenCalledTimes(1);
    pinned.dispose();
  }, 20000);

  describe('session handles', () => {
    it('admit servers connecting before ready settles and freeze the baseline after', async () => {
      await writeMcpJson(projectFile(primary), { alpha: stdioServer() });
      let settleConnectAll: () => void = () => undefined;
      vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
        this: McpConnectionManager,
        servers: Readonly<Record<string, McpServerConfig>>,
      ) {
        for (const [name, config] of Object.entries(servers)) {
          void this.connect(name, config);
        }
        return new Promise<void>((resolve) => {
          settleConnectAll = resolve;
        });
      });

      const program = createProgramMcp();
      const handle = plainHandle(program.root);

      await vi.waitFor(() => {
        expect(handle.connectionManager.get('alpha')).toBeDefined();
      });
      expect(handle.isBaselineServer('alpha')).toBe(true);
      expect(handle.isBaselineServer('ghost')).toBe(false);

      settleConnectAll();
      await program.root.ready;

      await handle.upsertTarget!('alpha').connect('late', stdioServer());
      expect(handle.isBaselineServer('late')).toBe(false);
      expect(handle.isBaselineServer('alpha')).toBe(true);

      expect(plainHandle(program.root).isBaselineServer('late')).toBe(true);
    }, 20000);

    it('admit servers that finished the initial load before the first baseline read', async () => {
      await writeMcpJson(projectFile(primary), { alpha: stdioServer() });
      const program = createProgramMcp();
      const handle = plainHandle(program.root);

      await program.root.ready;
      expect(program.root.view().get('alpha')?.status).toBe('connected');

      expect(handle.isBaselineServer('alpha')).toBe(true);
    }, 20000);

    it('admit a needs-auth server that settled before the first baseline read', async () => {
      const server = await startInProcessHttpMcpServer({ authToken: 'secret' });
      try {
        await writeMcpJson(projectFile(primary), { remote: { transport: 'http', url: server.url } });
        const program = createProgramMcp();
        const handle = plainHandle(program.root);

        await program.root.ready;
        expect(program.root.view().get('remote')?.status).toBe('needs-auth');

        expect(handle.isBaselineServer('remote')).toBe(true);
      } finally {
        await server.close();
      }
    }, 20000);

    it('mark ephemeral server names as baseline by construction', async () => {
      await writeMcpJson(projectFile(primary), { base: stdioServer() });
      const program = createProgramMcp();
      await program.root.ready;

      const lease = program.root.sessionHandle({
        sessionId: 'session-1',
        ephemeral: { eph: ephemeralStdio() },
      });
      expect(lease.handle.isBaselineServer('eph')).toBe(true);
      expect(lease.handle.isBaselineServer('base')).toBe(true);

      await lease.handle.ready;
      expect(lease.handle.isBaselineServer('eph')).toBe(true);
      expect(lease.handle.isBaselineServer('late')).toBe(false);

      await lease.dispose();
    }, 20000);

    it('freeze the workspace baseline on workspace ready even while the ephemeral connect is pending', async () => {
      await writeMcpJson(projectFile(primary), { base: stdioServer() });
      let settleOverlay: () => void = () => undefined;
      vi.spyOn(McpConnectionManager.prototype, 'connectAll').mockImplementation(function (
        this: McpConnectionManager,
        servers: Readonly<Record<string, McpServerConfig>>,
      ) {
        if ('eph' in servers) {
          return new Promise<void>((resolve) => {
            settleOverlay = resolve;
          });
        }
        for (const [name, config] of Object.entries(servers)) {
          void this.connect(name, config);
        }
        return Promise.resolve();
      });
      const program = createProgramMcp();
      await program.root.ready;

      const lease = program.root.sessionHandle({
        sessionId: 'session-1',
        ephemeral: { eph: ephemeralStdio() },
      });
      expect(lease.handle.isBaselineServer('eph')).toBe(true);
      expect(lease.handle.isBaselineServer('base')).toBe(true);

      await plainHandle(program.root).upsertTarget!('base').connect('late', stdioServer());
      expect(lease.handle.isBaselineServer('late')).toBe(false);

      settleOverlay();
      await lease.handle.ready;
      expect(lease.handle.isBaselineServer('late')).toBe(false);
      expect(lease.handle.isBaselineServer('eph')).toBe(true);

      await lease.dispose();
    }, 20000);

    it('connect ephemeral servers on a session-owned manager released by dispose', async () => {
      await writeMcpJson(projectFile(primary), { base: stdioServer() });
      const program = createProgramMcp();
      await program.root.ready;

      const lease = program.root.sessionHandle({
        sessionId: 'session-1',
        ephemeral: { eph: ephemeralStdio() },
      });
      await lease.handle.ready;

      const view = lease.handle.connectionManager;
      expect(view.get('eph')?.status).toBe('connected');
      expect(view.get('base')?.status).toBe('connected');
      expect(program.root.view().get('eph')).toBeUndefined();
      expect(program.root.configuredNames()).toEqual(['base']);
      expect(lease.handle.upsertTarget).toBeUndefined();

      await lease.dispose();
      expect(view.get('eph')).toBeUndefined();
      expect(view.get('base')?.status).toBe('connected');
    }, 20000);

    it('tag ephemeral stdio resources with the session id while layer servers stay untagged', async () => {
      await writeMcpJson(projectFile(primary), { base: stdioServer() });
      const program = createProgramMcp();
      await program.root.ready;

      const lease = program.root.sessionHandle({
        sessionId: 'session-1',
        ephemeral: { eph: ephemeralStdio() },
      });
      await lease.handle.ready;

      expect(new Set(tracked)).toEqual(new Set([undefined, 'session-1']));
      await lease.dispose();
    }, 20000);

    it('route explicit upserts to the anchor layer for anchor-defined names and to the user layer otherwise', async () => {
      await writeMcpJson(projectFile(primary), { project: disabledStdio('project') });
      await writeMcpJson(userFile(), { user: disabledStdio('user') });
      const program = createProgramMcp();
      await program.root.ready;
      const handle = plainHandle(program.root);

      const anchor = handle.upsertTarget!('project');
      const user = handle.upsertTarget!('user');
      expect(anchor.get('project')?.status).toBe('disabled');
      expect(user.get('user')?.status).toBe('disabled');
      expect(handle.upsertTarget!('added-later')).toBe(user);

      await handle.upsertTarget!('added-later').connect('added-later', disabledHttp());
      expect(handle.connectionManager.get('added-later')?.transport).toBe('http');
      expect(program.root.view().get('added-later')?.transport).toBe('http');
    });

    it('serve an explicit upsert of a name the project config has dropped', async () => {
      await writeMcpJson(projectFile(primary), { dropped: disabledStdio('project'), kept: disabledStdio('kept') });
      const program = createProgramMcp();
      await program.root.ready;
      const handle = plainHandle(program.root);
      const anchor = handle.upsertTarget!('kept');
      await writeMcpJson(projectFile(primary), { kept: disabledStdio('kept') });
      watchFires.get(primary)?.fire({ path: projectFile(primary), action: 'modified', kind: 'file' });
      await vi.waitFor(() => {
        expect(anchor.get('dropped')?.status).toBe('removed');
      });

      await handle.upsertTarget!('dropped').connect('dropped', disabledHttp());

      expect(handle.connectionManager.get('dropped')).toMatchObject({ transport: 'http', status: 'disabled' });
      expect(program.root.view().get('dropped')).toMatchObject({ transport: 'http', status: 'disabled' });
    });
  });
});
