import { describe, expect, it } from 'vitest';

import type {
  HostProcessOptions,
  IHostEnvironment,
  IHostProcess,
  IHostProcessService,
  Runtime,
  RuntimeProviderHost,
} from '@moonshot-ai/agent-core-v2';

import type { IAcpConnection, IAcpTerminalHandle } from '../src/acp-fs/acpConnection';
import { AcpHostFileSystem } from '../src/acp-fs/acpFsService';
import { AcpRuntimeProviderFactory } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(
  options: { terminalEnabled?: boolean; createTerminal?: () => IAcpTerminalHandle } = {},
): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: options.terminalEnabled ?? true,
    bind: () => {},
    get: () => ({ createTerminal: async () => options.createTerminal?.() }) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
}

interface LocalSpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: HostProcessOptions | undefined;
}

function makeLocalProcessService(): { local: IHostProcessService; calls: LocalSpawnCall[] } {
  const calls: LocalSpawnCall[] = [];
  const local: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (command, args = [], options) => {
      calls.push({ command, args, options });
      return {} as IHostProcess;
    },
  };
  return { local, calls };
}

function makeEnvironment(overrides: Partial<IHostEnvironment> = {}): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'macOS',
    osArch: 'arm64',
    osVersion: '24.0.0',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir: '/Users/test',
    ready: Promise.resolve(),
    ...overrides,
  } as IHostEnvironment;
}

async function bindRuntime(
  environment: IHostEnvironment,
  options: { connection?: IAcpConnection; local?: IHostProcessService } = {},
): Promise<Runtime> {
  const runtimes: Runtime[] = [];
  const host = {
    registerRuntime: (runtime: Runtime) => {
      runtimes.push(runtime);
      return { remove: async () => {} };
    },
  } as unknown as RuntimeProviderHost;
  const factory = new AcpRuntimeProviderFactory(
    options.connection ?? makeConnection(),
    environment,
    options.local ?? makeLocalProcessService().local,
  );
  await factory.attach({ id: 'w1' } as never, host);
  factory.bindSession('w1', 's1', '/repo');
  const runtime = runtimes[0];
  if (runtime === undefined) throw new Error('runtime was not registered');
  return runtime;
}

describe('AcpSessionRuntime', () => {
  it('mirrors the probed host environment and exposes fs + process capabilities', async () => {
    const runtime = await bindRuntime(makeEnvironment());

    expect([...runtime.capabilities].sort()).toEqual(['fs', 'process']);
    expect(runtime.environment).toMatchObject({
      osKind: 'macOS',
      osArch: 'arm64',
      shellName: 'bash',
      shellPath: '/bin/bash',
      pathClass: 'posix',
      homeDir: '/Users/test',
    });
    expect(runtime.fs).toBeInstanceOf(AcpHostFileSystem);
    expect(runtime.path.isAbsolute('/repo')).toBe(true);
  });

  it('adapts path semantics and shell to a win32 host environment', async () => {
    const runtime = await bindRuntime(
      makeEnvironment({
        osKind: 'Windows',
        osArch: 'x64',
        shellName: 'bash',
        shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
        pathClass: 'win32',
        homeDir: 'C:\\Users\\test',
      }),
    );

    expect(runtime.environment).toMatchObject({
      osKind: 'Windows',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      pathClass: 'win32',
      homeDir: 'C:\\Users\\test',
    });
    expect(runtime.path.separator).toBe('\\');
    expect(runtime.path.isAbsolute('C:\\repo')).toBe(true);
    expect(runtime.path.isAbsolute('repo')).toBe(false);
    expect(runtime.path.resolve('C:\\repo', 'src')).toBe('C:\\repo\\src');
  });
});

describe('AcpProcessService local fallback', () => {
  const bashEnv = { NO_COLOR: '1', TERM: 'dumb' };

  function makeTerminalHandle(): IAcpTerminalHandle {
    return {
      id: 'term-1',
      currentOutput: async () => ({ output: '', truncated: false }),
      waitForExit: async () => ({ exitCode: 0 }),
      kill: async () => ({}),
      release: async () => ({}),
    };
  }

  it('runs Bash-shaped spawns in the client terminal when the capability is advertised', async () => {
    let created = 0;
    const connection = makeConnection({
      terminalEnabled: true,
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const { local, calls } = makeLocalProcessService();
    const runtime = await bindRuntime(makeEnvironment(), { connection, local });

    await runtime.process!.spawn('/bin/bash', ['-c', 'echo hi'], { env: { ...bashEnv } });

    expect(created).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('falls back to local execution for Bash-shaped spawns without the terminal capability', async () => {
    const connection = makeConnection({ terminalEnabled: false });
    const { local, calls } = makeLocalProcessService();
    const runtime = await bindRuntime(makeEnvironment(), { connection, local });

    await runtime.process!.spawn('/bin/bash', ['-c', 'echo hi'], { env: { ...bashEnv } });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: '/bin/bash',
      args: ['-c', 'echo hi'],
      options: { env: bashEnv, cwd: '/repo' },
    });
  });

  it('falls back to local execution for non-Bash spawns even with the terminal capability', async () => {
    let created = 0;
    const connection = makeConnection({
      terminalEnabled: true,
      createTerminal: () => {
        created += 1;
        return makeTerminalHandle();
      },
    });
    const { local, calls } = makeLocalProcessService();
    const runtime = await bindRuntime(makeEnvironment(), { connection, local });

    await runtime.process!.spawn('rg', ['--files', '--hidden']);

    expect(created).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'rg', args: ['--files', '--hidden'], options: { cwd: '/repo' } });
  });
});
