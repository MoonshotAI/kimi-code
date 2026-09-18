import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IConfigService, type ConfigSectionChangedEvent } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import type { Environment } from '@moonshot-ai/agent-core-v2/environment/environment';
import { EnvironmentError, EnvironmentRegistry } from '@moonshot-ai/agent-core-v2/environment/environmentRegistry';
import type {
  EnvironmentProviderContext,
} from '@moonshot-ai/agent-core-v2/environment/environmentProvider';
import type {
  EnvironmentProviderHost,
} from '@moonshot-ai/agent-core-v2/environment/environmentUnitHost';
import { deleteWorkspaceTrust, writeWorkspaceTrust } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/trustRecord';
import type { WorkspaceTrustChange } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/workspaceTrust';

import { HandshakeError } from '../src/client/connection';
import type { LocalRunner, LocalRunRequest } from '../src/client/executorInstaller';
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

const trustChange = new Emitter<WorkspaceTrustChange>();

const CONTEXT: EnvironmentProviderContext = {
  id: 'workspace-1',
  root: '/repo',
  metadata: {} as EnvironmentProviderContext['metadata'],
  onDidChangeTrust: trustChange.event,
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

// Tests inject a no-op project-file watcher by default; watch-specific tests
// override it with a fake (or drop it to exercise the real chokidar watcher).
function factoryOptions(extra: RemoteEnvironmentProviderFactoryOptions = {}): RemoteEnvironmentProviderFactoryOptions {
  return { watchProjectDeclarations: () => ({ dispose: () => {} }), ...extra };
}

describe('RemoteEnvironmentProviderFactory', () => {
  it('registers project declarations when workspace trust flips on after an untrusted attach', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    const services = baseServices({
      docs,
      fs: fsService({
        '/repo/.kimi-code/environments.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));
    expect(registry.current('project-box')).toBeUndefined();

    await writeWorkspaceTrust(docs, '/repo', Date.now());
    trustChange.fire({ trusted: true });
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeDefined();
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('un-registers project declarations when workspace trust flips off', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const services = baseServices({
      docs,
      fs: fsService({
        '/repo/.kimi-code/environments.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));
    expect(registry.current('project-box')).toBeDefined();

    await deleteWorkspaceTrust(docs, '/repo');
    trustChange.fire({ trusted: false });
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeUndefined();
    });
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('registers declared environments as disconnected placeholders without connecting', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const registered = registry.current('dev-box');
    expect(registered).toBeDefined();
    expect(registered!.status).toBe('disconnected');
    expect(connect).not.toHaveBeenCalled();
    expect(() => registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('connects on explicit connect and swaps in the connected generation', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await placeholder.connect!();

    expect(connect).toHaveBeenCalledTimes(1);
    const connected = registry.current('dev-box')!;
    expect(connected.status).toBe('ready');
    expect(connected.identity.generation).toBe('connected-1');
    expect(connected.identity.generation).not.toBe(placeholder.identity.generation);
    const lease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(lease.environment).toBe(connected);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('keeps the placeholder when the connect fails', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async () => {
      throw new Error('executor process exited before the handshake completed (code 127, signal null): kimi: command not found');
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await expect(placeholder.connect!()).rejects.toThrow(/code 127/);
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('disconnected');

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
    expect(connect).toHaveBeenCalledTimes(1);

    releaseConnect();
    await first;
    expect(placeholder.whenReady).toBeUndefined();
    expect(registry.current('dev-box')!.status).toBe('ready');
    expect(registry.current('dev-box')!.identity.generation).toBe('connected-1');
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
    expect(lease.environment.identity.generation).toBe('connected-1');
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
      const environment = connectedEnvironment(options, `connected-${current}`) as unknown as FakeEnvironment & {
        connection: { closeReason?: { reason: string } };
      };
      environment.connection = {
        closeReason: { reason: 'control call fs/read timed out after 60000ms; closing the connection' },
      };
      return environment as unknown as RemoteEnvironment;
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
    expect(lease.environment.identity.generation).toBe('connected-2');
    expect(lease.environment).not.toBe(managed);
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
      return connectedEnvironment(options, `connected-${generation}`);
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const managed = registry.current('dev-box')!;
    expect(managed.status).toBe('ready');

    await expect(managed.connect!()).rejects.toBe(failure);
    expect(registry.current('dev-box')).toBe(managed);
    expect(managed.status).toBe('disconnected');
    expect(managed.whenReady).toBeUndefined();
    expect(managed.connectError).toContain('Connection refused');
    await expect(registry.acquireWhenReady({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).rejects.toThrow('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains old leases on reconnect and never moves them to the new connection', async () => {
    const registry = new EnvironmentRegistry('workspace-1', 50);
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

    await first.connect!();
    const second = registry.current('dev-box')!;
    expect(second).not.toBe(first);
    expect(second.identity.generation).toBe('connected-2');
    expect(oldLease.environment).toBe(first);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);

    const newLease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(newLease.environment).toBe(second);
    newLease.dispose();
    oldLease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('records the connection close reason when a connected environment drops mid-session', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      const environment = connectedEnvironment(options, 'connected-1') as unknown as FakeEnvironment & {
        connection: { closeReason?: { reason: string } };
      };
      environment.connection = {
        closeReason: { reason: 'control call fs/read timed out after 60000ms; closing the connection' },
      };
      return environment as unknown as RemoteEnvironment;
    });
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
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      const environment = connectedEnvironment(options, 'connected-1') as unknown as FakeEnvironment & {
        connection: { closeReason?: { reason: string } };
      };
      environment.connection = {
        closeReason: { reason: 'connection closed by client' },
      };
      return environment as unknown as RemoteEnvironment;
    });
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

  it('does not load project declarations for an untrusted workspace', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const services = baseServices({
      fs: fsService({
        '/repo/.kimi-code/environments.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('project-box')).toBeUndefined();
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('loads trusted project declarations and lets them override same-id user entries', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const services = baseServices({
      docs,
      fs: fsService({
        '/repo/.kimi-code/environments.toml': '[dev-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n\n[extra]\ntype = "ssh"\nhost = "extra"\ndefaultCwd = "/extra"\n',
      }),
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('dev-box')).toBeDefined();
    expect(registry.current('extra')).toBeDefined();

    await registry.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      launcher: { type: 'ssh', host: 'project-box', remoteBin: undefined },
    }));

    await attachment.dispose();
    await registry.dispose();
  });

  it('registers user entries and reports the project error when the project file is broken', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const warn = vi.fn();
    const services = baseServices({
      docs,
      fs: fsService({ '/repo/.kimi-code/environments.toml': 'not = [toml' }),
      log: { _serviceBrand: undefined, info: () => {}, warn, error: () => {} } as unknown as ILogService,
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('dev-box')).toBeDefined();
    expect(warn).toHaveBeenCalledWith('project remote environment declarations failed to load', expect.anything());

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

describe('ManagedRemoteEnvironment reroot', () => {
  it('re-registers the connected environment with identity.cwd on a fresh generation, keeping the connection alive', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const produced: FakeEnvironment[] = [];
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      const environment = connectedEnvironment(options, `connected-${produced.length + 1}`);
      produced.push(environment as unknown as FakeEnvironment);
      return environment;
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const bound = registry.current('dev-box')!;
    expect(bound.identity.cwd).toBeUndefined();

    await bound.reroot!('/home/me/project');

    const rerooted = registry.current('dev-box')!;
    expect(rerooted).not.toBe(bound);
    expect(rerooted.identity.cwd).toBe('/home/me/project');
    expect(rerooted.identity.generation).not.toBe(bound.identity.generation);
    expect(rerooted.status).toBe('ready');
    expect(connect).toHaveBeenCalledTimes(1);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(false);
    const lease = registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' }, ['fs']);
    expect(lease.environment).toBe(rerooted);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('carries a pending reroot into the connected registration without an extra swap', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const changes: (string | undefined)[] = [];
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await placeholder.reroot!('/home/me/project');
    expect(connect).not.toHaveBeenCalled();
    expect(registry.current('dev-box')).toBe(placeholder);

    registry.onDidChange((change) => {
      if (change.current !== undefined) changes.push(change.current.identity.generation);
    });
    await registry.current('dev-box')!.connect!();

    const connected = registry.current('dev-box')!;
    expect(connected.identity.cwd).toBe('/home/me/project');
    expect(connected.status).toBe('ready');
    expect(changes.filter((generation) => generation === 'connected-1')).toHaveLength(1);

    await attachment.dispose();
    await registry.dispose();
  });

  it('keeps the bound cwd across a reconnect', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let generation = 0;
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      generation += 1;
      return connectedEnvironment(options, `connected-${generation}`);
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    await registry.current('dev-box')!.reroot!('/home/me/project');
    await registry.current('dev-box')!.connect!();

    const reconnected = registry.current('dev-box')!;
    expect(reconnected.identity.cwd).toBe('/home/me/project');
    expect(reconnected.identity.generation).toBe('connected-2');

    await attachment.dispose();
    await registry.dispose();
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
    expect(registry.current('staging')!.status).toBe('disconnected');
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
    expect(warn).toHaveBeenCalledWith('remote environment conflict registration failed', expect.anything());
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
    expect(registry.current('dev-box')!.status).toBe('disconnected');

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

  it('removes a vanished declaration live and fails its acquires explicitly', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    config.setSection({});
    await vi.waitFor(() => {
      expect(registry.current('dev-box')).toBeUndefined();
    });
    expect(() => registry.acquire({ workspaceId: 'workspace-1', environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains an in-use environment on removal: held leases keep their environment, new acquires fail, no local fallback', async () => {
    const registry = new EnvironmentRegistry('workspace-1', 5_000);
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
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(false);
    lease.dispose();
    await vi.waitFor(() => {
      expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('un-registers project-declared environments when trust is revoked', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const services = baseServices({
      config: config.service,
      docs,
      fs: fsService({
        '/repo/.kimi-code/environments.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));
    expect(registry.current('project-box')).toBeDefined();

    await deleteWorkspaceTrust(docs, '/repo');
    // Trust is re-read on every reconcile, so a revocation re-gates project
    // declarations at the next watch trigger.
    config.setSection({ 'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeUndefined();
    });
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('re-resolves declarations when the project file watch fires', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const files: Record<string, string> = {};
    let fireWatch: () => void = () => {};
    const watchProjectDeclarations = vi.fn((_path: string, onChange: () => void) => {
      fireWatch = onChange;
      return { dispose: () => {} };
    });
    const services = baseServices({ docs, fs: fsService(files) });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect: vi.fn(), watchProjectDeclarations }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(watchProjectDeclarations).toHaveBeenCalledWith('/repo/.kimi-code/environments.toml', expect.any(Function));
    expect(registry.current('project-box')).toBeUndefined();

    files['/repo/.kimi-code/environments.toml'] = '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n';
    fireWatch();
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeDefined();
    });

    files['/repo/.kimi-code/environments.toml'] = '';
    fireWatch();
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeUndefined();
    });

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
      expect(registry.current('dev-box')!.status).toBe('disconnected');
    });
    releaseConnect();
    await connecting;
    // The stale connection is disposed, not swapped in over the new placeholder.
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    expect(registry.current('dev-box')!.identity.generation).not.toBe('stale-1');
    expect(registry.current('dev-box')!.status).toBe('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('picks up project declarations written to disk through the default file watcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'remote-exec-watch-'));
    try {
      const registry = new EnvironmentRegistry('workspace-1');
      const docs = docsService();
      await writeWorkspaceTrust(docs, root, Date.now());
      const files: Record<string, string> = {};
      const services = baseServices({ docs, fs: fsService(files) });
      const factory = new RemoteEnvironmentProviderFactory({ connect: vi.fn() });
      const attachment = await factory.attach({ ...CONTEXT, root }, fakeHost(services, registry));

      const filePath = join(root, '.kimi-code', 'environments.toml');
      await mkdir(dirname(filePath), { recursive: true });
      files[filePath] = '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n';
      await writeFile(filePath, files[filePath]);
      await vi.waitFor(() => {
        expect(registry.current('project-box')).toBeDefined();
      }, { timeout: 10_000 });

      await attachment.dispose();
      await registry.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('toLauncherSpec via factory connect', () => {
  it('lowers command declarations to command launcher specs', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const services = baseServices({
      config: configService({
        sandbox: { command: 'sandbox', args: ['ssh'], env: { SANDBOX_TOKEN: 'x' }, defaultCwd: '/home/me' },
      }),
    });
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => connectedEnvironment(options, 'connected-1'));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    await registry.current('sandbox')!.connect!();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      launcher: { type: 'command', program: 'sandbox', args: ['ssh'], env: { SANDBOX_TOKEN: 'x' } },
    }));

    await attachment.dispose();
    await registry.dispose();
  });
});

describe('factory auto-install trigger', () => {
  const INSTALL_ARTIFACT_BYTES = new TextEncoder().encode('fake-kimi-sea-binary\n');
  const INSTALL_ARTIFACT = {
    version: '1.2.3',
    filename: 'kimi-code-linux-x64',
    url: 'https://cdn.example.test/binaries/1.2.3/kimi-code-linux-x64',
    sha256: createHash('sha256').update(INSTALL_ARTIFACT_BYTES).digest('hex'),
  };

  function installFetch(): typeof fetch {
    return vi.fn(async () => new Response(INSTALL_ARTIFACT_BYTES, { status: 200 })) as unknown as typeof fetch;
  }

  function sshInstallRunner(): LocalRunner {
    let installedVersion: string | undefined;
    return async (request: LocalRunRequest) => {
      const last = request.args.at(-1) ?? '';
      if (request.program === 'ssh') {
        if (last.includes('uname -sm')) {
          return { code: 0, signal: null, stdout: 'Linux x86_64\n/home/test', stderr: '' };
        }
        if (last.endsWith('--version')) {
          return installedVersion === undefined
            ? { code: 127, signal: null, stdout: '', stderr: 'kimi: command not found' }
            : { code: 0, signal: null, stdout: `${installedVersion}\n`, stderr: '' };
        }
        if (last.startsWith('chmod 755')) installedVersion = INSTALL_ARTIFACT.version;
        return { code: 0, signal: null, stdout: '', stderr: '' };
      }
      return { code: 0, signal: null, stdout: '', stderr: '' };
    };
  }

  function missingExecutorError(): HandshakeError {
    return new HandshakeError(
      'executor process exited before the handshake completed (code 127, signal null): kimi: command not found',
      { kind: 'executor-exit', exitCode: 127 },
    );
  }

  it('auto-installs a typed environment once and retries the connect once after a missing executor', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    let calls = 0;
    const connect = vi.fn(async (options: RemoteEnvironmentOptions) => {
      calls += 1;
      if (calls === 1) throw missingExecutorError();
      return connectedEnvironment(options, `connected-${calls}`);
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({
      connect,
      clientVersion: '1.2.3',
      artifactLocator: { locate: vi.fn(async () => INSTALL_ARTIFACT) },
      installFetch: installFetch(),
      installRunner: sshInstallRunner(),
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenLastCalledWith(expect.objectContaining({
      launcher: { type: 'ssh', host: 'dev-box', remoteBin: '~/.kimi-code/bin/kimi' },
    }));
    expect(registry.current('dev-box')!.status).toBe('ready');
    expect(registry.current('dev-box')!.identity.generation).toBe('connected-2');

    await attachment.dispose();
    await registry.dispose();
  });

  it('does not retry the connect when the auto-install fails', async () => {
    const registry = new EnvironmentRegistry('workspace-1');
    const connect = vi.fn(async () => {
      throw missingExecutorError();
    });
    const failingRunner: LocalRunner = async () => ({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'ssh: connect to host dev-box port 22: Connection refused',
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({
      connect,
      clientVersion: '1.2.3',
      artifactLocator: { locate: vi.fn(async () => INSTALL_ARTIFACT) },
      installFetch: installFetch(),
      installRunner: failingRunner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await expect(placeholder.connect!()).rejects.toThrow(/Auto-install failed[\s\S]*Connection refused/);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('fails command environments with guidance and never attempts an install', async () => {
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
      artifactLocator: { locate: vi.fn(async () => INSTALL_ARTIFACT) },
      installRunner: runner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    await expect(registry.current('sandbox')!.connect!()).rejects.toThrow(
      /code 127[\s\S]*Auto-install is not available for `command` environments/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });

  it('answers a too-old executor with upgrade guidance instead of an install', async () => {
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
      artifactLocator: { locate: vi.fn(async () => INSTALL_ARTIFACT) },
      installRunner: runner,
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
