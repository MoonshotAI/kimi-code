import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import type { EphemeralEnvironmentConnectRequest } from '#/environment/ephemeralEnvironment';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { describe, expect, it } from 'vitest';

import { RemoteEphemeralEnvironmentConnector } from '#/remote/client/ephemeralEnvironmentConnector';
import type { RemoteEnvironment, RemoteEnvironmentOptions } from '#/remote/client/remoteEnvironment';

function bootstrap(): IBootstrapService {
  return {
    _serviceBrand: undefined,
    clientIdentity: { productName: 'Kimi Code CLI', version: '1.2.3', platform: 'kimi_code_cli' },
  } as unknown as IBootstrapService;
}

function log(): ILogService {
  return {
    _serviceBrand: undefined,
    warn: () => {},
  } as unknown as ILogService;
}

function request(
  registry: EnvironmentRegistry,
  entry: EphemeralEnvironmentConnectRequest['entry'],
  environmentId = 'eph-test',
): EphemeralEnvironmentConnectRequest {
  return { workspaceId: 'workspace', environmentId, entry, registry };
}

function fakeConnected(environmentId: string, homeDir?: string): FakeEnvironment {
  const environment = new FakeEnvironment(
    { workspaceId: 'workspace', environmentId, generation: 'gen-one' },
    {
      status: 'ready',
      capabilities: ['fs', 'process'],
      host: homeDir === undefined ? undefined : { homeDir },
    },
  );
  return Object.assign(environment, { fs: {}, process: {} });
}

describe('RemoteEphemeralEnvironmentConnector', () => {
  it('connects with the converted launcher, registers the environment, and returns the initial cwd', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const calls: RemoteEnvironmentOptions[] = [];
    const connected = fakeConnected('eph-test', '/home/me');
    Object.assign(connected.host, { cwd: '/home/me/work' });
    const connector = new RemoteEphemeralEnvironmentConnector(
      bootstrap(),
      log(),
      async (options) => {
        calls.push(options);
        return connected as unknown as RemoteEnvironment;
      },
    );

    const result = await connector.connect(
      request(registry, { type: 'ssh', host: 'dev-box', remoteBin: '/opt/kimi' }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      workspaceId: 'workspace',
      environmentId: 'eph-test',
      launcher: { type: 'ssh', host: 'dev-box', remoteBin: '/opt/kimi' },
      clientVersion: '1.2.3',
    });
    expect(registry.current('eph-test')).toBe(result.environment);
    expect(result.environment.identity.environmentId).toBe('eph-test');
    expect(result.environment.status).toBe('ready');
    expect(result.initialCwd).toBe('/home/me/work');
  });

  it('reconnects a temporary environment in process without changing its identity', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const calls: RemoteEnvironmentOptions[] = [];
    const connector = new RemoteEphemeralEnvironmentConnector(
      bootstrap(),
      log(),
      async (options) => {
        calls.push(options);
        const connected = fakeConnected(options.environmentId, '/home/me');
        Object.assign(connected.host, { cwd: `/home/me/work-${calls.length}` });
        return connected as unknown as RemoteEnvironment;
      },
    );

    const result = await connector.connect(request(registry, { type: 'ssh', host: 'dev-box' }));
    const generation = result.environment.identity.generation;
    await result.environment.connect?.();

    expect(calls).toHaveLength(2);
    expect(registry.current('eph-test')).toBe(result.environment);
    expect(result.environment.identity.generation).toBe(generation);
    expect(result.environment.host?.cwd).toBe('/home/me/work-2');
  });

  it('maps docker and command entries to launcher specs', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const calls: RemoteEnvironmentOptions[] = [];
    const connector = new RemoteEphemeralEnvironmentConnector(
      bootstrap(),
      log(),
      async (options) => {
        calls.push(options);
        return fakeConnected(options.environmentId) as unknown as RemoteEnvironment;
      },
    );

    await connector.connect(
      request(
        registry,
        { type: 'docker', container: 'app-dev', context: 'orbstack' },
        'eph-docker',
      ),
    );
    await connector.connect(
      request(
        registry,
        { command: 'sandbox', args: ['--mode', 'x'], env: { TOKEN: 't' } },
        'eph-command',
      ),
    );

    expect(calls[0]!.launcher).toEqual({
      type: 'docker',
      container: 'app-dev',
      context: 'orbstack',
      remoteBin: undefined,
    });
    expect(calls[1]!.launcher).toEqual({
      type: 'command',
      program: 'sandbox',
      args: ['--mode', 'x'],
      env: { TOKEN: 't' },
    });
    expect(registry.current('eph-docker')).toBeDefined();
    expect(registry.current('eph-command')).toBeDefined();
  });

  it('rethrows the connect failure and leaves nothing registered', async () => {
    const registry = new EnvironmentRegistry('workspace');
    const connector = new RemoteEphemeralEnvironmentConnector(
      bootstrap(),
      log(),
      async () => {
        throw new Error(
          'executor process exited before the handshake completed (code 255, signal null)',
        );
      },
    );

    await expect(
      connector.connect(request(registry, { type: 'ssh', host: 'dev-box' })),
    ).rejects.toThrow(/code 255/);
    expect(registry.list()).toHaveLength(0);
  });

  it('disposes the connection when the registry rejects the registration', async () => {
    const registry = new EnvironmentRegistry('workspace');
    await registry.dispose();
    const connected = fakeConnected('eph-test');
    let disposed = false;
    Object.assign(connected, {
      dispose: async () => {
        disposed = true;
      },
    });
    const connector = new RemoteEphemeralEnvironmentConnector(
      bootstrap(),
      log(),
      async () => connected as unknown as RemoteEnvironment,
    );

    await expect(
      connector.connect(request(registry, { type: 'ssh', host: 'dev-box' })),
    ).rejects.toThrow(/disposing/);
    expect(disposed).toBe(true);
  });
});
