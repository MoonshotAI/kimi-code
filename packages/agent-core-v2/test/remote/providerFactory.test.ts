import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IConfigService, type ConfigSectionChangedEvent } from '#/app/config/config';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { ITelemetryService, noopTelemetryService, type TelemetryAppenderRecord } from '#/app/telemetry/telemetry';
import { TelemetryService } from '#/app/telemetry/telemetryService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment } from '#/environment/environment';
import { EnvironmentError, EnvironmentRegistry } from '#/environment/environmentRegistry';
import type {
  EnvironmentProviderHost,
} from '#/environment/environmentProvider';

import { HandshakeError } from '#/remote/client/connection';
import type { ConnectionCloseInfo } from '#/remote/protocol/channel';
import {
  RemoteEnvironmentProviderFactory,
  type RemoteEnvironmentProviderFactoryOptions,
} from '#/remote/client/remoteEnvironmentProvider';
import type { RemoteSession, RemoteSessionOptions } from '#/remote/client/remoteSession';

function configService(section: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    assertValid: () => {},
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
      assertValid: () => {},
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

beforeEach(() => vi.stubEnv('KIMI_CODE_WATCH', 'false'));
afterEach(() => vi.unstubAllEnvs());

interface HostServices {
  readonly declarations: EnvironmentDeclarationService;
  readonly telemetry: ITelemetryService;
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
      if (id === IEnvironmentDeclarationService) return services.declarations;
      if (id === ITelemetryService) return services.telemetry;
      throw new Error('unexpected service');
    },
    provide: () => {
      throw new Error('not used');
    },
    registerEnvironment: (environment: Environment) => {
      const registration = registry.register(environment);
      return {
        environmentId: environment.identity.environmentId,
        remove: () => registration.remove(),
      };
    },
  } as unknown as EnvironmentProviderHost;
}

type FakeSession = RemoteSession & { released: boolean; close(info: ConnectionCloseInfo): void };

function connectedSession(): FakeSession {
  const listeners = new Set<(info: ConnectionCloseInfo) => void>();
  const session = {
    host: { osKind: 'linux', osArch: 'x64', osVersion: '', shellName: 'sh', shellPath: '/bin/sh', pathClass: 'posix', homeDir: '/home/me', cwd: '/home/me', tempDir: '/tmp' },
    fs: {},
    process: {},
    executorVersion: 'test',
    released: false,
    connection: { onDidClose: (listener: (info: ConnectionCloseInfo) => void) => { listeners.add(listener); } },
    close: (info: ConnectionCloseInfo) => { for (const listener of listeners) listener(info); },
    dispose: async () => { session.released = true; },
  };
  return session as unknown as FakeSession;
}

function baseServices(registry: EnvironmentRegistry, overrides: Partial<HostServices> = {}): HostServices {
  const config = overrides.config ?? configService({ 'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' } });
  const log = overrides.log ?? NOOP_LOG;
  return {
    config,
    declarations: new EnvironmentDeclarationService(config, log),
    telemetry: noopTelemetryService,
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
    const registry = new EnvironmentRegistry();
    const connect = vi.fn(async () => connectedSession());
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(fakeHost(baseServices(registry), registry));

    const registered = registry.current('dev-box');
    expect(registered).toBeDefined();
    expect(registered!.status).toBe('pending');
    expect(registered!.connectError).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();
    expect(() => registry.acquire({ environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('marks the placeholder connecting while a connect is in flight and dedupes concurrent connects', async () => {
    const registry = new EnvironmentRegistry();
    let releaseConnect!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    const connect = vi.fn(async (options: RemoteSessionOptions) => {
      await gate;
      return connectedSession();
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(fakeHost(baseServices(registry), registry));

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

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(1);

    releaseConnect();
    await first;
    expect(placeholder.whenReady).toBeUndefined();
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('ready');
    expect(placeholder.capabilities).toEqual(new Set(['fs', 'process']));
    expect(placeholder.path?.separator).toBe('/');
    expect(placeholder.path?.isAbsolute('/tmp/x')).toBe(true);
    expect(placeholder.path?.join('/a', 'b')).toBe('/a/b');
    expect(placeholder.workspace?.mapRoots({ workDir: 'rel' }).workDir).toBe(placeholder.path?.resolve('rel'));
    expect(statuses[0]).toBe('connecting');

    await attachment.dispose();
    await registry.dispose();
  });
});

describe('declaration watch', () => {
  it('updates a changed declaration in place and connects with the new entry', async () => {
    const registry = new EnvironmentRegistry();
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const connect = vi.fn(async () => connectedSession());
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(fakeHost(baseServices(registry, { config: config.service }), registry));

    const before = registry.current('dev-box')!;
    const generation = before.identity.generation;
    config.setSection({ 'dev-box': { type: 'ssh', host: 'renamed-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(before.identity.generation).not.toBe(generation);
    });
    expect(registry.current('dev-box')).toBe(before);
    expect(before.status).toBe('pending');

    await registry.current('dev-box')!.connect!();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      launcher: { type: 'ssh', host: 'renamed-box', remoteBin: undefined },
    }));

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains an in-use environment on removal: held leases keep their environment, new acquires fail, no local fallback', async () => {
    const registry = new EnvironmentRegistry();
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const produced: FakeSession[] = [];
    const connect = vi.fn(async (options: RemoteSessionOptions) => {
      const environment = connectedSession();
      produced.push(environment);
      return environment;
    });
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(fakeHost(baseServices(registry, { config: config.service }), registry));

    await registry.current('dev-box')!.connect!();
    const connected = registry.current('dev-box')!;
    const lease = registry.acquire({ environmentId: 'dev-box' }, ['fs']);
    expect(lease.environment).toBe(connected);

    config.setSection({});
    await vi.waitFor(() => {
      expect(registry.current('dev-box')).toBeUndefined();
    });

    expect(() => registry.acquire({ environmentId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );

    expect(lease.environment).toBe(connected);
    expect(produced[0]!.released).toBe(false);
    lease.dispose();
    await vi.waitFor(() => {
      expect(produced[0]!.released).toBe(true);
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('discards a connect that finishes after its declaration was replaced', async () => {
    const registry = new EnvironmentRegistry();
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    let releaseConnect!: () => void;
    const produced: FakeSession[] = [];
    const connect = vi.fn((options: RemoteSessionOptions) => new Promise<RemoteSession>((resolve) => {
      releaseConnect = () => {
        const environment = connectedSession();
        produced.push(environment);
        resolve(environment);
      };
    }));
    const factory = new RemoteEnvironmentProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(fakeHost(baseServices(registry, { config: config.service }), registry));

    const connecting = registry.current('dev-box')!.connect!();
    config.setSection({ 'dev-box': { type: 'ssh', host: 'renamed-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(registry.current('dev-box')!.status).toBe('disconnected');
    });
    releaseConnect();
    await expect(connecting).rejects.toThrow(/cancelled/);

    expect(produced[0]!.released).toBe(true);
    expect(registry.current('dev-box')!.identity.generation).not.toBe('stale-1');
    expect(registry.current('dev-box')!.status).toBe('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });
});

describe('SSH password fallback', () => {
  it('prompts after authentication failure, reuses memory, and clears it on config changes', async () => {
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const registry = new EnvironmentRegistry();
    let attempt = 0;
    const produced: FakeSession[] = [];
    const connect = vi.fn(async (options: RemoteSessionOptions) => {
      attempt += 1;
      if (attempt === 1) throw new HandshakeError('Permission denied (publickey,password)', { kind: 'authentication' });
      const session = connectedSession();
      produced.push(session);
      return session;
    });
    const prompt = vi.fn(async () => 'secret');
    const factory = new RemoteEnvironmentProviderFactory({
      connect,
      sshPassword: { prompt, askpassCommand: ['/bin/kimi'] },
    });
    const attachment = await factory.attach(fakeHost(baseServices(registry, { config: config.service }), registry));
    const target = registry.current('dev-box')!;

    await target.connect!();
    expect(prompt).toHaveBeenCalledExactlyOnceWith('dev-box');
    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0]![0].sshAuth).toBeUndefined();
    expect(connect.mock.calls[1]![0].sshAuth).toEqual({
      password: 'secret', command: ['/bin/kimi'],
    });

    produced[0]!.close({ reason: 'offline' });
    await target.connect!();
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(connect.mock.calls[2]![0].sshAuth?.password).toBe('secret');

    const generation = target.identity.generation;
    config.setSection({ 'dev-box': { type: 'ssh', host: 'renamed-box', defaultCwd: '/home/me' } });
    await vi.waitFor(() => {
      expect(target.identity.generation).not.toBe(generation);
    });
    await target.connect!();
    expect(connect.mock.calls[3]![0].sshAuth).toBeUndefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('keeps the original authentication error when prompting is cancelled', async () => {
    const registry = new EnvironmentRegistry();
    const failure = new HandshakeError('Permission denied (publickey,password)', { kind: 'authentication' });
    const connect = vi.fn(async () => {
      throw failure;
    });
    const factory = new RemoteEnvironmentProviderFactory({
      connect,
      sshPassword: { prompt: async () => undefined, askpassCommand: ['/bin/kimi'] },
    });
    const attachment = await factory.attach(fakeHost(baseServices(registry), registry));

    await expect(registry.current('dev-box')!.connect!()).rejects.toBe(failure);
    expect(connect).toHaveBeenCalledTimes(1);

    await attachment.dispose();
    await registry.dispose();
  });
});

describe('connection telemetry', () => {
  it('reports physical attempts once, initial failures separately from reconnects, and never sends raw identifiers', async () => {
    const telemetry = new TelemetryService();
    const records: TelemetryAppenderRecord[] = [];
    telemetry.addAppender({ track: (record) => records.push(record) });
    let attempt = 0;
    const produced: FakeSession[] = [];
    const connect = vi.fn(async (options: RemoteSessionOptions) => {
      if (++attempt === 1) throw new HandshakeError('secret-host: /private/path YOUR_API_KEY', { kind: 'timeout' });
      const environment = connectedSession();
      produced.push(environment);
      return environment;
    });
    const registry = new EnvironmentRegistry();
    const services = baseServices(registry, { telemetry });
    const provider = await new RemoteEnvironmentProviderFactory({ connect }).attach(fakeHost(services, registry));
    const target = registry.current('dev-box')!;
    await expect(target.connect!()).rejects.toThrow('secret-host');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'environment_connected', properties: { outcome: 'error', error_type: 'timeout', is_reconnect: false } });
    await Promise.all([target.connect!(), target.connect!()]);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ event: 'environment_connected', properties: { outcome: 'ok', is_reconnect: false } });
    produced[0]!.close({ reason: 'secret-host: /private/path' });
    expect(produced[0]!.released).toBe(true);
    expect(records[2]).toMatchObject({ event: 'environment_disconnected', properties: { reason: 'other', uptime_ms: expect.any(Number) } });
    await target.connect!();
    expect(records[3]).toMatchObject({ event: 'environment_connected', properties: { outcome: 'ok', is_reconnect: true } });
    await provider.dispose();
    expect(records).toHaveLength(4);
    const payload = JSON.stringify(records);
    for (const privateValue of ['secret-host', '/private/path', 'YOUR_API_KEY', 'dev-box', 'sessionId']) expect(payload).not.toContain(privateValue);
    services.declarations.dispose();
    await registry.dispose();
  });
});
