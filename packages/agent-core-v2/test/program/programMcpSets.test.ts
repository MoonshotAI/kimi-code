import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { basename, join, normalize, relative } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter, Event } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import type { McpConfigWriteEvent } from '#/app/mcpConfig/configStore';
import type { PluginReloadEvent } from '#/app/plugin/types';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { projectDirAt } from '#/app/project/projectWorkDir';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import { McpConnectionManager, type McpConnectionView } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcess } from '#/os/interface/hostProcess';
import type { ProgramDependencies } from '#/program/programDependencies';
import type { ProgramMcpLease } from '#/program/programMcp';
import { ProgramMcpSets } from '#/program/programMcpSets';
import { SessionMcpService } from '#/session/mcp/sessionMcpService';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';
import type { ProjectTrustChange } from '#/project/projectTrust/projectTrust';

import { stubLog } from '../_base/log/stubs';
import { stubAgentIdentity } from '../app/agentIdentity/stubs';
import { bareRepository, forgedPointer, linkedWorktree, mainCheckout } from '../app/git/checkoutLayouts';
import { fakeMcpServerName } from '@moonshot-ai/testkit/fixtures';

import { createMemoryMcpOAuthStore, cwdStdioServer, hostPathClass, startEchoHttpMcpServer } from '../mcpCore/stubs';

const NO_ABORT = new AbortController().signal;
const PROCESS_TIMEOUT_MS = 20_000;

function stdioServer(tag: string, config: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'stdio', ...cwdStdioServer(tag), ...config } as McpServerConfig;
}

function disabledServer(): McpServerConfig {
  return { transport: 'stdio', command: 'never-runs', enabled: false };
}

async function writeMcpJson(path: string, servers: Record<string, McpServerConfig>): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }), 'utf8');
}

function names(view: McpConnectionView): string[] {
  return view.list().filter((entry) => entry.status !== 'removed').map((entry) => entry.name).toSorted();
}

async function cwdOf(view: McpConnectionView, name: string): Promise<string> {
  const resolved = view.resolved(name);
  if (resolved === undefined) throw new Error(`expected ${name} to be connected, got ${JSON.stringify(view.get(name))}`);
  const result = await resolved.client.callTool('get_cwd', {});
  return normalize(realpathSync.native((result.content[0] as { type: 'text'; text: string }).text));
}

describe('ProgramMcpSets', () => {
  let disposables: DisposableStore;
  let tempDirs: string[];
  let homeDir: string;
  let checkout: string;
  let primary: string;
  let dirsChanges: Emitter<void>;
  let trusted: boolean;
  let trustChanges: Emitter<ProjectTrustChange>;
  let pluginServers: Record<string, McpServerConfig>;
  let pluginReloads: AsyncEmitter<PluginReloadEvent>;
  let storeWrites: AsyncEmitter<McpConfigWriteEvent>;
  let oauth: McpOAuthService;
  let created: ProgramMcpSets[];
  let sessions: SessionMcpService[];
  let environmentServices: IEnvironmentService;
  let spawn: MockInstance<HostProcessService['spawn']>;

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_WATCH', 'false');
    disposables = new DisposableStore();
    tempDirs = [];
    homeDir = tempDir('kimi-mcp-sets-home-');
    checkout = tempDir('kimi-mcp-sets-checkout-');
    primary = checkout;
    dirsChanges = disposables.add(new Emitter<void>());
    trusted = true;
    trustChanges = disposables.add(new Emitter<ProjectTrustChange>());
    pluginServers = {};
    pluginReloads = disposables.add(new AsyncEmitter<PluginReloadEvent>());
    storeWrites = disposables.add(new AsyncEmitter<McpConfigWriteEvent>());
    oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    created = [];
    sessions = [];
    spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
  });

  afterEach(async () => {
    await Promise.all(sessions.map((session) => session.disposeAsync()));
    await Promise.all(created.map((sets) => sets.dispose()));
    await oauth.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    disposables.dispose();
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function tempDir(prefix: string): string {
    const dir = normalize(realpathSync.native(mkdtempSync(join(tmpdir(), prefix))));
    tempDirs.push(dir);
    return dir;
  }

  async function subdir(...segments: string[]): Promise<string> {
    const dir = join(checkout, ...segments);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  function worktreeOf(main: string): string {
    return linkedWorktree(join(main, '.git'), tempDir('kimi-mcp-sets-worktree-'));
  }

  const userFile = () => join(homeDir, 'mcp.json');
  const checkoutFile = (dir: string) => join(dir, '.mcp.json');
  const workDirFile = (dir: string) => join(dir, '.kimi-code', 'mcp.json');

  function createSets(overrides: Partial<ProgramDependencies> = {}): ProgramMcpSets {
    const environment = Object.assign(
      new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'], pathClass: hostPathClass }),
      { process: new HostProcessService() },
    );
    const lease = { environment, track: <T,>(resource: T): T => resource, dispose: () => {} };
    environmentServices = {
      _serviceBrand: undefined,
      inspect: () => environment,
      acquire: () => lease,
      acquireWhenReady: async () => lease,
    } as unknown as IEnvironmentService;
    const dependencies = {
      bootstrap: { homeDir },
      config: { ready: Promise.resolve(), onDidSectionChange: Event.None, get: () => undefined },
      configStore: { onDidWrite: storeWrites.event },
      identity: stubAgentIdentity(),
      log: stubLog(),
      oauth,
      plugins: {
        enabledMcpServers: async () => pluginServers,
        mcpServerEntries: async () =>
          Object.entries(pluginServers).map(([name, config]) => ({ name, config, pluginId: 'plugin', serverName: name })),
        onDidReload: pluginReloads.event,
      },
      sessionManager: { current: undefined, onDidChange: Event.None },
      telemetry: noopTelemetryService,
      workspaces: {
        projectDirAt: ({ root }: { readonly root: string }, dir: string) =>
          projectDirAt(root, dir, { fs: new HostFileSystem(), homeDirs: [homeDir] }),
      },
      ...overrides,
    } as unknown as ProgramDependencies;
    const sets = new ProgramMcpSets(
      {
        _serviceBrand: undefined,
        inspect: () => environment,
        acquire: () => lease,
        acquireWhenReady: async () => lease,
      } as unknown as IEnvironmentService,
      { workspaceId: 'workspace' } as IProjectContext,
      dependencies,
      new HostFileSystem(),
      {
        ready: Promise.resolve(),
        get primary() {
          return primary;
        },
        onDidChange: dirsChanges.event,
      } as unknown as IProjectDirs,
      {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: async () => trusted,
        isTrusted: () => trusted,
        trust: async () => undefined,
        untrust: async () => undefined,
        onDidChange: trustChanges.event,
      },
    );
    created.push(sets);
    return sets;
  }

  async function settled(lease: ProgramMcpLease): Promise<McpConnectionView> {
    const sessionId = `settled-${sessions.length}`;
    const session = new SessionMcpService(
      makeSessionContext({ sessionId, workspaceId: 'workspace', sessionDir: checkout, sessionScope: 'ws', cwd: checkout }),
      {},
      lease.service.sources(),
      [],
      { ready: Promise.resolve(), get: () => undefined } as never,
      oauth,
      environmentServices,
      stubAgentIdentity(),
      stubLog(),
    );
    sessions.push(session);
    const disposeLease = lease.dispose;
    let released = false;
    lease.dispose = () => {
      if (released) return;
      released = true;
      void session.disposeAsync();
      disposeLease();
    };
    await session.ready;
    return session.connectionManager;
  }

  function startedTags(): string[] {
    return spawn.mock.calls.map(([, args]) => fakeMcpServerName(args) ?? '').toSorted();
  }

  function startedProcesses(): Promise<IHostProcess[]> {
    return Promise.all(spawn.mock.results.map((result) => result.value as Promise<IHostProcess>));
  }

  function setTrusted(next: boolean): void {
    trusted = next;
    trustChanges.fire({ trusted: next });
  }

  it('serves a checkout from one set, configured for and started in the primary directory, and reads no config of a subdirectory', async () => {
    mainCheckout(checkout);
    const installed = await subdir('node_modules', 'some-package');
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(checkoutFile(checkout), { shared: stdioServer('shared') });
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    await writeMcpJson(workDirFile(installed), { planted: stdioServer('planted') });
    const sets = createSets();

    const inSubdir = await sets.acquire(installed);
    const view = await settled(inSubdir);

    expect((await sets.acquire()).service).toBe(inSubdir.service);
    expect(names(view)).toEqual(['home', 'shared', 'user']);
    expect(await Promise.all(names(view).map((name) => cwdOf(view, name)))).toEqual([checkout, checkout, checkout]);
    await expect(sets.effectiveWorkDir(installed)).resolves.toBe(checkout);
    expect(startedTags()).toEqual(['home', 'shared', 'user']);
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ['beside the main checkout', () => tempDir('kimi-mcp-sets-worktree-')],
    ['inside the main checkout', () => join(checkout, 'worktrees', 'fix')],
  ])('gives a linked worktree %s its own servers, read from and started in its root, and shares them with its subdirectories', async (_label, place) => {
    mainCheckout(checkout);
    const worktree = linkedWorktree(join(checkout, '.git'), place());
    const src = join(worktree, 'src');
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(checkoutFile(checkout), { main: disabledServer() });
    await writeMcpJson(workDirFile(checkout), { home: disabledServer() });
    await writeMcpJson(checkoutFile(worktree), { shared: stdioServer('shared') });
    await writeMcpJson(workDirFile(worktree), { worktree: stdioServer('worktree') });
    await writeMcpJson(workDirFile(src), { planted: stdioServer('planted') });
    const sets = createSets();

    const atWorktree = await sets.acquire(worktree);
    const inSubdir = await sets.acquire(src);
    const view = await settled(atWorktree);

    expect(inSubdir.service).toBe(atWorktree.service);
    expect(names(view)).toEqual(['shared', 'user', 'worktree']);
    expect(await Promise.all(names(view).map((name) => cwdOf(view, name)))).toEqual([worktree, worktree, worktree]);
    await expect(Promise.all([worktree, src].map((dir) => sets.effectiveWorkDir(dir)))).resolves.toEqual([worktree, worktree]);
    expect(names(await settled(await sets.acquire()))).toEqual(['home', 'main', 'user']);
  }, PROCESS_TIMEOUT_MS);

  it('gives the worktrees of a bare repository their own servers at the root of their checkout', async () => {
    primary = bareRepository(tempDir('kimi-mcp-sets-bare-'));
    const worktree = linkedWorktree(primary, tempDir('kimi-mcp-sets-worktree-'));
    const src = join(worktree, 'src');
    await writeMcpJson(checkoutFile(worktree), { shared: stdioServer('shared') });
    await writeMcpJson(workDirFile(src), { planted: stdioServer('planted') });
    const sets = createSets();

    const inSubdir = await sets.acquire(src);
    const view = await settled(inSubdir);

    expect((await sets.acquire(worktree)).service).toBe(inSubdir.service);
    expect(names(view)).toEqual(['shared']);
    await expect(cwdOf(view, 'shared')).resolves.toBe(worktree);
    await expect(sets.effectiveWorkDir(src)).resolves.toBe(worktree);
    expect(names(await settled(await sets.acquire()))).toEqual([]);
  }, PROCESS_TIMEOUT_MS);

  it('gives the main checkout its own servers when the primary directory is one of its worktrees', async () => {
    mainCheckout(checkout);
    primary = worktreeOf(checkout);
    await writeMcpJson(workDirFile(checkout), { main: disabledServer() });
    await writeMcpJson(workDirFile(primary), { home: disabledServer() });
    const sets = createSets();

    const inMain = await settled(await sets.acquire(await subdir('src')));
    const atPrimary = await settled(await sets.acquire(primary));

    expect([names(inMain), names(atPrimary)]).toEqual([['main'], ['home']]);
    await expect(sets.effectiveWorkDir(checkout)).resolves.toBe(checkout);
  });

  it('starts nothing for a checkout nobody holds', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    await writeMcpJson(workDirFile(worktree), { worktree: stdioServer('worktree') });
    const sets = createSets();

    await settled(await sets.acquire(worktree));

    expect(startedTags()).toEqual(['worktree']);
    expect(sets.servers()).toEqual({});
    await expect(sets.effectiveWorkDir()).resolves.toBe(checkout);
    expect(startedTags()).toEqual(['worktree']);
  }, PROCESS_TIMEOUT_MS);

  it('stops the set of a checkout with its last holder and leaves the others running', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    await writeMcpJson(workDirFile(worktree), { worktree: stdioServer('worktree') });
    const sets = createSets();
    const atPrimary = await settled(await sets.acquire());
    const first = await sets.acquire(worktree);
    const second = await sets.acquire(worktree);
    const atWorktree = await settled(first);

    first.dispose();
    expect(atWorktree.get('worktree')?.status).toBe('connected');

    second.dispose();
    const [, child] = await startedProcesses();
    await vi.waitFor(() => {
      expect(child!.exitCode).not.toBeNull();
    }, PROCESS_TIMEOUT_MS);
    expect(atWorktree.list()).toEqual([]);
    expect(atPrimary.get('home')?.status).toBe('connected');
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ['a link to it from another repository', async (worktree: string) => {
      const other = mainCheckout(tempDir('kimi-mcp-sets-other-'));
      await writeMcpJson(checkoutFile(other), { foreign: stdioServer('foreign') });
      const link = join(other, 'fix');
      await symlink(worktree, link, 'dir');
      return link;
    }],
    ['a relative path', async (worktree: string) => relative(process.cwd(), worktree)],
  ])('configures and starts the servers of a worktree at its real path when it is pinned as %s', async (_label, spell) => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(checkoutFile(worktree), { shared: stdioServer('shared') });
    const pinned = await spell(worktree);
    const sets = createSets();

    const lease = await sets.acquire(pinned);
    const view = await settled(lease);

    expect(names(view)).toEqual(['shared', 'user']);
    expect(await Promise.all(names(view).map((name) => cwdOf(view, name)))).toEqual([worktree, worktree]);
    await expect(sets.effectiveWorkDir(pinned)).resolves.toBe(worktree);
    expect((await sets.acquire(worktree)).service).toBe(lease.service);
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ['another repository', async () => mainCheckout(tempDir('kimi-mcp-sets-other-'))],
    ['a directory outside any repository', async () => tempDir('kimi-mcp-sets-plain-')],
    ['a repository nested in the checkout', async () => mainCheckout(await subdir('vendor', 'nested'))],
    ['a directory whose forged .git file borrows a worktree of the repository', async () => forgedPointer(
      tempDir('kimi-mcp-sets-forged-'),
      join(checkout, '.git', 'worktrees', basename(worktreeOf(checkout))),
    )],
    ['a directory in the checkout whose .git file names a worktree the repository does not have', async () => {
      const dir = await subdir('worktrees', 'fix');
      await writeFile(join(dir, '.git'), `gitdir: ${join(checkout, '.git', 'worktrees', 'fix')}\n`);
      return dir;
    }],
    ['a link in the checkout that leaves it', async () => {
      const link = join(checkout, 'outside');
      await symlink(tempDir('kimi-mcp-sets-target-'), link, 'dir');
      return link;
    }],
    ['a link that leads back to itself', async () => {
      const link = join(checkout, 'loop');
      await symlink(link, link, 'dir');
      return link;
    }],
    ['another spelling of the primary directory', async () => {
      const link = join(tempDir('kimi-mcp-sets-link-'), 'app');
      await symlink(checkout, link, 'dir');
      return link;
    }],
  ])('serves %s from the set of the primary directory', async (_label, prepare) => {
    mainCheckout(checkout);
    const dir = await prepare();
    await writeMcpJson(workDirFile(checkout), { home: disabledServer() });
    const sets = createSets();

    const atPrimary = await sets.acquire();
    const pinned = await sets.acquire(dir);

    expect(pinned.service).toBe(atPrimary.service);
    expect(names(await settled(pinned))).toEqual(['home']);
    await expect(sets.effectiveWorkDir(dir)).resolves.toBe(checkout);
  });

  it.each([
    ['its counterpart in a worktree', (worktree: string) => join(worktree, 'packages', 'app')],
    ['a directory inside its counterpart', (worktree: string) => join(worktree, 'packages', 'app', 'src')],
  ])('serves %s from the counterpart when the primary directory is a subdirectory of a repository', async (_label, place) => {
    mainCheckout(checkout);
    primary = await subdir('packages', 'app');
    const worktree = worktreeOf(checkout);
    const counterpart = join(worktree, 'packages', 'app');
    const dir = place(worktree);
    await writeMcpJson(workDirFile(dir), { planted: disabledServer() });
    await writeMcpJson(workDirFile(primary), { home: disabledServer() });
    await writeMcpJson(checkoutFile(worktree), { shared: disabledServer() });
    await writeMcpJson(workDirFile(counterpart), { own: disabledServer() });
    const sets = createSets();

    const pinned = await sets.acquire(dir);

    expect(names(await settled(pinned))).toEqual(['own', 'shared']);
    expect((await sets.acquire(counterpart)).service).toBe(pinned.service);
    await expect(sets.effectiveWorkDir(dir)).resolves.toBe(counterpart);
  });

  it.each([
    ['a directory inside it', (main: string) => join(main, 'packages', 'app', 'src')],
    ['the repository', (main: string) => main],
    ['a worktree of the repository', (_main: string, worktree: string) => worktree],
    ['a directory beside it', (main: string) => join(main, 'packages', 'sibling')],
    ['a directory whose name starts with its name', (main: string) => join(main, 'packages', 'application')],
    ['another subdirectory of a worktree', (_main: string, worktree: string) => join(worktree, 'packages', 'application')],
  ])('serves %s from the set of the primary directory when that is a subdirectory of a repository', async (_label, place) => {
    mainCheckout(checkout);
    primary = await subdir('packages', 'app');
    const dir = place(checkout, worktreeOf(checkout));
    await writeMcpJson(workDirFile(primary), { home: disabledServer() });
    await writeMcpJson(workDirFile(dir), { own: disabledServer() });
    const sets = createSets();

    const atPrimary = await sets.acquire();
    const pinned = await sets.acquire(dir);

    expect(pinned.service).toBe(atPrimary.service);
    expect(names(await settled(pinned))).toEqual(['home']);
    await expect(sets.effectiveWorkDir(dir)).resolves.toBe(primary);
  });

  it.each([
    ['in the checkout', () => join(checkout, 'gone')],
    ['elsewhere', () => join(tempDir('kimi-mcp-sets-gone-'), 'worktree')],
  ])('leaves a working directory %s that no longer exists without the servers of the primary directory', async (_label, place) => {
    mainCheckout(checkout);
    const gone = place();
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(checkoutFile(checkout), { shared: stdioServer('shared') });
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    const sets = createSets();

    const view = await settled(await sets.acquire(gone));

    expect(view.list().map((entry) => [entry.name, entry.status])).toEqual([['user', 'failed']]);
    expect(startedTags()).toEqual(['user']);
    await expect(sets.effectiveWorkDir(gone)).resolves.toBe(gone);
  }, PROCESS_TIMEOUT_MS);

  it('leaves a working directory that no longer exists in another repository without the servers of that repository', async () => {
    mainCheckout(checkout);
    const other = mainCheckout(tempDir('kimi-mcp-sets-other-'));
    const gone = join(other, 'sub');
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(checkoutFile(other), { other: stdioServer('other') });
    const sets = createSets();

    const view = await settled(await sets.acquire(gone));

    expect(view.list().map((entry) => [entry.name, entry.status])).toEqual([['user', 'failed']]);
    expect(startedTags()).toEqual(['user']);
    await expect(sets.effectiveWorkDir(gone)).resolves.toBe(gone);
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ['elsewhere', () => tempDir('kimi-mcp-sets-gone-')],
    ['in the checkout', () => checkout],
    ['in another repository', () => mainCheckout(tempDir('kimi-mcp-sets-other-'))],
  ])('leaves a working directory under what is now a file %s without the servers of any project', async (_label, place) => {
    mainCheckout(checkout);
    const root = place();
    const file = join(root, 'worktrees');
    await writeFile(file, '', 'utf8');
    const gone = join(file, 'feature');
    await writeMcpJson(checkoutFile(root), { shared: stdioServer('shared') });
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    const sets = createSets();

    const view = await settled(await sets.acquire(gone));

    expect(names(view)).toEqual([]);
    expect(startedTags()).toEqual([]);
    await expect(sets.effectiveWorkDir(gone)).resolves.toBe(gone);
  }, PROCESS_TIMEOUT_MS);

  it('serves a working directory that comes back by the rules of a checkout, not from the set it had while it was missing', async () => {
    mainCheckout(checkout);
    const later = join(tempDir('kimi-mcp-sets-later-'), 'worktree');
    await writeMcpJson(userFile(), { user: disabledServer() });
    const sets = createSets();
    const whileMissing = await sets.acquire(later);
    expect(names(await settled(whileMissing))).toEqual(['user']);

    linkedWorktree(join(checkout, '.git'), later);
    await writeMcpJson(checkoutFile(later), { shared: disabledServer() });
    await writeMcpJson(workDirFile(later), { worktree: disabledServer() });
    const back = await sets.acquire(later);

    expect(back.service).not.toBe(whileMissing.service);
    expect(names(await settled(back))).toEqual(['shared', 'user', 'worktree']);
    await expect(sets.effectiveWorkDir(later)).resolves.toBe(later);
    expect(startedTags()).toEqual([]);
  });

  it('serves every directory outside a repository from the set of the primary directory', async () => {
    const inside = await subdir('inside');
    await writeMcpJson(workDirFile(inside), { own: disabledServer() });
    const sets = createSets();

    const pinned = await sets.acquire(inside);

    expect(names(await settled(pinned))).toEqual([]);
    expect(pinned.service).toBe((await sets.acquire()).service);
  });

  it('moves only the set of the primary directory when the primary changes', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const next = tempDir('kimi-mcp-sets-next-');
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    await writeMcpJson(workDirFile(worktree), { worktree: stdioServer('worktree') });
    await writeMcpJson(workDirFile(next), { moved: stdioServer('moved') });
    const sets = createSets();
    const atPrimary = await settled(await sets.acquire());
    const atWorktree = await settled(await sets.acquire(worktree));
    const worktreeClient = atWorktree.resolved('worktree')?.client;

    primary = next;
    dirsChanges.fire();

    await vi.waitFor(async () => {
      expect(names(atPrimary)).toEqual(['moved', 'user']);
      await expect(cwdOf(atPrimary, 'user')).resolves.toBe(next);
      await expect(cwdOf(atPrimary, 'moved')).resolves.toBe(next);
    }, PROCESS_TIMEOUT_MS);
    expect(names(atWorktree)).toEqual(['user', 'worktree']);
    expect(atWorktree.resolved('worktree')?.client).toBe(worktreeClient);
    await expect(cwdOf(atWorktree, 'user')).resolves.toBe(worktree);
  }, PROCESS_TIMEOUT_MS * 2);

  it('drops and restores the project servers of every set with the trust of the project', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    await writeMcpJson(userFile(), { user: disabledServer() });
    await writeMcpJson(workDirFile(checkout), { home: disabledServer() });
    await writeMcpJson(workDirFile(worktree), { worktree: disabledServer() });
    trusted = false;
    const sets = createSets();
    const atPrimary = await settled(await sets.acquire());
    const atWorktree = await settled(await sets.acquire(worktree));
    const everywhere = () => [atPrimary, atWorktree].map((view) => names(view));
    expect(everywhere()).toEqual([['user'], ['user']]);

    setTrusted(true);
    await vi.waitFor(() => {
      expect(everywhere()).toEqual([['home', 'user'], ['user', 'worktree']]);
    });

    setTrusted(false);
    await vi.waitFor(() => {
      expect(everywhere()).toEqual([['user'], ['user']]);
    });
  });

  it('applies user config writes and plugin reloads to every set', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const sets = createSets();
    const atPrimary = await settled(await sets.acquire());
    const atWorktree = await settled(await sets.acquire(worktree));

    await writeMcpJson(userFile(), { user: disabledServer() });
    await storeWrites.fireAsync({ path: userFile() } as never, NO_ABORT);
    pluginServers = { fromPlugin: disabledServer() };
    await pluginReloads.fireAsync({ added: [], removed: [], errors: [] } as never, NO_ABORT);

    expect([names(atPrimary), names(atWorktree)]).toEqual([['fromPlugin', 'user'], ['fromPlugin', 'user']]);
  });

  it('reconnects a server in every set once it is authorized', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const remote = await startEchoHttpMcpServer({ bearerToken: 'secret' });
    try {
      await writeMcpJson(userFile(), { remote: { transport: 'http', url: remote.url } });
      const sets = createSets();
      const leases = [await sets.acquire(), await sets.acquire(worktree)];
      const views = await Promise.all(leases.map(settled));
      expect(views.map((view) => view.get('remote')?.status)).toEqual(['needs-auth', 'needs-auth']);
      const reconnect = vi.spyOn(McpConnectionManager.prototype, 'reconnectAndJoin').mockResolvedValue(undefined);

      await oauth.getProvider('remote', remote.url).saveTokens({ access_token: 'secret', token_type: 'Bearer' });

      await vi.waitFor(() => {
        expect(reconnect.mock.calls).toEqual([['remote'], ['remote']]);
      });
      expect(new Set(reconnect.mock.contexts)).toEqual(
        new Set(
          leases.map((lease) => lease.service.sources().find((source) => source.id === 'user')?.view),
        ),
      );
    } finally {
      await remote.close();
    }
  });

  it('keeps stored credentials of a server until no set configures it any more', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const url = 'https://mcp.example.test/mcp';
    const remote: McpServerConfig = { transport: 'http', url, auth: 'oauth', enabled: false };
    await writeMcpJson(workDirFile(checkout), { remote });
    await writeMcpJson(workDirFile(worktree), { remote });
    await oauth.getProvider('remote', url).saveTokens({ access_token: 'a', token_type: 'Bearer' });
    const sets = createSets();
    await settled(await sets.acquire());
    await settled(await sets.acquire(worktree));

    await writeMcpJson(workDirFile(worktree), {});
    await storeWrites.fireAsync({ path: userFile() } as never, NO_ABORT);
    expect((await oauth.tokenState('remote', url)).hasTokens).toBe(true);

    await writeMcpJson(workDirFile(checkout), {});
    await storeWrites.fireAsync({ path: userFile() } as never, NO_ABORT);
    expect((await oauth.tokenState('remote', url)).hasTokens).toBe(false);
  });

  it('keeps stored credentials when the last holder of a checkout leaves', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const url = 'https://mcp.example.test/mcp';
    await writeMcpJson(workDirFile(worktree), { remote: { transport: 'http', url, auth: 'oauth', enabled: false } });
    await oauth.getProvider('remote', url).saveTokens({ access_token: 'a', token_type: 'Bearer' });
    const sets = createSets();
    const lease = await sets.acquire(worktree);
    const view = await settled(lease);
    expect(names(view)).toEqual(['remote']);

    await Promise.all(sessions.map((session) => session.disposeAsync()));
    lease.dispose();
    await sets.dispose();

    expect(view.list()).toEqual([]);
    expect((await oauth.tokenState('remote', url)).hasTokens).toBe(true);
  });

  it('reports the initial load of every set', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    await writeMcpJson(workDirFile(checkout), { home: stdioServer('home') });
    await writeMcpJson(workDirFile(worktree), { worktree: stdioServer('worktree'), off: disabledServer() });
    const track2 = vi.fn();
    const sets = createSets({ telemetry: { ...noopTelemetryService, track2 } });

    await settled(await sets.acquire());
    await settled(await sets.acquire(worktree));

    expect(track2.mock.calls).toEqual([
      ['mcp_connected', { server_count: 1, total_count: 1 }],
      ['mcp_connected', { server_count: 1, total_count: 1 }],
    ]);
  }, PROCESS_TIMEOUT_MS);

  it('joins session-provided servers to the set of their session and starts them in the directory of that set', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const src = join(worktree, 'src');
    const elsewhere = tempDir('kimi-mcp-sets-other-');
    await mkdir(src);
    await writeMcpJson(workDirFile(checkout), { home: disabledServer() });
    await writeMcpJson(workDirFile(worktree), { worktree: disabledServer() });
    const sets = createSets();
    const openSession = async (cwd: string, pinned?: string) => {
      const lease = await sets.acquire(pinned);
      const environment = Object.assign(
        new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'] }),
        { process: new HostProcessService() },
      );
      const envLease = { environment, track: <T,>(resource: T): T => resource, dispose: () => {} };
      const service = new SessionMcpService(
        makeSessionContext({ sessionId: cwd, workspaceId: 'wd', sessionDir: cwd, sessionScope: cwd, cwd }),
        { eph: stdioServer('eph', { environment_id: 'local' }) },
        lease.service.sources(),
        [],
        { ready: Promise.resolve(), get: () => undefined } as never,
        oauth,
        {
          inspect: () => environment,
          acquire: () => envLease,
          acquireWhenReady: async () => envLease,
        } as unknown as IEnvironmentService,
        stubAgentIdentity(),
        stubLog(),
      );
      await service.ready;
      return {
        view: service.connectionManager,
        close: () => {
          service.dispose();
          lease.dispose();
        },
      };
    };

    const atPrimary = await openSession(checkout);
    const inWorktree = await openSession(src, src);
    const unrelated = await openSession(elsewhere, elsewhere);

    expect(names(atPrimary.view)).toEqual(['eph', 'home']);
    expect(names(inWorktree.view)).toEqual(['eph', 'worktree']);
    expect(names(unrelated.view)).toEqual(['eph', 'home']);
    await expect(cwdOf(atPrimary.view, 'eph')).resolves.toBe(checkout);
    await expect(cwdOf(inWorktree.view, 'eph')).resolves.toBe(worktree);
    await expect(cwdOf(unrelated.view, 'eph')).resolves.toBe(checkout);
    for (const session of [atPrimary, inWorktree, unrelated]) session.close();
    const children = await startedProcesses();
    await vi.waitFor(() => {
      expect(children.map((child) => child.exitCode === null)).toEqual([false, false, false]);
    }, PROCESS_TIMEOUT_MS);
  }, PROCESS_TIMEOUT_MS);

  it('stops every set when the program goes away and admits no new holder', async () => {
    mainCheckout(checkout);
    const worktree = worktreeOf(checkout);
    const unused = worktreeOf(checkout);
    await writeMcpJson(userFile(), { user: stdioServer('user') });
    const sets = createSets();
    await settled(await sets.acquire());
    await settled(await sets.acquire(worktree));

    const waiting = expect(sets.acquire(unused)).rejects.toThrow('disposed');
    await sets.dispose();

    await waiting;
    expect((await startedProcesses()).map((child) => child.exitCode === null)).toEqual([false, false]);
    for (const dir of [undefined, worktree, unused]) await expect(sets.acquire(dir)).rejects.toThrow('disposed');
  }, PROCESS_TIMEOUT_MS);
});
