import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '@moonshot-ai/agent-core-v2/_base/event';
import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IConfigService, type ConfigSectionChangedEvent } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';
import { IAtomicDocumentStore } from '@moonshot-ai/agent-core-v2/persistence/interface/atomicDocumentStore';
import { FakeRuntime } from '@moonshot-ai/agent-core-v2/runtime/fakeRuntime';
import type { Runtime } from '@moonshot-ai/agent-core-v2/runtime/runtime';
import { RuntimeError, RuntimeRegistry } from '@moonshot-ai/agent-core-v2/runtime/runtimeRegistry';
import type {
  RuntimeProviderContext,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeProvider';
import type {
  RuntimeProviderHost,
} from '@moonshot-ai/agent-core-v2/runtime/runtimeUnitHost';
import { deleteWorkspaceTrust, writeWorkspaceTrust } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/trustRecord';

import { HandshakeError } from '../src/client/connection';
import type { LocalRunner, LocalRunRequest } from '../src/client/executorInstaller';
import {
  RemoteRuntimeProviderFactory,
  type RemoteRuntimeProviderFactoryOptions,
} from '../src/client/remoteRuntimeProvider';
import type { RemoteRuntime, RemoteRuntimeOptions } from '../src/client/remoteRuntime';

function flagsService(enabled: boolean): IFlagService {
  return { _serviceBrand: undefined, enabled: () => enabled } as unknown as IFlagService;
}

function configService(section: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'runtimes' ? section : undefined),
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
      get: (domain: string) => (domain === 'runtimes' ? section : undefined),
      onDidSectionChange: emitter.event,
    } as unknown as IConfigService,
    setSection(next: unknown) {
      const previousValue = section;
      section = next;
      emitter.fire({ domain: 'runtimes', source: 'set', value: next, previousValue });
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

const CONTEXT: RuntimeProviderContext = {
  id: 'workspace-1',
  root: '/repo',
  metadata: {} as RuntimeProviderContext['metadata'],
};

interface HostServices {
  readonly flags: IFlagService;
  readonly config: IConfigService;
  readonly fs: IHostFileSystem;
  readonly docs: IAtomicDocumentStore;
  readonly log: ILogService;
}

function fakeHost(services: HostServices, registry: RuntimeRegistry): RuntimeProviderHost {
  return {
    get: (id: unknown) => {
      if (id === IFlagService) return services.flags;
      if (id === IConfigService) return services.config;
      if (id === IHostFileSystem) return services.fs;
      if (id === IAtomicDocumentStore) return services.docs;
      if (id === ILogService) return services.log;
      throw new Error('unexpected service');
    },
    provide: () => {
      throw new Error('not used');
    },
    registerRuntime: (runtime: Runtime) => {
      const registration = registry.register(runtime);
      return {
        runtimeId: runtime.identity.runtimeId,
        update: async (prepare: () => Runtime | Promise<Runtime>) => {
          await registration.replace(await prepare());
        },
        remove: () => registration.remove(),
      };
    },
  } as unknown as RuntimeProviderHost;
}

function connectedRuntime(options: RemoteRuntimeOptions, generation: string): RemoteRuntime {
  const runtime = new FakeRuntime(
    { workspaceId: options.workspaceId, runtimeId: options.runtimeId, generation },
    { capabilities: ['fs', 'process'] },
  );
  return Object.assign(runtime, { fs: {}, process: {} }) as unknown as RemoteRuntime;
}

function baseServices(overrides: Partial<HostServices> = {}): HostServices {
  return {
    flags: flagsService(true),
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
function factoryOptions(extra: RemoteRuntimeProviderFactoryOptions = {}): RemoteRuntimeProviderFactoryOptions {
  return { watchProjectDeclarations: () => ({ dispose: () => {} }), ...extra };
}

describe('RemoteRuntimeProviderFactory', () => {
  it('registers nothing when the experimental flag is off', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({
      connect: vi.fn(),
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ flags: flagsService(false) }), registry));

    expect(registry.list()).toEqual([]);
    await attachment.dispose();
    await registry.dispose();
  });

  it('registers declared runtimes as disconnected placeholders without connecting', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const registered = registry.current('dev-box');
    expect(registered).toBeDefined();
    expect(registered!.status).toBe('disconnected');
    expect(connect).not.toHaveBeenCalled();
    expect(() => registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('connects on explicit connect and swaps in the connected generation', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await placeholder.connect!();

    expect(connect).toHaveBeenCalledTimes(1);
    const connected = registry.current('dev-box')!;
    expect(connected.status).toBe('ready');
    expect(connected.identity.generation).toBe('connected-1');
    expect(connected.identity.generation).not.toBe(placeholder.identity.generation);
    const lease = registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' }, ['fs']);
    expect(lease.runtime).toBe(connected);
    lease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('keeps the placeholder when the connect fails', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const connect = vi.fn(async () => {
      throw new Error('executor process exited before the handshake completed (code 127, signal null): kimi: command not found');
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    const placeholder = registry.current('dev-box')!;
    await expect(placeholder.connect!()).rejects.toThrow(/code 127/);
    expect(registry.current('dev-box')).toBe(placeholder);
    expect(registry.current('dev-box')!.status).toBe('disconnected');

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains old leases on reconnect and never moves them to the new connection', async () => {
    const registry = new RuntimeRegistry('workspace-1', 50);
    let generation = 0;
    const produced: FakeRuntime[] = [];
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => {
      generation += 1;
      const runtime = connectedRuntime(options, `connected-${generation}`);
      produced.push(runtime as unknown as FakeRuntime);
      return runtime;
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));

    await registry.current('dev-box')!.connect!();
    const first = registry.current('dev-box')!;
    const oldLease = registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' }, ['fs']);
    expect(oldLease.runtime).toBe(first);

    await first.connect!();
    const second = registry.current('dev-box')!;
    expect(second).not.toBe(first);
    expect(second.identity.generation).toBe('connected-2');
    expect(oldLease.runtime).toBe(first);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);

    const newLease = registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' }, ['fs']);
    expect(newLease.runtime).toBe(second);
    newLease.dispose();
    oldLease.dispose();

    await attachment.dispose();
    await registry.dispose();
  });

  it('does not load project declarations for an untrusted workspace', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const services = baseServices({
      fs: fsService({
        '/repo/.kimi-code/runtimes.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('project-box')).toBeUndefined();
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    await registry.dispose();
  });

  it('loads trusted project declarations and lets them override same-id user entries', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const services = baseServices({
      docs,
      fs: fsService({
        '/repo/.kimi-code/runtimes.toml': '[dev-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n\n[extra]\ntype = "ssh"\nhost = "extra"\ndefaultCwd = "/extra"\n',
      }),
    });
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
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
    const registry = new RuntimeRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const warn = vi.fn();
    const services = baseServices({
      docs,
      fs: fsService({ '/repo/.kimi-code/runtimes.toml': 'not = [toml' }),
      log: { _serviceBrand: undefined, info: () => {}, warn, error: () => {} } as unknown as ILogService,
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('dev-box')).toBeDefined();
    expect(warn).toHaveBeenCalledWith('project remote runtime declarations failed to load', expect.anything());

    await attachment.dispose();
    await registry.dispose();
  });

  it('removes registered runtimes on dispose', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    expect(registry.current('dev-box')).toBeUndefined();
    await registry.dispose();
  });
});

describe('declaration watch', () => {
  it('registers a newly added declaration live when the config section changes', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const connect = vi.fn();
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
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
    const registry = new RuntimeRegistry('workspace-1');
    // A runtime registered outside the factory collides with the declaration id.
    registry.register(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'conflict', generation: 'other' },
      { capabilities: [] },
    ));
    const config = watchableConfigService({});
    const warn = vi.fn();
    const services = baseServices({
      config: config.service,
      log: { _serviceBrand: undefined, info: () => {}, warn, error: () => {} } as unknown as ILogService,
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    config.setSection({
      conflict: { type: 'ssh', host: 'conflict' },
      staging: { type: 'ssh', host: 'staging' },
    });
    await vi.waitFor(() => {
      expect(registry.current('staging')).toBeDefined();
    });
    expect(warn).toHaveBeenCalledWith('remote runtime conflict registration failed', expect.anything());
    // The colliding pre-existing registration is left untouched.
    expect(registry.current('conflict')!.identity.generation).toBe('other');

    await attachment.dispose();
    await registry.dispose();
  });

  it('updates a changed declaration in place and connects with the new entry', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
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
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    const before = registry.current('dev-box')!;
    config.setSection({ 'dev-box': { defaultCwd: '/home/me', host: 'dev-box', type: 'ssh' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(registry.current('dev-box')!.identity.generation).toBe(before.identity.generation);

    await attachment.dispose();
    await registry.dispose();
  });

  it('removes a vanished declaration live and fails its acquires explicitly', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    config.setSection({});
    await vi.waitFor(() => {
      expect(registry.current('dev-box')).toBeUndefined();
    });
    expect(() => registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.not_found' }),
    );

    await attachment.dispose();
    await registry.dispose();
  });

  it('drains an in-use runtime on removal: held leases keep their runtime, new acquires fail, no local fallback', async () => {
    const registry = new RuntimeRegistry('workspace-1', 5_000);
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const produced: FakeRuntime[] = [];
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => {
      const runtime = connectedRuntime(options, 'connected-1');
      produced.push(runtime as unknown as FakeRuntime);
      return runtime;
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ config: config.service }), registry));

    await registry.current('dev-box')!.connect!();
    const connected = registry.current('dev-box')!;
    const lease = registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' }, ['fs']);
    expect(lease.runtime).toBe(connected);

    config.setSection({});
    await vi.waitFor(() => {
      expect(registry.current('dev-box')).toBeUndefined();
    });
    // New acquires fail explicitly (not_found) — never a silent local fallback (D3).
    expect(() => registry.acquire({ workspaceId: 'workspace-1', runtimeId: 'dev-box' })).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.not_found' }),
    );
    // The held lease keeps its runtime; the drain disposes it once the lease releases.
    expect(lease.runtime).toBe(connected);
    expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(false);
    lease.dispose();
    await vi.waitFor(() => {
      expect((produced[0]! as unknown as { disposed: boolean }).disposed).toBe(true);
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('un-registers project-declared runtimes when trust is revoked', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const services = baseServices({
      config: config.service,
      docs,
      fs: fsService({
        '/repo/.kimi-code/runtimes.toml': '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
      }),
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
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
    const registry = new RuntimeRegistry('workspace-1');
    const docs = docsService();
    await writeWorkspaceTrust(docs, '/repo', Date.now());
    const files: Record<string, string> = {};
    let fireWatch: () => void = () => {};
    const watchProjectDeclarations = vi.fn((_path: string, onChange: () => void) => {
      fireWatch = onChange;
      return { dispose: () => {} };
    });
    const services = baseServices({ docs, fs: fsService(files) });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn(), watchProjectDeclarations }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(watchProjectDeclarations).toHaveBeenCalledWith('/repo/.kimi-code/runtimes.toml', expect.any(Function));
    expect(registry.current('project-box')).toBeUndefined();

    files['/repo/.kimi-code/runtimes.toml'] = '[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n';
    fireWatch();
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeDefined();
    });

    files['/repo/.kimi-code/runtimes.toml'] = '';
    fireWatch();
    await vi.waitFor(() => {
      expect(registry.current('project-box')).toBeUndefined();
    });

    await attachment.dispose();
    await registry.dispose();
  });

  it('stops reacting to declaration changes after dispose', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect: vi.fn() }));
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
    const registry = new RuntimeRegistry('workspace-1');
    const config = watchableConfigService({
      'dev-box': { type: 'ssh', host: 'dev-box', defaultCwd: '/home/me' },
    });
    let releaseConnect!: () => void;
    const produced: FakeRuntime[] = [];
    const connect = vi.fn((options: RemoteRuntimeOptions) => new Promise<RemoteRuntime>((resolve) => {
      releaseConnect = () => {
        const runtime = connectedRuntime(options, 'stale-1');
        produced.push(runtime as unknown as FakeRuntime);
        resolve(runtime);
      };
    }));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
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
      const registry = new RuntimeRegistry('workspace-1');
      const docs = docsService();
      await writeWorkspaceTrust(docs, root, Date.now());
      const files: Record<string, string> = {};
      const services = baseServices({ docs, fs: fsService(files) });
      const factory = new RemoteRuntimeProviderFactory({ connect: vi.fn() });
      const attachment = await factory.attach({ ...CONTEXT, root }, fakeHost(services, registry));

      const filePath = join(root, '.kimi-code', 'runtimes.toml');
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
    const registry = new RuntimeRegistry('workspace-1');
    const services = baseServices({
      config: configService({
        sandbox: { command: 'sandbox', args: ['ssh'], env: { SANDBOX_TOKEN: 'x' }, defaultCwd: '/home/me' },
      }),
    });
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({ connect }));
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

  it('auto-installs a typed runtime once and retries the connect once after a missing executor', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    let calls = 0;
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => {
      calls += 1;
      if (calls === 1) throw missingExecutorError();
      return connectedRuntime(options, `connected-${calls}`);
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({
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
    const registry = new RuntimeRegistry('workspace-1');
    const connect = vi.fn(async () => {
      throw missingExecutorError();
    });
    const failingRunner: LocalRunner = async () => ({
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'ssh: connect to host dev-box port 22: Connection refused',
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({
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

  it('fails command runtimes with guidance and never attempts an install', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const services = baseServices({
      config: configService({
        sandbox: { command: 'sandbox', args: ['ssh'], defaultCwd: '/home/me' },
      }),
    });
    const runner = vi.fn() as unknown as LocalRunner;
    const connect = vi.fn(async () => {
      throw missingExecutorError();
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({
      connect,
      artifactLocator: { locate: vi.fn(async () => INSTALL_ARTIFACT) },
      installRunner: runner,
    }));
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    await expect(registry.current('sandbox')!.connect!()).rejects.toThrow(
      /code 127[\s\S]*Auto-install is not available for `command` runtimes/,
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(runner).not.toHaveBeenCalled();

    await attachment.dispose();
    await registry.dispose();
  });

  it('answers a too-old executor with upgrade guidance instead of an install', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const runner = vi.fn() as unknown as LocalRunner;
    const connect = vi.fn(async () => {
      throw new HandshakeError(
        'executor version 0.0.4 is below the minimum 0.1.0; upgrade the remote executor (kimi exec-server) and retry',
        { kind: 'incompatible', executorVersion: '0.0.4', minExecutorVersion: '0.1.0' },
      );
    });
    const factory = new RemoteRuntimeProviderFactory(factoryOptions({
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
