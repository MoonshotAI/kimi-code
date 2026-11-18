import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';

import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { HostEnvironmentInfo } from '#/_base/execEnv/environmentProbe';
import {
  mergeStdioEnv,
  StdioMcpClient,
  type StdioMcpClientOptions,
} from '#/mcpCore/client-stdio';
import { McpClassifiedStartupError } from '#/mcpCore/client-shared';
import type { McpServerStdioConfig } from '#/mcpCore/config-schema';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';

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
  return new StdioMcpClient(config, {
    processService: new HostProcessService(),
    environment: localEnvironment(),
    defaultCwd: process.cwd(),
    ...options,
  });
}

function localEnvironment(overrides: Partial<HostEnvironmentInfo> = {}): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: overrides.osKind ?? 'Linux',
    osArch: overrides.osArch ?? 'x64',
    osVersion: overrides.osVersion ?? '',
    shellName: overrides.shellName ?? 'bash',
    shellPath: overrides.shellPath ?? '/bin/bash',
    pathClass: overrides.pathClass ?? 'posix',
    homeDir: overrides.homeDir ?? process.cwd(),
    ready: Promise.resolve(),
  };
}

interface EnvironmentClientHarness {
  readonly client: StdioMcpClient;
  readonly calls: string[];
  readonly spawnEnvs: Array<Record<string, string> | undefined>;
  readonly spawnCwds: Array<string | undefined>;
}

function createEnvironmentClient(
  config: McpServerStdioConfig,
  options: {
    host?: Partial<HostEnvironmentInfo>;
    defaultCwd?: string;
  } = {},
): EnvironmentClientHarness {
  const calls: string[] = [];
  const spawnEnvs: Array<Record<string, string> | undefined> = [];
  const spawnCwds: Array<string | undefined> = [];
  const hostProcess = new HostProcessService();
  const recordingProcess: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: (command, args, spawnOptions) => {
      spawnEnvs.push(spawnOptions?.env);
      spawnCwds.push(spawnOptions?.cwd);
      return hostProcess.spawn(command, args, spawnOptions);
    },
  };
  const client = new StdioMcpClient(config, {
    processService: recordingProcess,
    environment: localEnvironment(options.host),
    defaultCwd: options.defaultCwd ?? process.cwd(),
  });
  return { client, calls, spawnEnvs, spawnCwds };
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
  it('rejects a removed executor value instead of silently running on local', async () => {
    const client = createClient({ transport: 'stdio', command: process.execPath, executor: 'kaos' });
    await expect(client.connect()).rejects.toThrowError(
      expect.objectContaining({ code: 'not_implemented' }),
    );
  });

  it('accepts executor local for backward compatibility', async () => {
    const client = createClient({ transport: 'stdio', command: process.execPath, args: [stdioFixture], executor: 'local' });
    try {
      await client.connect();
      const result = await client.callTool('echo', { text: 'hello' });
      expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
    } finally {
      await client.close();
    }
  }, 15000);

  it('sends the merged local env to the child process', async () => {
    const harness = createEnvironmentClient(
      {
        transport: 'stdio',
        command: process.execPath,
        args: [stdioFixture],
        env: { KIMI_TEST_LITERAL: 'literal' },
      },

    );
    try {
      await harness.client.connect();
      expect(harness.spawnEnvs).toEqual([expect.objectContaining({ KIMI_TEST_LITERAL: 'literal' })]);
      const result = await harness.client.callTool('read_env', { name: 'KIMI_TEST_LITERAL' });
      expect(result.content).toEqual([{ type: 'text', text: 'literal' }]);
    } finally {
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

  it('uses defaultCwd and falls back to the host home directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'kimi-mcp-local-cwd-'));
    const remoteHome = join(base, 'remote-home');
    const explicitCwd = join(base, 'explicit');
    const carrierCwd = join(base, 'carrier');
    mkdirSync(remoteHome);
    mkdirSync(explicitCwd);
    mkdirSync(carrierCwd);
    const cases = [
      { config: {}, host: { homeDir: remoteHome }, expected: carrierCwd },
      { config: { cwd: explicitCwd }, host: { homeDir: remoteHome }, expected: explicitCwd },
    ];
    const harnesses = cases.map(({ config, host }) =>
      createEnvironmentClient(
        { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture], ...config },
        { host, defaultCwd: carrierCwd },
      ),
    );
    const homeClient = new StdioMcpClient(
      { transport: 'stdio', command: process.execPath, args: [cwdStdioFixture] },
      { processService: new HostProcessService(), environment: localEnvironment({ homeDir: remoteHome }) },
    );
    try {
      for (const [index, harness] of harnesses.entries()) {
        await harness.client.connect();
        const result = await harness.client.callTool('get_cwd', {});
        const text = (result.content[0] as { type: 'text'; text: string }).text;
        expect(realpathSync(text)).toBe(realpathSync(cases[index]!.expected));
        expect(harness.spawnCwds).toEqual([cases[index]!.expected]);
      }
      await homeClient.connect();
      const result = await homeClient.callTool('get_cwd', {});
      expect(realpathSync((result.content[0] as { type: 'text'; text: string }).text)).toBe(realpathSync(remoteHome));
    } finally {
      for (const harness of harnesses) await harness.client.close();
      await homeClient.close();
      await rm(base, { recursive: true, force: true });
    }
  }, 15000);

  it('tracks child process and transport resources with the session id', async () => {
    const tracked: Array<string | undefined> = [];
    const client = createClient(
      { transport: 'stdio', command: process.execPath, args: [stdioFixture] },
      {
        sessionId: 'session-1',
        track: (_resource, sessionId) => {
          tracked.push(sessionId);
          return _resource;
        },
      },
    );
    try {
      await client.connect();
      expect(tracked).toEqual(['session-1', 'session-1']);
    } finally {
      await client.close();
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

  it('notifies a session-evidence listener with hard evidence when the child exits after connect', async () => {
    const banner = `kimi-test-crash-${Date.now()}`;
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [crashAfterConnectFixture],
      env: { KIMI_TEST_MCP_EXIT_AFTER_MS: '50', KIMI_TEST_MCP_STDERR: banner },
    });
    const closes: Array<{ kind?: string; stderr?: string; error?: string }> = [];
    client.onSessionEvidence((evidence) => {
      closes.push({
        kind: evidence.kind,
        stderr: evidence.reason.stderr,
        error: evidence.reason.error?.message,
      });
    });
    try {
      await client.connect();
      for (let i = 0; i < 100; i++) {
        if (closes.length > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(closes).toHaveLength(1);
      expect(closes[0]?.kind).toBe('hard');
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

      let received: { kind?: string; stderr?: string } | undefined;
      let syncedOnRegister = false;
      client.onSessionEvidence((evidence) => {
        syncedOnRegister = true;
        received = { kind: evidence.kind, stderr: evidence.reason.stderr };
      });
      expect(syncedOnRegister).toBe(true);
      expect(received).toBeDefined();
      expect(received?.kind).toBe('hard');
    } finally {
      await client.close();
    }
  }, 15000);

  it('does not fire session evidence when the caller closes the client itself', async () => {
    const client = createClient({
      transport: 'stdio',
      command: process.execPath,
      args: [stdioFixture],
    });
    const closes: number[] = [];
    client.onSessionEvidence(() => closes.push(Date.now()));
    await client.connect();
    await client.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(closes).toEqual([]);
  }, 15000);

  it('classifies a process-level ENOENT during startup as a config error', async () => {
    const fakeProc: IHostProcess = {
      _serviceBrand: undefined,
      pid: 4242,
      exitCode: 1,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      wait: () => Promise.reject(Object.assign(new Error('spawn definitely-missing ENOENT'), { code: 'ENOENT' })),
      kill: async () => {},
      dispose: () => {},
    };
    const processService: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: () => Promise.resolve(fakeProc),
    };
    const client = new StdioMcpClient(
      { transport: 'stdio', command: 'definitely-missing', args: [] },
      {
        processService,
        environment: localEnvironment(),
        defaultCwd: process.cwd(),
      },
    );
    await expect(client.connect()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(McpClassifiedStartupError);
      expect((err as McpClassifiedStartupError).failureKind).toBe('config');
      return true;
    });
  });

  it('does not hang when the process outlives its closed stdout', async () => {
    const stdout = new PassThrough();
    stdout.end();
    const fakeProc: IHostProcess = {
      _serviceBrand: undefined,
      pid: 4242,
      exitCode: null,
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      wait: () => new Promise<number>(() => {}),
      kill: async () => {},
      dispose: () => {},
    };
    const processService: IHostProcessService = {
      _serviceBrand: undefined,
      spawn: () => Promise.resolve(fakeProc),
    };
    const client = new StdioMcpClient(
      { transport: 'stdio', command: 'fake', args: [] },
      {
        processService,
        environment: localEnvironment(),
        defaultCwd: process.cwd(),
      },
    );
    await expect(client.connect()).rejects.toThrow(/Connection closed/);
  }, 10000);
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
