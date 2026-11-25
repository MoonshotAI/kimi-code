import { mkdtempSync, realpathSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { dirname, join } from 'pathe';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { Event } from '#/_base/event';
import type { IEnvironmentService } from '#/app/environment/environment';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type { McpConnectionView } from '#/mcpCore/connection-manager';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcess } from '#/os/interface/hostProcess';
import type { ProgramDependencies } from '#/program/programDependencies';
import { ProgramMcp, type ProgramMcpLease } from '#/program/programMcp';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import type { IProjectDirs } from '#/project/projectDirs/projectDirs';
import type { ProjectTrustChange } from '#/project/projectTrust/projectTrust';

import { stubLog } from '../_base/log/stubs';
import { deferredAgentIdentityStub, stubAgentIdentity } from '../app/agentIdentity/stubs';
import { createMemoryMcpOAuthStore, cwdStdioFixture, stdioFixture } from '../mcpCore/stubs';

const PROCESS_TIMEOUT_MS = 20_000;

function stdioServer(config: Partial<McpServerConfig> = {}): McpServerConfig {
  return { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture], ...config } as McpServerConfig;
}

async function cwdOf(view: McpConnectionView, name: string): Promise<string> {
  const result = await view.resolved(name)!.client.callTool('get_cwd', {});
  return realpathSync((result.content[0] as { type: 'text'; text: string }).text);
}

describe('ProgramMcp', () => {
  let homeDir: string;
  let primary: string;
  let trusted: boolean;
  let oauth: McpOAuthService;
  let mcp: ProgramMcp;
  let spawn: MockInstance<HostProcessService['spawn']>;

  beforeEach(() => {
    vi.stubEnv('KIMI_CODE_WATCH', 'false');
    homeDir = tempDir('kimi-program-mcp-home-');
    primary = tempDir('kimi-program-mcp-primary-');
    trusted = true;
    oauth = new McpOAuthService({ store: createMemoryMcpOAuthStore() });
    mcp = createMcp();
    spawn = vi.spyOn(HostProcessService.prototype, 'spawn');
  });

  afterEach(async () => {
    await mcp.dispose();
    await oauth.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([homeDir, primary].map((dir) => rm(dir, { recursive: true, force: true })));
  });

  function tempDir(prefix: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  }

  function createMcp(overrides: Partial<ProgramDependencies> = {}): ProgramMcp {
    const environment = Object.assign(
      new FakeEnvironment({ environmentId: 'local', generation: 'test' }, { capabilities: ['process'] }),
      { process: new HostProcessService() },
    );
    const lease = { environment, track: <T,>(resource: T): T => resource, dispose: () => {} };
    return new ProgramMcp(
      {
        _serviceBrand: undefined,
        inspect: () => environment,
        acquire: () => lease,
        acquireWhenReady: async () => lease,
      } as unknown as IEnvironmentService,
      { workspaceId: 'workspace' } as IProjectContext,
      {
        bootstrap: { homeDir },
        config: { ready: Promise.resolve(), onDidSectionChange: Event.None, get: () => undefined },
        configStore: { onDidWrite: Event.None },
        identity: stubAgentIdentity(),
        log: stubLog(),
        oauth,
        plugins: {
          enabledMcpServers: async () => ({}),
          mcpServerEntries: async () => [],
          onDidReload: Event.None,
        },
        sessionManager: { current: undefined, onDidChange: Event.None },
        telemetry: noopTelemetryService,
        ...overrides,
      } as unknown as ProgramDependencies,
      new HostFileSystem(),
      {
        ready: Promise.resolve(),
        get primary() {
          return primary;
        },
        onDidChange: Event.None,
      } as unknown as IProjectDirs,
      {
        _serviceBrand: undefined,
        ready: Promise.resolve(),
        get: async () => trusted,
        isTrusted: () => trusted,
        trust: async () => undefined,
        untrust: async () => undefined,
        onDidChange: Event.None as Event<ProjectTrustChange>,
      },
    );
  }

  async function writeServers(servers: Record<string, McpServerConfig>): Promise<void> {
    const file = join(primary, '.kimi-code', 'mcp.json');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: servers }), 'utf8');
  }

  async function connected(lease: ProgramMcpLease): Promise<McpConnectionView> {
    await lease.service.ready;
    const view = lease.service.connectionManager();
    expect(view.list().filter((entry) => entry.status !== 'connected')).toEqual([]);
    return view;
  }

  function startedProcesses(): Promise<IHostProcess[]> {
    return Promise.all(spawn.mock.results.map((result) => result.value as Promise<IHostProcess>));
  }

  it('starts the servers for the first holder, shares them with the others, and stops them with the last', async () => {
    await writeServers({ server: stdioServer() });
    const configClosed = vi.spyOn(oauth, 'removeConfigurationSource');
    expect(mcp.servers()).toEqual({});

    const first = await mcp.acquire();
    const second = await mcp.acquire();
    const view = await connected(first);
    expect(second.service).toBe(first.service);
    expect(Object.keys(mcp.servers())).toEqual(['server']);
    expect(spawn).toHaveBeenCalledTimes(1);

    first.dispose();
    first.dispose();
    expect(view.get('server')?.status).toBe('connected');

    second.dispose();
    expect(mcp.servers()).toEqual({});
    const [child] = await startedProcesses();
    await vi.waitFor(() => {
      expect(child!.exitCode).not.toBeNull();
      expect(configClosed).toHaveBeenCalledTimes(1);
    }, PROCESS_TIMEOUT_MS);
    expect(view.list()).toEqual([]);
  }, PROCESS_TIMEOUT_MS);

  it('reads the configuration, primary directory, and trust again each time it starts', async () => {
    await writeServers({ before: stdioServer() });
    trusted = false;
    const untrusted = await mcp.acquire();
    expect((await connected(untrusted)).list()).toEqual([]);
    untrusted.dispose();

    await rm(primary, { recursive: true });
    primary = tempDir('kimi-program-mcp-moved-');
    await writeServers({ after: stdioServer() });
    trusted = true;
    const view = await connected(await mcp.acquire());

    expect(view.list().map((entry) => entry.name)).toEqual(['after']);
    await expect(cwdOf(view, 'after')).resolves.toBe(primary);
  }, PROCESS_TIMEOUT_MS);

  it('starts again, once for everyone waiting, only after the previous servers have exited', async () => {
    await writeServers({
      stubborn: stdioServer({ args: [stdioFixture], env: { KIMI_TEST_MCP_IGNORE_SIGTERM: '1' } }),
    });
    const first = await mcp.acquire();
    await connected(first);
    const [previous] = await startedProcesses();
    const previousExited: boolean[] = [];
    spawn.mockImplementationOnce((command, args, options) => {
      previousExited.push(previous!.exitCode !== null);
      return new HostProcessService().spawn(command, args, options);
    });
    await writeServers({ next: stdioServer() });

    first.dispose();
    const [second, third] = await Promise.all([mcp.acquire(), mcp.acquire()]);

    expect(third.service).toBe(second.service);
    expect((await connected(second)).list().map((entry) => entry.name)).toEqual(['next']);
    expect(previousExited).toEqual([true]);
  }, PROCESS_TIMEOUT_MS);

  it.each([
    ['the agent identity resolves', () => {
      const { identity, freeze } = deferredAgentIdentityStub();
      return { overrides: { identity }, open: freeze };
    }],
    ['the config loads', () => {
      let open: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => {
        open = resolve;
      });
      const config = { ready, onDidSectionChange: Event.None, get: () => undefined };
      return { overrides: { config } as unknown as Partial<ProgramDependencies>, open };
    }],
  ])('starts no server when its last holder leaves before %s', async (_label, gate) => {
    await writeServers({ server: stdioServer() });
    const { overrides, open } = gate();
    const lease = await createMcp(overrides).acquire();

    lease.dispose();
    open();
    await lease.service.ready;

    expect(spawn).not.toHaveBeenCalled();
  });

  it('stops the servers with the program and admits no holder afterwards', async () => {
    await writeServers({ server: stdioServer() });
    const lease = await mcp.acquire();
    await connected(lease);

    await mcp.dispose();

    expect((await startedProcesses()).map((child) => child.exitCode === null)).toEqual([false]);
    lease.dispose();
    await expect(mcp.acquire()).rejects.toThrow('disposed');
  }, PROCESS_TIMEOUT_MS);

  it('turns away a holder still waiting for the previous servers when the program goes away', async () => {
    await writeServers({ server: stdioServer() });
    const lease = await mcp.acquire();
    await connected(lease);

    lease.dispose();
    const waiting = expect(mcp.acquire()).rejects.toThrow('disposed');
    await mcp.dispose();

    await waiting;
    expect(spawn).toHaveBeenCalledTimes(1);
  }, PROCESS_TIMEOUT_MS);
});
