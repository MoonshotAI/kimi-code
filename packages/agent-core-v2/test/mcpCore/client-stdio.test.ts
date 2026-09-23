import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import type { EnvironmentLease, EnvironmentStatus } from '#/environment/environment';
import { EnvironmentError, environmentIsReady } from '#/environment/environmentRegistry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import {
  mergeRemoteStdioEnv,
  mergeStdioEnv,
  StdioMcpClient,
  type StdioMcpClientOptions,
} from '#/mcpCore/client-stdio';
import { McpServerStdioConfigSchema, type McpServerStdioConfig } from '#/mcpCore/config-schema';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcessService } from '#/os/interface/hostProcess';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';

import {
  crashAfterConnectFixture,
  cwdStdioFixture,
  stderrThenExitFixture,
  stdioFixture,
} from './stubs';

function createClient(
  config: McpServerStdioConfig,
  options: Partial<StdioMcpClientOptions> = {},
): StdioMcpClient {
  const environment = Object.assign(
    new FakeEnvironment(
      { environmentId: 'local', generation: 'test' },
      { capabilities: ['process'] },
    ),
    { process: new HostProcessService() },
  );
  return new StdioMcpClient(config, {
    environmentResolver: {
      _serviceBrand: undefined,
      inspect: () => environment,
      acquire: () => ({
        environment,
        track: (resource) => resource,
        dispose: () => {},
      }),
      acquireWhenReady: async () => ({
        environment,
        track: (resource) => resource,
        dispose: () => {},
      }),
    },
    environmentId: 'local',
    defaultCwd: process.cwd(),
    ...options,
  });
}

interface EnvironmentClientHarness {
  readonly client: StdioMcpClient;
  readonly calls: string[];
  readonly spawnEnvs: Array<Record<string, string> | undefined>;
  readonly spawnCwds: Array<string | undefined>;
  readonly connectCalls: () => number;
}

function createEnvironmentClient(
  config: McpServerStdioConfig,
  options: {
    environmentId?: string;
    status?: EnvironmentStatus;
    host?: Partial<FakeEnvironment['host']>;
    defaultCwd?: string;
  } = {},
): EnvironmentClientHarness {
  const environmentId = options.environmentId ?? 'local';
  const calls: string[] = [];
  const spawnEnvs: Array<Record<string, string> | undefined> = [];
  const spawnCwds: Array<string | undefined> = [];
  let connectCalls = 0;
  const hostProcess = new HostProcessService();
  const recordingProcess: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: (command, args, spawnOptions) => {
      spawnEnvs.push(spawnOptions?.env);
      spawnCwds.push(spawnOptions?.cwd);
      return hostProcess.spawn(command, args, spawnOptions);
    },
  };
  const environment = new FakeEnvironment(
    { environmentId, generation: 'test' },
    {
      capabilities: ['process'],
      status: options.status ?? 'ready',
      host: options.host ?? { homeDir: process.cwd() },
    },
  );
  Object.assign(environment, {
    process: recordingProcess,
    connect: async () => {
      connectCalls += 1;
      calls.push('connect');
      environment.setStatus('ready');
    },
  });
  const lease = (): EnvironmentLease => ({
    environment,
    track: (resource) => resource,
    dispose: () => {},
  });
  const unavailable = (): never => {
    throw new EnvironmentError('environment.unavailable', `environment is ${environment.status}`);
  };
  const environmentResolver: EnvironmentResolver = {
    _serviceBrand: undefined,
    inspect: () => {
      calls.push('inspect');
      return environment;
    },
    acquire: () => {
      calls.push('acquire');
      if (!environmentIsReady(environment)) unavailable();
      return lease();
    },
    acquireWhenReady: async () => {
      calls.push('acquireWhenReady');
      if (!environmentIsReady(environment)) unavailable();
      return lease();
    },
  };
  const client = new StdioMcpClient(config, {
    environmentResolver,
    environmentId,
    defaultCwd: options.defaultCwd ?? process.cwd(),
  });
  return { client, calls, spawnEnvs, spawnCwds, connectCalls: () => connectCalls };
}

function isPostCloseTransportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Not connected') ||
    message.includes('Connection closed') ||
    message.includes('transport is not running')
  );
}

describe('StdioMcpClient', () => {
  it('connects a pending environment before spawning the server', async () => {
    const pending = createEnvironmentClient(
      { transport: 'stdio', command: process.execPath, args: [stdioFixture] },
      { environmentId: 'dev-box', status: 'pending' },
    );
    const ready = createEnvironmentClient(
      { transport: 'stdio', command: process.execPath, args: [stdioFixture] },
      { environmentId: 'dev-box', status: 'ready' },
    );
    try {
      await pending.client.connect();
      expect(pending.connectCalls()).toBe(1);
      expect(pending.calls.slice(0, 3)).toEqual(['inspect', 'connect', 'acquireWhenReady']);
      const result = await pending.client.callTool('echo', { text: 'remote hello' });
      expect(result.content).toEqual([{ type: 'text', text: 'remote hello' }]);

      await ready.client.connect();
      expect(ready.connectCalls()).toBe(0);
      expect(ready.calls.slice(0, 2)).toEqual(['inspect', 'acquireWhenReady']);
      const readyResult = await ready.client.callTool('echo', { text: 'hello' });
      expect(readyResult.content).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      await pending.client.close();
      await ready.client.close();
    }
  }, 15000);

  it('sends only the configured env overlay to a non-local environment', async () => {
    const localVar = `KIMI_TEST_LOCAL_${Date.now()}`;
    const remoteVar = `KIMI_TEST_REMOTE_${Date.now()}`;
    process.env[localVar] = 'resolved-locally';
    process.env[remoteVar] = 'stays-local';
    const harness = createEnvironmentClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        env: { KIMI_TEST_LITERAL: 'literal' },
        envVars: [localVar, { name: remoteVar, source: 'remote' }],
      },
      { environmentId: 'dev-box' },
    );
    try {
      await harness.client.connect();
      expect(harness.spawnEnvs).toEqual([{ KIMI_TEST_LITERAL: 'literal', [localVar]: 'resolved-locally' }]);
      const result = await harness.client.callTool('read_env', { name: 'KIMI_TEST_LITERAL' });
      expect(result.content).toEqual([{ type: 'text', text: 'literal' }]);
    } finally {
      delete process.env[localVar];
      delete process.env[remoteVar];
      await harness.client.close();
    }
  }, 15000);

  it('uses defaultCwd when config.cwd is omitted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
      },
      { defaultCwd: cwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(cwd));
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 15000);

  it('prefers explicit config.cwd over defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const configuredCwd = join(defaultCwd, 'configured');
    mkdirSync(configuredCwd);
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: configuredCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(configuredCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('resolves relative config.cwd from defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-relative-cwd-'));
    const configuredCwd = join(defaultCwd, 'tools', 'mcp');
    mkdirSync(configuredCwd, { recursive: true });
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: 'tools/mcp',
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(configuredCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('allows explicit config.cwd outside defaultCwd', async () => {
    const defaultCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-default-cwd-'));
    const outsideCwd = mkdtempSync(join(tmpdir(), 'kimi-mcp-outside-cwd-'));
    const client = createClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [cwdStdioFixture],
        cwd: outsideCwd,
      },
      { defaultCwd },
    );
    try {
      await client.connect();
      const result = await client.callTool('get_cwd', {});
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(realpathSync(text)).toBe(realpathSync(outsideCwd));
    } finally {
      await client.close();
      await rm(defaultCwd, { recursive: true, force: true });
      await rm(outsideCwd, { recursive: true, force: true });
    }
  }, 15000);

  it('roots a remote server at the target environment cwd instead of defaultCwd', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kimi-mcp-remote-cwd-'));
    const remoteCwd = join(base, 'target');
    const remoteHome = join(base, 'remote-home');
    const explicitCwd = join(base, 'explicit');
    const carrierCwd = join(base, 'carrier');
    mkdirSync(remoteCwd);
    mkdirSync(remoteHome);
    mkdirSync(explicitCwd);
    mkdirSync(carrierCwd);
    const cases = [
      { config: {}, host: { homeDir: remoteHome, cwd: remoteCwd }, expected: remoteCwd },
      { config: {}, host: { homeDir: remoteHome }, expected: remoteHome },
      { config: { cwd: explicitCwd }, host: { homeDir: remoteHome, cwd: remoteCwd }, expected: explicitCwd },
    ];
    const harnesses = cases.map(({ config, host }) =>
      createEnvironmentClient(
        { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture], ...config },
        { environmentId: 'dev-box', host, defaultCwd: carrierCwd },
      ),
    );
    try {
      for (const [index, harness] of harnesses.entries()) {
        await harness.client.connect();
        const result = await harness.client.callTool('get_cwd', {});
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(realpathSync(text)).toBe(realpathSync(cases[index]!.expected));
        expect(harness.spawnCwds).toEqual([cases[index]!.expected]);
      }
    } finally {
      for (const harness of harnesses) await harness.client.close();
      await rm(base, { recursive: true, force: true });
    }
  }, 15000);

  it('connects, lists tools, and round-trips a text result', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name).toSorted()).toEqual(['boom', 'echo', 'read_env', 'whoami']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toBe('Echoes input text');
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });

      const result = await client.callTool('echo', { text: 'hello mcp' });
      expect(result.isError).toBe(false);
      expect(result.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('propagates server-reported isError', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      const result = await client.callTool('boom', {});
      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual({ type: 'text', text: 'boom!' });
    } finally {
      await client.close();
    }
  }, 15000);

  it('forwards configured env to the spawned server', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { KIMI_TEST_ENV: 'forwarded-value' },
    });
    try {
      await client.connect();
      const result = await client.callTool('read_env', { name: 'KIMI_TEST_ENV' });
      expect(result.content).toEqual([{ type: 'text', text: 'forwarded-value' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('inherits parent process env so PATH/HOME survive; config.env overrides on conflict', async () => {
    const parentOnly = `KIMI_TEST_PARENT_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const shared = `KIMI_TEST_SHARED_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    process.env[parentOnly] = 'from-parent';
    process.env[shared] = 'from-parent';
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
      env: { [shared]: 'from-config' },
    });
    try {
      await client.connect();
      const inherited = await client.callTool('read_env', { name: parentOnly });
      expect(inherited.content).toEqual([{ type: 'text', text: 'from-parent' }]);
      const overridden = await client.callTool('read_env', { name: shared });
      expect(overridden.content).toEqual([{ type: 'text', text: 'from-config' }]);
    } finally {
      delete process.env[parentOnly];
      delete process.env[shared];
      await client.close();
    }
  }, 15000);

  it('captures recent stderr into a snapshot the manager can attach to errors', async () => {
    const banner = `kimi-test-stderr-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stderrThenExitFixture],
      env: { KIMI_TEST_MCP_STDERR: banner },
    });
    try {
      await expect(client.connect()).rejects.toThrow();
      expect(client.stderrSnapshot()).toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('keeps the stderr buffer bounded so noisy servers cannot exhaust memory', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    try {
      await client.connect();
      expect(StdioMcpClient.stderrBufferCapacity).toBeLessThanOrEqual(16 * 1024);
      expect(StdioMcpClient.stderrBufferCapacity).toBeGreaterThanOrEqual(1024);
    } finally {
      await client.close();
    }
  }, 15000);

  it('notifies an unexpected-close listener when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '50', KIMI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ stderr?: string; error?: string }> = [];
    client.onUnexpectedClose((reason) => {
      closes.push({ stderr: reason.stderr, error: reason.error?.message });
    });
    try {
      await client.connect();
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.stderr ?? '').toContain(banner);
    } finally {
      await client.close();
    }
  }, 15000);

  it('buffers an early close and replays it on listener registration', async () => {
    const banner = `kimi-test-early-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_STDERR: banner, KIMI_TEST_MCP_EXIT_CODE: '0' },
    });
    try {
      await client.connect();
      const reply = await client.callTool('exit_after_reply', {});
      expect(reply.isError).toBe(false);
      const exitDeadline = Date.now() + 5000;
      while (Date.now() < exitDeadline && !client.stderrSnapshot().includes(banner)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(client.stderrSnapshot()).toContain(banner);

      const drainDeadline = Date.now() + 5000;
      let transportConfirmedDead = false;
      while (Date.now() < drainDeadline) {
        try {
          await client.callTool('echo', { text: 'probe' });
        } catch (error) {
          if (isPostCloseTransportError(error)) {
            transportConfirmedDead = true;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(transportConfirmedDead).toBe(true);

      let received: { stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onUnexpectedClose((reason) => {
        syncedOnRegister = true;
        received = { stderr: reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received).toBeDefined();
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire unexpected-close when the caller closes the client itself', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    const closes: number[] = [];
    client.onUnexpectedClose(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);

  function createTrackingClient(
    config: McpServerStdioConfig,
  ): { client: StdioMcpClient; tracked: Array<{ sessionId?: string; disposed: boolean }> } {
    const tracked: Array<{ sessionId?: string; disposed: boolean }> = [];
    const environment = Object.assign(
      new FakeEnvironment(
        { environmentId: 'local', generation: 'test' },
        { capabilities: ['process'] },
      ),
      { process: new HostProcessService() },
    );
    const track = <T extends { dispose(): void | Promise<void> }>(
      resource: T,
      sessionId?: string,
    ): T => {
      const entry = { sessionId, disposed: false };
      tracked.push(entry);
      return new Proxy(resource, {
        get: (target, property) => {
          if (property === 'dispose') {
            return () => {
              if (entry.disposed) return undefined;
              entry.disposed = true;
              return target.dispose();
            };
          }
          return Reflect.get(target, property, target);
        },
      });
    };
    const client = new StdioMcpClient(config, {
      environmentResolver: {
        _serviceBrand: undefined,
        inspect: () => environment,
        acquire: () => ({ environment, track, dispose: () => {} }),
        acquireWhenReady: async () => ({ environment, track, dispose: () => {} }),
      },
      environmentId: 'local',
      defaultCwd: process.cwd(),
      sessionId: 's1',
    });
    return { client, tracked };
  }

  it('disposes tracked environment resources on close', async () => {
    const { client, tracked } = createTrackingClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    await client.connect();
    expect(tracked).toHaveLength(2);
    expect(tracked.every((entry) => entry.sessionId === 's1')).toBe(true);

    await client.close();

    expect(tracked.every((entry) => entry.disposed)).toBe(true);
  }, 15000);

  it('disposes tracked environment resources when the server exits mid-session', async () => {
    const { client, tracked } = createTrackingClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '50' },
    });
    try {
      await client.connect();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !tracked.every((entry) => entry.disposed)) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(tracked).toHaveLength(2);
      expect(tracked.every((entry) => entry.disposed)).toBe(true);
    } finally {
      await client.close();
    }
  }, 15000);
});

describe('mergeStdioEnv', () => {
  it('enables NODE_USE_ENV_PROXY for a proxy set only in the server config.env', () => {
    const merged = mergeStdioEnv({ HTTP_PROXY: 'http://corp:3128' }, { PATH: '/usr/bin' });
    expect(merged['HTTP_PROXY']).toBe('http://corp:3128');
    expect(merged['NODE_USE_ENV_PROXY']).toBe('1');
    expect(merged['NO_PROXY']).toBe('localhost,127.0.0.1,::1,[::1]');
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('does not inject NODE_USE_ENV_PROXY when no proxy is configured', () => {
    const merged = mergeStdioEnv(undefined, { PATH: '/usr/bin' });
    expect(merged['NODE_USE_ENV_PROXY']).toBeUndefined();
    expect(merged['PATH']).toBe('/usr/bin');
  });

  it('lets config.env override the parent env', () => {
    const merged = mergeStdioEnv({ FOO: 'override' }, { FOO: 'parent', PATH: '/x' });
    expect(merged['FOO']).toBe('override');
  });

  it('does not depend on a filesystem cwd fixture for env merging', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-mcp-env-'));
    await rm(dir, { recursive: true, force: true });
    expect(mergeStdioEnv(undefined, { PATH: dir })['PATH']).toBe(dir);
  });
});

describe('mergeRemoteStdioEnv', () => {
  it('sends only literal env plus source=local values resolved from the parent env', () => {
    const merged = mergeRemoteStdioEnv(
      {
        env: { LITERAL: 'literal' },
        envVars: ['INHERIT', { name: 'ALSO_INHERIT' }, { name: 'SKIP', source: 'remote' }],
      },
      { INHERIT: 'a', ALSO_INHERIT: 'b', SKIP: 'c', PATH: '/usr/bin', HOME: '/home/x' },
    );
    expect(merged).toEqual({ INHERIT: 'a', ALSO_INHERIT: 'b', LITERAL: 'literal' });
  });

  it('lets literal env override an envVars-resolved value', () => {
    const merged = mergeRemoteStdioEnv({ env: { A: 'literal' }, envVars: ['A'] }, { A: 'parent' });
    expect(merged['A']).toBe('literal');
  });

  it('omits unnamed parent variables and never injects proxy variables', () => {
    const merged = mergeRemoteStdioEnv({}, { HTTP_PROXY: 'http://corp:3128', PATH: '/x' });
    expect(merged).toEqual({});
  });

  it('skips envVars entries missing from the parent env', () => {
    expect(mergeRemoteStdioEnv({ envVars: ['MISSING'] }, {})).toEqual({});
  });
});

describe('McpServerStdioConfigSchema envVars', () => {
  it('accepts string and object entries, with source defaulting to local', () => {
    const parsed = McpServerStdioConfigSchema.parse({
      transport: 'stdio',
      command: 'x',
      envVars: ['A', { name: 'B' }, { name: 'C', source: 'remote' }],
    });
    expect(parsed.envVars).toEqual(['A', { name: 'B' }, { name: 'C', source: 'remote' }]);
  });

  it('rejects invalid envVars entries', () => {
    expect(() =>
      McpServerStdioConfigSchema.parse({
        transport: 'stdio',
        command: 'x',
        envVars: [{ name: 'A', source: 'elsewhere' }],
      }),
    ).toThrow();
    expect(() =>
      McpServerStdioConfigSchema.parse({
        transport: 'stdio',
        command: 'x',
        envVars: [{ source: 'local' }],
      }),
    ).toThrow();
  });
});
