import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { IEnvironmentDeclarationService } from '@moonshot-ai/agent-core-v2/app/environmentDeclaration/environmentDeclaration';
import { IConfigService, type ConfigSectionChangedEvent } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import type { Environment } from '@moonshot-ai/agent-core-v2/environment/environment';
import { EnvironmentError, EnvironmentRegistry } from '@moonshot-ai/agent-core-v2/environment/environmentRegistry';
import type {
  EnvironmentProviderContext,
  EnvironmentProviderHost,
} from '@moonshot-ai/agent-core-v2/environment/environmentProvider';

import { HandshakeError } from '../src/client/connection';
import { RemoteEphemeralEnvironmentConnector } from '../src/client/ephemeralEnvironmentConnector';
import type { LocalRunner, LocalRunRequest } from '../src/client/executorDetect';
import {
  RemoteConnectionPool,
  RemoteConnectionPoolStaleError,
  type RemoteConnectionPoolHolder,
} from '../src/client/remoteConnectionPool';
import {
  RemoteEnvironmentProviderFactory,
  type RemoteEnvironmentProviderFactoryOptions,
} from '../src/client/remoteEnvironmentProvider';
import type { RemoteEnvironment, RemoteEnvironmentOptions } from '../src/client/remoteEnvironment';

function configService(section: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'environments' ? section : undefined),
    onDidSectionChange: () => ({ dispose: () => {} }),
  } as unknown as IConfigService;
}

interface WatchableConfigService {
  readonly service: IConfigService;
  setSection(section: unknown): void;
}

function watchableConfigService(initial: unknown): WatchableConfigService {
  const emitter = new Emitter<ConfigSectionChangedEvent>();
  let section = initial;
  return {
    service: {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) => (domain === 'environments' ? section : undefined),
      onDidSectionChange: emitter.event,
    } as unknown as IConfigService,
    setSection(next: unknown) {
      const previousValue = section;
      section = next;
      emitter.fire({ domain: 'environments', source: 'set', value: next, previousValue });
    },
  };
}

function fsService(files: Readonly<Record<string, string>>): IHostFileSystem {
  return {
    _serviceBrand: undefined,
    readText: async (path: string) => {
      const text = files[path];
      if (text === undefined) {
        throw new HostFsError(OsFsErrors.codes.OS_FS_NOT_FOUND, `not found: ${path}`);
      }
      return text;
    },
  } as unknown as IHostFileSystem;
}

function docsService(): IAtomicDocumentStore & { readonly records: Map<string, unknown> } {
  const records = new Map<string, unknown>();
  return {
    _serviceBrand: undefined,
    records,
    get: async <T,>(scope: string, key: string) => records.get(`${scope}/${key}`) as T | undefined,
    set: async <T,>(scope: string, key: string, value: T) => {
      records.set(`${scope}/${key}`, value);
    },
    delete: async (scope: string, key: string) => {
      records.delete(`${scope}/${key}`);
    },
  } as unknown as IAtomicDocumentStore & { readonly records: Map<string, unknown> };
}

const NOOP_LOG = {
  _serviceBrand: undefined,
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as ILogService;

const NO_ABORT = new AbortController().signal;

const CONTEXT: EnvironmentProviderContext = {
  id: 'workspace-1',
  root: '/repo',
};

interface HostServices {
  readonly config: IConfigService;
  readonly fs: IHostFileSystem;
  readonly docs: IAtomicDocumentStore;
  readonly log: ILogService;
}

function fakeHost(services: HostServices, registry: EnvironmentRegistry): EnvironmentProviderHost {
  return {
    get: (id: unknown) => {
      if (id === IConfigService) return services.config;
      if (id === IHostFileSystem) return services.fs;
      if (id === IAtomicDocumentStore) return services.docs;
      if (id === ILogService) return services.log;
      if (id === IEnvironmentDeclarationService) return { registerReconciler: () => ({ dispose: () => {} }) };
      throw new Error('unexpected service');
    },
    provide: () => {
      throw new Error('not used');
    },
    registerEnvironment: (environment: Environment) => {
      const registration = registry.register(environment);
      return {
        environmentId: environment.identity.environmentId,
        update: async (prepare: () => Environment | Promise<Environment>) => {
          await registration.replace(await prepare());
        },
        remove: () => registration.remove(),
      };
    },
  } as unknown as EnvironmentProviderHost;
}

function connectedEnvironment(options: RemoteEnvironmentOptions, generation: string): RemoteEnvironment {
  const environment = new FakeEnvironment(
    { workspaceId: options.workspaceId, environmentId: options.environmentId, generation },
    { capabilities: ['fs', 'process'] },
  );
  return Object.assign(environment, { fs: {}, process: {} }) as unknown as RemoteEnvironment;
}

function closingEnvironment(options: RemoteEnvironmentOptions, generation: string, reason: string): RemoteEnvironment {
  const environment = connectedEnvironment(options, generation) as unknown as FakeEnvironment & {
    connection: { closeReason?: { reason: string } };
  };
  environment.connection = { closeReason: { reason } };
  return environment as unknown as RemoteEnvironment;
}

function baseServices(overrides: Partial<HostServices> = {}): HostServices {
  return {
    config: configService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    }),
    fs: fsService({}),
    docs: docsService(),
    log: NOOP_LOG,
    ...overrides,
  };
}

function factoryOptions(extra: RemoteEnvironmentProviderFactoryOptions = {}): RemoteEnvironmentProviderFactoryOptions {
  return { ...extra };
}

describe('RemoteEnvironmentProviderFactory', () => {
  it('registers declared environments as pending placeholders without connecting', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const registered = registry.current('dev-box');
    expect(registered).toBeDefined();
    expect(registered!.status).toBe('pending');
    expect(registered!.connectError).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(() => registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('connects on explicit connect without replacing the registered environment', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    const generation = placeholder.identity.generation;
    await placeholder.connect!();

    expect(connect).toHaveBeenCalledTimes(1);
    const connected = registry.current('dev-box')!;
    expect(connected).toBe(placeholder);
    expect(connected.status).toBe('ready');
    expect(connected.identity.generation).toBe(generation);
    const lease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(lease.environment).toBe(connected);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('marks the placeholder connecting while a connect is in flight and dedupes concurrent connects', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      await gate;
      return connectedEnvironment(options, 'connected-1');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    const statuses: string[] = [];
    placeholder.onDidChangeStatus((status) => {
      statuses.push(status);
    });
    const first = placeholder.connect!();
    const second = placeholder.connect!();
    expect(second).toBe(first);
    expect(placeholder.status).toBe('connecting');
    expect(placeholder.whenReady).toBe(first);
    // The launcher resolution ahead of the connect is async, so the underlying
    // connect starts a microtask later rather than synchronously.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(1);

    releaseConnect();
    await first;
    expect(placeholder.whenReady).toBeUndefined();
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('ready');
    expect(statuses[0]).toBe('connecting');

    await attachment.dispose();
    await registry.dispose();
  });

  it('records the connect error on the placeholder and restores the immediate acquire error once settled', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const failure = new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
    const connect = vi.fn(async () => {
      throw failure;
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await expect(placeholder.connect!()).rejects.toBe(failure);
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(placeholder.status).toBe('disconnected');
    expect(placeholder.whenReady).toBeUndefined();
    expect(placeholder.connectError).toContain('code 255');
    expect(registry.snapshot().environments[0]).toMatchObject({
      environmentId: 'dev-box',
      status: 'disconnected',
      connectError: expect.stringContaining('code 255'),
    });
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).rejects.toThrow('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('awaits the in-flight connect on acquireWhenReady and leases the connected environment', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      await gate;
      return connectedEnvironment(options, 'connected-1');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    void placeholder.connect!();
    let settled = false;
    const pending = registry.acquireWhenReady({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']).then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseConnect();
    const lease = await pending;
    expect(lease.environment.status).toBe('ready');
    expect(lease.environment).toBe(placeholder);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('awaits an in-flight reconnect on a connected view and leases the swapped environment', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let generation = 0;
    let releaseReconnect!: () => void;
    const reconnectGate = new Promise<void>((resolve) => {
      releaseReconnect = resolve;
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      generation += 1;
      const current = generation;
      if (current === 2) await reconnectGate;
      return closingEnvironment(options, `connected-${current}`, 'control call fs/read timed out after 60000ms; closing the connection');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const managed = registry.current('dev-box')!;
    expect(managed.status).toBe('ready');

    const firstInner = connect.mock.results[0]!.value as unknown as Promise<FakeEnvironment>;
    (await firstInner).setStatus('disconnected');
    expect(managed.status).toBe('disconnected');

    const reconnect = managed.connect!();
    expect(managed.status).toBe('connecting');
    expect(managed.whenReady).toBe(reconnect);
    expect(managed.connectError).toBeUndefined();

    let settled: 'pending' | 'acquired' | 'failed' = 'pending';
    const pending = registry.acquireWhenReady({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']).then(
      (lease) => {
        settled = 'acquired';
        return lease;
      },
      (error: unknown) => {
        settled = 'failed';
        throw error;
      },
    );
    await Promise.resolve();
    expect(settled).toBe('pending');

    releaseReconnect();
    const lease = await pending;
    await reconnect;
    expect(settled).toBe('acquired');
    expect(lease.environment.status).toBe('ready');
    expect(lease.environment).toBe(managed);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('records the failure and clears whenReady when a connected-view reconnect fails', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const failure = new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect to host dev-box port 22: Connection refused');
    let generation = 0;
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      generation += 1;
      if (generation === 2) throw failure;
      return closingEnvironment(options, `connected-${generation}`, 'control call fs/read timed out after 60000ms; closing the connection');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const managed = registry.current('dev-box')!;
    expect(managed.status).toBe('ready');

    // A healthy reconnect forces a pool-level replacement; this test targets
    // the rebuild-after-drop path, so the pooled connection drops first.
    const firstInner = connect.mock.results[0]!.value as unknown as Promise<FakeEnvironment>;
    (await firstInner).setStatus('disconnected');
    expect(managed.status).toBe('disconnected');

    await expect(managed.connect!()).rejects.toBe(failure);
    expect(registry.current('dev-box')).toBe(managed);
    expect(managed.status).toBe('disconnected');
    expect(managed.whenReady).toBeUndefined();
    expect(managed.connectError).toContain('Connection refused');
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).rejects.toThrow('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('replaces the pooled connection on a healthy reconnect and drains the old view', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let generation = 0;
    const produced: FakeEnvironment[] = [];
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      generation += 1;
      const environment = connectedEnvironment(options, `connected-${generation}`);
      produced.push(environment as unknown as FakeEnvironment);
      return environment;
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const first = registry.current('dev-box')!;
    const oldLease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(oldLease.environment).toBe(first);

    // A healthy reconnect no longer reuses the pooled connection: the pool
    // invalidates it, builds a replacement, and the view swaps to a fresh
    // generation.
    await first.connect!();
    const second = registry.current('dev-box')!;
    expect(second).toBe(first);
    expect(connect).toHaveBeenCalledTimes(2);

    expect(oldLease.environment).toBe(first);
    await vi.waitFor(() => {
      expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    });

    const newLease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(newLease.environment).toBe(second);
    newLease.dispose();
    oldLease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('records the connection close reason when a connected environment drops mid-session', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) =>
      closingEnvironment(options, 'connected-1', 'control call fs/read timed out after 60000ms; closing the connection'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const managed = registry.current('dev-box')!;
    expect(managed.status).toBe('ready');
    expect(managed.connectError).toBeUndefined();

    const inner = connect.mock.results[0]!.value as unknown as Promise<FakeEnvironment>;
    (await inner).setStatus('disconnected');

    expect(managed.status).toBe('disconnected');
    expect(managed.connectError).toBe('control call fs/read timed out after 60000ms; closing the connection');
    expect(registry.snapshot().environments[0]).toMatchObject({
      environmentId: 'dev-box',
      status: 'disconnected',
      connectError: 'control call fs/read timed out after 60000ms; closing the connection',
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('does not record a connect error on a normal dispose', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) =>
      closingEnvironment(options, 'connected-1', 'connection closed by client'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const managed = registry.current('dev-box')!;
    await managed.dispose();

    expect(managed.status).toBe('disposed');
    expect(managed.connectError).toBeUndefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('removes registered environments on dispose', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    expect(registry.current('dev-box')).toBeUndefined();
    await registry.dispose();
  });
});

describe('remote connection pool', () => {
  const CONTEXT_B: EnvironmentProviderContext = { ...CONTEXT, id: 'workspace-2' };

  function poolServices(): HostServices {
    return baseServices({
      config: configService({
        'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
      }),
    });
  }

  function producingConnect(): {
    connect: ReturnType<typeof vi.fn<(options: RemoteEnvironmentOptions) => Promise<RemoteEnvironment>>>;
    produced: FakeEnvironment[];
  } {
    const produced: FakeEnvironment[] = [];
    let generation = 0;
    const connect = vi.fn<(options: RemoteEnvironmentOptions) => Promise<RemoteEnvironment>>(async (options) => {
      generation += 1;
      const environment = closingEnvironment(options, `connected-${generation}`, 'control call environment/status timed out after 60000ms; closing the connection');
      produced.push(environment as unknown as FakeEnvironment);
      return environment;
    });
    return { connect, produced };
  }

  function disposed(environment: FakeEnvironment | undefined): boolean {
    return (environment as unknown as { disposed: boolean }).disposed;
  }

  it('shares one connection across workspaces with the same declaration fingerprint', async () => {
    const registryA = new EnvironmentRegistry('workspace-1');
    const registryB = new EnvironmentRegistry('workspace-2');
    const { connect, produced } = producingConnect();
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachmentA = await factory.attach(CONTEXT, fakeHost(poolServices(), registryA));
    const attachmentB = await factory.attach(CONTEXT_B, fakeHost(poolServices(), registryB));

    await registryA.current('dev-box')!.connect!();
    await registryB.current('dev-box')!.connect!();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(registryA.current('dev-box')!.status).toBe('ready');
    expect(registryB.current('dev-box')!.status).toBe('ready');

    // Each workspace leases independently through its own registry.
    const leaseA = registryA.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    const leaseB = registryB.acquire({ workspaceId: 'workspace-2', environmentId: 'dev-box' }, ['fs']);
    leaseA.dispose();
    leaseB.dispose();

    // Tearing down one workspace leaves the shared connection alive for the
    // other; the pool destroys it once the last workspace lets go.
    await attachmentA.dispose();
    expect(disposed(produced[0])).toBe(false);
    expect(registryB.current('dev-box')!.status).toBe('ready');

    await attachmentB.dispose();
    expect(disposed(produced[0])).toBe(true);
    await registryA.dispose();
    await registryB.dispose();
  });

  it('reconnects every workspace through one factory call after the shared connection drops', async () => {
    const registryA = new EnvironmentRegistry('workspace-1');
    const registryB = new EnvironmentRegistry('workspace-2');
    const { connect, produced } = producingConnect();
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachmentA = await factory.attach(CONTEXT, fakeHost(poolServices(), registryA));
    const attachmentB = await factory.attach(CONTEXT_B, fakeHost(poolServices(), registryB));

    await registryA.current('dev-box')!.connect!();
    await registryB.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledTimes(1);

    produced[0]!.setStatus('disconnected');
    expect(registryA.current('dev-box')!.status).toBe('disconnected');
    expect(registryB.current('dev-box')!.status).toBe('disconnected');

    await Promise.all([
      registryA.current('dev-box')!.connect!(),
      registryB.current('dev-box')!.connect!(),
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(registryA.current('dev-box')!.status).toBe('ready');
    expect(registryB.current('dev-box')!.status).toBe('ready');

    await attachmentA.dispose();
    await attachmentB.dispose();
    await registryA.dispose();
    await registryB.dispose();
  });

  it('swaps every workspace view to the replacement when one workspace reconnects', async () => {
    const registryA = new EnvironmentRegistry('workspace-1');
    const registryB = new EnvironmentRegistry('workspace-2');
    const { connect, produced } = producingConnect();
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachmentA = await factory.attach(CONTEXT, fakeHost(poolServices(), registryA));
    const attachmentB = await factory.attach(CONTEXT_B, fakeHost(poolServices(), registryB));

    await registryA.current('dev-box')!.connect!();
    await registryB.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledTimes(1);
    const generationB = registryB.current('dev-box')!.identity.generation;
    // B pins the current generation by holding a lease, like an in-flight turn.
    const leaseB = registryB.acquire({ workspaceId: 'workspace-2', environmentId: 'dev-box' }, ['fs']);
    const viewB = leaseB.environment;

    await registryA.current('dev-box')!.connect!();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(registryA.current('dev-box')!.identity.generation).not.toBe(generationB);
    expect(registryB.current('dev-box')!.identity.generation).toBe(generationB);
    expect(registryB.current('dev-box')!.status).toBe('ready');
    expect(leaseB.environment).toBe(viewB);
    leaseB.dispose();
    await vi.waitFor(() => {
      expect(disposed(produced[0])).toBe(true);
    });
    expect(disposed(produced[1])).toBe(false);

    await attachmentA.dispose();
    await attachmentB.dispose();
    await registryA.dispose();
    await registryB.dispose();
  });

  it('does not pool ephemeral environment connections with declared ones', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const { connect } = producingConnect();
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(poolServices(), registry));

    await registry.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledTimes(1);

    const connector = new RemoteEphemeralEnvironmentConnector(
      {
        _serviceBrand: undefined,
        clientIdentity: { productName: 'Kimi Code CLI', version: '1.2.3', platform: 'kimi_code_cli' },
      } as unknown as IBootstrapService,
      NOOP_LOG,
      connect,
    );
    const ephemeralRegistry = new EnvironmentRegistry('workspace-1');
    await connector.connect({
      workspaceId: 'workspace-1',
      environmentId: 'eph-box',
      entry: { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
      registry: ephemeralRegistry,
    });
    expect(connect).toHaveBeenCalledTimes(2);

    await ephemeralRegistry.dispose();
    await attachment.dispose();
    await registry.dispose();
  });
});

describe('RemoteConnectionPool', () => {
  function pooledEnvironment(generation: string): RemoteEnvironment {
    return new FakeEnvironment(
      { workspaceId: 'workspace-1', environmentId: 'dev-box', generation },
      { capabilities: ['fs', 'process'] },
    ) as unknown as RemoteEnvironment;
  }

  function holder(overrides: Partial<RemoteConnectionPoolHolder> = {}): RemoteConnectionPoolHolder {
    return { onPoolReplace: () => {}, ...overrides };
  }

  it('disposes a connect that finishes after the pool was disposed instead of installing it', async () => {
    const pool = new RemoteConnectionPool();
    let releaseConnect!: () => void;
    const produced: FakeEnvironment[] = [];
    const factory = vi.fn(() => new Promise<RemoteEnvironment>((resolve) => {
      releaseConnect = () => {
        const environment = pooledEnvironment('stale-1');
        produced.push(environment as unknown as FakeEnvironment);
        resolve(environment);
      };
    }));
    const acquiring = pool.acquire('fingerprint', factory, holder());

    const disposing = pool.dispose();
    releaseConnect();
    await expect(acquiring).rejects.toBeInstanceOf(RemoteConnectionPoolStaleError);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    await disposing;
  });

  it('runs the factory once for concurrent acquires and retries it after a failure', async () => {
    const pool = new RemoteConnectionPool();
    let attempts = 0;
    const factory = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('handshake failed');
      return pooledEnvironment(`connected-${attempts}`);
    });

    await expect(pool.acquire('fingerprint', factory, holder())).rejects.toThrow('handshake failed');
    const handle = await pool.acquire('fingerprint', factory, holder());
    expect(factory).toHaveBeenCalledTimes(2);
    expect(handle.connection.status).toBe('ready');

    handle.release();
    await pool.dispose();
  });

  it('replaces the connection, broadcasts it to every holder, and disposes the old one', async () => {
    const pool = new RemoteConnectionPool();
    const first = pooledEnvironment('connected-1');
    const second = pooledEnvironment('connected-2');
    const factory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const replaced: RemoteEnvironment[] = [];
    const onPoolReplace = (connection: RemoteEnvironment) => {
      replaced.push(connection);
    };
    const handleA = await pool.acquire('fingerprint', factory, holder({ onPoolReplace }));
    const handleB = await pool.acquire('fingerprint', factory, holder({ onPoolReplace }));
    expect(handleA.connection).toBe(first);

    const replacement = await pool.replace('fingerprint', factory);

    expect(replacement).toBe(second);
    expect(factory).toHaveBeenCalledTimes(2);
    // Handles read the entry's connection live: a replace swaps it under them.
    expect(handleA.connection).toBe(second);
    expect(handleB.connection).toBe(second);
    await vi.waitFor(() => {
      expect(replaced).toEqual([second, second]);
    });
    await vi.waitFor(() => {
      expect((first as unknown as FakeEnvironment).disposed).toBe(true);
    });
    expect((second as unknown as FakeEnvironment).disposed).toBe(false);

    handleA.release();
    handleB.release();
    await pool.dispose();
  });

  it('joins a concurrent replace instead of driving a second factory run', async () => {
    const pool = new RemoteConnectionPool();
    const first = pooledEnvironment('connected-1');
    await pool.acquire('fingerprint', async () => first, holder());
    let releaseReplace!: (connection: RemoteEnvironment) => void;
    const factory = vi.fn(() => new Promise<RemoteEnvironment>((resolve) => {
      releaseReplace = resolve;
    }));

    const replaceA = pool.replace('fingerprint', factory);
    const replaceB = pool.replace('fingerprint', factory);
    const second = pooledEnvironment('connected-2');
    releaseReplace(second);

    expect(await replaceA).toBe(second);
    expect(await replaceB).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    await pool.dispose();
  });

  it('rejects a replace for an unknown fingerprint', async () => {
    const pool = new RemoteConnectionPool();
    await expect(pool.replace('nope', vi.fn())).rejects.toBeInstanceOf(RemoteConnectionPoolStaleError);
  });
});

describe('declaration watch', () => {
  it('registers a newly added declaration live when the config section changes', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const connect = vi.fn();
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    config.setSection({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
      staging: { type: 'ssh', host: 'staging', defaultCwd: '/srv' },
    });
    await vi.waitFor(() => {
      expect(registry.current('staging')).toBeDefined();
    });
    expect(registry.current('staging')!.status).toBe('pending');
    expect(registry.current('dev-box')).toBeDefined();
    expect(connect).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });

  it('skips a declaration whose registration fails and still registers the rest', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    // A environment registered outside the factory collides with the declaration id.
    registry.register(new FakeEnvironment(
      { workspaceId: 'workspace-1', environmentId: 'conflict', generation: 'other' },
      { capabilities: [] },
    ));
    const config = watchableConfigService({});
    const warn = vi.fn();
    const services = baseServices({
      config: config.service,
      log: { _serviceBrand: undefined, info: () => {}, warn, error: () => {} } as unknown as ILogService,
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    config.setSection({
      conflict: { type: 'ssh', host: 'conflict' },
      staging: { type: 'ssh', host: 'staging' },
    });
    await vi.waitFor(() => {
      expect(registry.current('staging')).toBeDefined();
    });
    expect(warn).toHaveBeenCalled();
    // The colliding pre-existing registration is left untouched.
    expect(registry.current('conflict')!.identity.generation).toBe('other');

    await attachment.dispose();
    await registry.dispose();
  });

  it('updates a changed declaration in place and connects with the new entry', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    const before = registry.current('dev-box')!;
    config.setSection({ 'dev-box': { type: 'ssh', host: 'renamed-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(registry.current('dev-box')!.identity.generation).not.toBe(before.identity.generation);
    });
    expect(registry.current('dev-box')!.status).toBe('pending');

    await registry.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      launcher: { type: 'ssh', host: 'renamed-box', remoteBin: undefined },
    }));

    await attachment.dispose();
    await registry.dispose();
  });

  it('treats a same-content re-fire as a no-op and keeps the registered generation', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    const before = registry.current('dev-box')!;
    config.setSection({ 'dev-box': { defaultCwd: '/home/me', host: 'dev-box', type: 'ssh' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.current('dev-box')!.identity.generation).toBe(before.identity.generation);

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains an in-use environment on removal: held leases keep their environment, new acquires fail, no local fallback', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const produced: FakeEnvironment[] = [];
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      const environment = connectedEnvironment(options, 'connected-1');
      produced.push(environment as unknown as FakeEnvironment);
      return environment;
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    await registry.current('dev-box')!.connect!();
    const connected = registry.current('dev-box')!;
    const lease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(lease.environment).toBe(connected);

    config.setSection({});
    await vi.waitFor(() => {
      expect(registry.current('dev-box')).toBeUndefined();
    });
    // New acquires fail explicitly (not_found) — never a silent local fallback (D3).
    expect(() => registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
    // The held lease keeps its environment; the drain disposes it once the lease releases.
    expect(lease.environment).toBe(connected);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('stops reacting to declaration changes after dispose', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    await attachment.dispose();
    config.setSection({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
      staging: { type: 'ssh', host: 'staging' },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.current('staging')).toBeUndefined();

    await registry.dispose();
  });

  it('discards a connect that finishes after its declaration was replaced', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    let releaseConnect!: () => void;
    const produced: FakeEnvironment[] = [];
    const connect = vi.fn((options: RemoteEnvironmentOptions) => new Promise<RemoteEnvironment>((resolve) => {
      releaseConnect = () => {
        const environment = connectedEnvironment(options, 'stale-1');
        produced.push(environment as unknown as FakeEnvironment);
        resolve(environment);
      };
    }));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    const connecting = registry.current('dev-box')!.connect!();
    config.setSection({ 'dev-box': { type: 'ssh', host: 'renamed-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(registry.current('dev-box')!.status).toBe('pending');
    });
    releaseConnect();
    await connecting;
    // The stale connection is disposed, not swapped in over the new placeholder.
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(registry.current('dev-box')!.identity.generation).not.toBe('stale-1');
    expect(registry.current('dev-box')!.status).toBe('pending');

    await attachment.dispose();
    await registry.dispose();
  });

});

describe('factory executor detection', () => {
  function missingExecutorError(): HandshakeError {
    return new HandshakeError(
      'executor process exited before the handshake completed (code 127, signal null): kimi: command not found',
      { kind: 'executor-exit', exitCode: 127 },
    );
  }

  it('fails a missing executor with static install guidance and never probes', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async () => {
      throw missingExecutorError();
    });
    const runner = vi.fn() as unknown as LocalRunner;
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({
      connect,
      clientVersion: '1.2.3',
      probeRunner: runner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    const error = await placeholder.connect!().catch((error: unknown) => error);

    expect(error).toBeInstanceOf(HandshakeError);
    const message = (error as Error).message;
    expect(message).toContain('was not found on ssh:dev-box');
    expect(message).toContain('Kimi Code release CDN');
    expect(message).toContain('executor path (~/.kimi-code/bin/kimi)');
    expect(message).toContain('Then reconnect the environment.');
    expect(message).not.toContain('curl -fL');
    expect(message).not.toContain('/tmp/kimi-install');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('disconnected');
    // Detection only: static guidance runs no remote command at all.
    expect(runner).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });

  it('fails command environments with guidance and never probes', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const services = baseServices({
      config: configService({
        sandbox: { command: 'sandbox', args: ['ssh'], defaultCwd: '/home/me' },
      }),
    });
    const runner = vi.fn() as unknown as LocalRunner;
    const connect = vi.fn(async () => {
      throw missingExecutorError();
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({
      connect,
      probeRunner: runner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    await expect(registry.current('sandbox')!.connect!()).rejects.toThrow(
      /code 127[\s\S]*the absolute path your launcher command invokes/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });

  it('answers a too-old executor with upgrade guidance', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const runner = vi.fn() as unknown as LocalRunner;
    const connect = vi.fn(async () => {
      throw new HandshakeError(
        'executor version 0.0.4 is below the minimum 0.1.0; upgrade the remote executor (kimi exec-server) and retry',
        { kind: 'incompatible', executorVersion: '0.0.4', minExecutorVersion: '0.1.0' },
      );
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({
      connect,
      probeRunner: runner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await expect(registry.current('dev-box')!.connect!()).rejects.toThrow(
      /0\.0\.4[\s\S]*Upgrade the executor/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });
});

describe('factory docker remoteBin resolution', () => {
  const HOME_PROBE = 'printf "%s" "$HOME"';

  function dockerServices(): HostServices {
    return baseServices({
      config: configService({ 'app-box': { type: 'docker', container: 'myapp' } }),
    });
  }

  it('resolves the current container home once for each connection', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let probes = 0;
    const probeRunner: LocalRunner = async (request: LocalRunRequest) => {
      if (request.args.at(-1) === HOME_PROBE) {
        probes += 1;
        return { code: 0, signal: null, stdout: probes === 1 ? '/root' : '/home/user', stderr: '' };
      }
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
    let generation = 0;
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      generation += 1;
      return closingEnvironment(options, `connected-${generation}`, 'control call environment/status timed out after 60000ms; closing the connection');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect, probeRunner }));
    const attachment = await factory.attach(CONTEXT, fakeHost(dockerServices(), registry));

    await registry.current('app-box')!.connect!();
    const resolved = { type: 'docker', container: 'myapp', context: undefined, remoteBin: '/root/.kimi-code/bin/kimi' };
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ launcher: resolved }));
    expect(probes).toBe(1);

    await registry.current('app-box')!.connect!();
    expect(connect).toHaveBeenCalledTimes(2);
    const currentLauncher = { ...resolved, remoteBin: '/home/user/.kimi-code/bin/kimi' };
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ launcher: currentLauncher }));
    expect(probes).toBe(2);

    const secondInner = connect.mock.results[1]!.value as unknown as Promise<FakeEnvironment>;
    (await secondInner).setStatus('disconnected');
    await registry.current('app-box')!.connect!();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({ launcher: currentLauncher }));
    expect(probes).toBe(3);

    await attachment.dispose();
    await registry.dispose();
  });
});
