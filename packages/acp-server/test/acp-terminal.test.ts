import { describe, expect, it } from 'vitest';

import type {
  IHostEnvironment,
  Runtime,
  RuntimeProviderHost,
} from '@moonshot-ai/agent-core-v2';

import type { IAcpConnection } from '../src/acp-fs/acpConnection';
import { AcpHostFileSystem } from '../src/acp-fs/acpFsService';
import { AcpRuntimeProviderFactory } from '../src/acp-terminal/acpTerminalRunner';

function makeConnection(): IAcpConnection {
  return {
    _serviceBrand: undefined,
    bound: true,
    fsReadTextFile: true,
    fsWriteTextFile: true,
    terminalEnabled: true,
    bind: () => {},
    get: () => ({}) as never,
    bindFsCapabilities: () => {},
    bindTerminalCapability: () => {},
    notifyTerminalCreated: () => {},
    onTerminalCreated: () => () => {},
  };
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

async function bindRuntime(environment: IHostEnvironment): Promise<Runtime> {
  const runtimes: Runtime[] = [];
  const host = {
    registerRuntime: (runtime: Runtime) => {
      runtimes.push(runtime);
      return { remove: async () => {} };
    },
  } as unknown as RuntimeProviderHost;
  const factory = new AcpRuntimeProviderFactory(makeConnection(), environment);
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
