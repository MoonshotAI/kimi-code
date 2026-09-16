import { describe, expect, it, vi } from 'vitest';

import { ILogService } from '@moonshot-ai/agent-core-v2/_base/log/log';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
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
import { writeWorkspaceTrust } from '@moonshot-ai/agent-core-v2/workspace/workspaceTrust/trustRecord';

import { RemoteRuntimeProviderFactory } from '../src/client/remoteRuntimeProvider';
import type { RemoteRuntime, RemoteRuntimeOptions } from '../src/client/remoteRuntime';

function flagsService(enabled: boolean): IFlagService {
  return { _serviceBrand: undefined, enabled: () => enabled } as unknown as IFlagService;
}

function configService(section: unknown): IConfigService {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    get: (domain: string) => (domain === 'runtimes' ? section : undefined),
  } as unknown as IConfigService;
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

describe('RemoteRuntimeProviderFactory', () => {
  it('registers nothing when the experimental flag is off', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const factory = new RemoteRuntimeProviderFactory({
      connect: vi.fn(),
    });
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices({ flags: flagsService(false) }), registry));

    expect(registry.list()).toEqual([]);
    await attachment.dispose();
    await registry.dispose();
  });

  it('registers declared runtimes as disconnected placeholders without connecting', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory({ connect });
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
    const factory = new RemoteRuntimeProviderFactory({ connect });
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
    const factory = new RemoteRuntimeProviderFactory({ connect });
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
    const factory = new RemoteRuntimeProviderFactory({ connect });
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
    const factory = new RemoteRuntimeProviderFactory({ connect: vi.fn() });
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
    const factory = new RemoteRuntimeProviderFactory({ connect });
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
    const factory = new RemoteRuntimeProviderFactory({ connect: vi.fn() });
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    expect(registry.current('dev-box')).toBeDefined();
    expect(warn).toHaveBeenCalledWith('project remote runtime declarations failed to load', expect.anything());

    await attachment.dispose();
    await registry.dispose();
  });

  it('removes registered runtimes on dispose', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const factory = new RemoteRuntimeProviderFactory({ connect: vi.fn() });
    const attachment = await factory.attach(CONTEXT, fakeHost(baseServices(), registry));
    expect(registry.current('dev-box')).toBeDefined();

    await attachment.dispose();
    expect(registry.current('dev-box')).toBeUndefined();
    await registry.dispose();
  });
});

describe('toLauncherSpec via factory connect', () => {
  it('lowers command declarations to command launcher specs', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    const services = baseServices({
      config: configService({
        gym: { command: 'agi', args: ['sandbox', 'ssh'], env: { AGI_TOKEN: 'x' }, defaultCwd: '/home/me' },
      }),
    });
    const connect = vi.fn(async (options: RemoteRuntimeOptions) => connectedRuntime(options, 'connected-1'));
    const factory = new RemoteRuntimeProviderFactory({ connect });
    const attachment = await factory.attach(CONTEXT, fakeHost(services, registry));

    await registry.current('gym')!.connect!();
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({
      launcher: { type: 'command', program: 'agi', args: ['sandbox', 'ssh'], env: { AGI_TOKEN: 'x' } },
    }));

    await attachment.dispose();
    await registry.dispose();
  });
});
