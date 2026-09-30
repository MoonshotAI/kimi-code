import { describe, expect, it, vi } from 'vitest';

import type { ISessionEventBus } from '#/app/event/eventBus';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import '#/agent/contextMemory/conversationTime';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentEnvironmentService, acquireOrWhenReady, snapshotAgentEnvironmentBinding } from '#/agent/environmentBinding/agentEnvironment';
import { AgentEnvironmentBindingService, agentEnvironmentBindingKey, ENVIRONMENT_BINDING_REMINDER_VARIANT, PROJECT_CONTEXT_REMINDER_VARIANT } from '#/agent/environmentBinding/environmentBindingService';
import { environmentBindingKey, EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import { EnvironmentError, EnvironmentRegistry, type EnvironmentRegistrationHandle } from '#/environment/environmentRegistry';
import type { IHostFileSystem, HostFileStat } from '#/os/interface/hostFileSystem';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import type { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { stubAgentContext } from '../agentContext/stubs';
import { noopLogger } from '../../wire/stubs';
import { fakeEnvironment, connectableEnvironment } from '../../environment/stubs';

const LOCAL_HOST = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: '6.1.0-local',
  shellName: 'bash',
  shellPath: '/bin/bash',
} as const;
const REMOTE_HOST = {
  osKind: 'FreeBSD',
  osArch: 'arm64',
  osVersion: '13.2-remote',
  shellName: 'sh',
  shellPath: '/usr/local/bin/sh',
} as const;

interface ReminderHost {
  readonly osKind: string;
  readonly osArch: string;
  readonly osVersion: string;
  readonly shellName: string;
  readonly shellPath: string;
}

function reminderText(environmentId: string, host: ReminderHost, cwd: string): string {
  return (
    `The active environment is now "${environmentId}": ${host.osKind} ${host.osVersion} ${host.osArch}, ` +
    `shell ${host.shellName} (${host.shellPath}), working directory ${cwd}. ` +
    'Tool calls execute in this environment.'
  );
}

function stubWorkspaceContext(cwd: string, workDirWrites: string[]): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: cwd,
    additionalDirs: [],
    setWorkDir: (dir: string) => {
      workDirWrites.push(dir);
    },
  } as unknown as ISessionWorkspaceContext;
}

function stubScopeContext(agentId: string) {
  return {
    _serviceBrand: undefined,
    agentId,
    agentContext: stubAgentContext(agentId, 1),
    scope: (subKey?: string) => subKey ?? '',
  };
}

function stubReminder(reminders: { content: string; variant: string }[]): IAgentReminderService {
  return {
    _serviceBrand: undefined,
    notify: (content: string, notification: { variant: string }) => {
      reminders.push({ content, variant: notification.variant });
    },
  } as unknown as IAgentReminderService;
}

const BOOTSTRAP_HOME = '/kimi-home';

function stubBootstrap(): IBootstrapService {
  return {
    _serviceBrand: undefined,
    homeDir: BOOTSTRAP_HOME,
  } as unknown as IBootstrapService;
}

function registryResolver(registry: EnvironmentRegistry): EnvironmentResolver {
  return {
    _serviceBrand: undefined,
    inspect: (binding: EnvironmentBinding) => registry.inspect(binding),
    acquire: (binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): EnvironmentLease =>
      registry.acquire(binding, required),
    acquireWhenReady: (binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> =>
      registry.acquireWhenReady(binding, required),
  };
}

function environment(
  environmentId: string,
  generation: string,
  status: Environment['status'] = 'ready',
  capabilities: readonly EnvironmentCapability[] = [],
  host?: Partial<Environment['host']>,
): FakeEnvironment {
  return fakeEnvironment(environmentId, generation, { status, capabilities, host });
}

interface RestoreHook {
  (ctx: unknown, next: () => Promise<void>): Promise<void>;
}

function setup(options: {
  agentId?: string;
  sessionCwd?: string;
  seedBinding?: EnvironmentBinding;
  persistedBinding?: { readonly environmentId?: string; readonly environmentCwd?: string };
} = {}) {
  const registry = new EnvironmentRegistry();
  const local = environment('local', 'local-one', 'ready', ['fs', 'process'], LOCAL_HOST);
  const remote = environment('remote', 'remote-one', 'ready', ['process'], REMOTE_HOST);
  const localRegistration = registry.register(local);
  registry.register(remote);
  const resolver = registryResolver(registry);
  const session = makeSessionContext({
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    sessionScope: 'sessions/session',
    cwd: options.sessionCwd ?? '/workspace',
  });
  const dispatched: EnvironmentSetBinding[] = [];
  const restoreHooks = new Map<string, RestoreHook>();
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: (event: EnvironmentSetBinding) => {
      dispatched.push(event);
      return Promise.resolve();
    },
    hooks: {
      onDidRestore: {
        register: (id: string, hook: RestoreHook) => {
          restoreHooks.set(id, hook);
          return { dispose: () => {} };
        },
      },
    },
  } as unknown as IEventDispatcher;
  const metadataUpdates: { environmentId?: string; environmentCwd?: string }[] = [];
  const metadata = {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    read: async () => ({
      id: 'session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      ...options.persistedBinding,
    }),
    update: async (patch: { environmentId?: string; environmentCwd?: string }) => {
      metadataUpdates.push(patch);
    },
  } as unknown as ISessionMetadata;
  const environmentDeclarations = {
    _serviceBrand: undefined,
    declarations: async () => ({ entries: [{ id: 'remote' }] }),
  } as unknown as IEnvironmentDeclarationService;
  const workDirWrites: string[] = [];
  const workspaceContext = stubWorkspaceContext(session.cwd, workDirWrites);
  const busHandlers = new Map<string, ((event: { readonly agentId?: string }) => void)[]>();
  const published: { readonly type: string; readonly environmentId?: string; readonly status?: string }[] = [];
  const eventBus = {
    subscribe: (cls: { readonly type: string }, handler: (event: { readonly agentId?: string }) => void) => {
      const handlers = busHandlers.get(cls.type) ?? [];
      handlers.push(handler);
      busHandlers.set(cls.type, handlers);
      return { dispose: () => {} };
    },
    isAgentActive: () => true,
    publish: (event: { readonly type: string; readonly environmentId?: string; readonly status?: string }) => {
      published.push(event);
    },
  } as unknown as ISessionEventBus;
  const publishBus = (type: string, event: { readonly agentId?: string }): void => {
    for (const handler of busHandlers.get(type) ?? []) handler(event);
  };
  const reminders: { content: string; variant: string }[] = [];
  const reminder = stubReminder(reminders);
  const sessionState = new SessionStateService();
  sessionState.contributeState(workspaceContextWorkDirKey);
  sessionState.contributeState(workspaceContextAdditionalDirsKey);
  sessionState.set(workspaceContextWorkDirKey, session.cwd);
  const makeAgent = (agentId: string) => {
    const agentScopeContext = stubScopeContext(agentId);
    const agentState = new AgentStateService();
    const agentBinding = new AgentEnvironmentBindingService(
      agentScopeContext,
      agentState,
      { _serviceBrand: undefined, binding: options.seedBinding ?? { environmentId: 'local' } },
      session,
      workspaceContext,
      resolver,
      dispatcher,
      reminder,
      noopLogger,
      stubBootstrap(),
      metadata,
      environmentDeclarations,
    );
    return {
      binding: agentBinding,
      agentEnvironment: new AgentEnvironmentService(agentScopeContext, agentBinding, registry as unknown as IEnvironmentService, eventBus, session, sessionState),
      state: agentState,
    };
  };
  const main = makeAgent(options.agentId ?? 'main');
  const state = main.state;
  return {
    registry,
    resolver,
    state,
    binding: main.binding,
    local,
    remote,
    localRegistration,
    dispatched,
    restoreHooks,
    workDirWrites,
    publishBus,
    published,
    sessionState,
    reminders,
    metadataUpdates,
    makeAgent,
    agentEnvironment: main.agentEnvironment,
  };
}

describe('AgentEnvironmentBindingService', () => {
  it('persists a changed main-agent binding and a restore that disagrees with session meta', async () => {
    const switched = setup();
    switched.binding.bind('remote', '/remote/work');
    await vi.waitFor(() => {
      expect(switched.metadataUpdates).toEqual([{ environmentId: 'remote', environmentCwd: '/remote/work' }]);
    });

    const restored = setup({
      persistedBinding: { environmentId: 'remote', environmentCwd: '/remote/work' },
    });
    restored.state.set(environmentBindingKey, { environmentId: 'local' });
    await restored.restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    expect(restored.metadataUpdates).toEqual([{ environmentId: 'local', environmentCwd: undefined }]);

    const unchanged = setup({
      persistedBinding: { environmentId: 'remote', environmentCwd: '/remote/work' },
    });
    unchanged.state.set(environmentBindingKey, { environmentId: 'remote', cwd: '/remote/work' });
    await unchanged.restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    expect(unchanged.metadataUpdates).toEqual([]);
  });

  it('does not persist a binding to an environment that is not declared', async () => {
    const { registry, binding, metadataUpdates } = setup();
    registry.register(environment('acp:s1', 'acp-one', 'ready', ['process'], REMOTE_HOST));

    binding.bind('acp:s1', '/remote/work');
    await flushProbe();

    expect(metadataUpdates).toEqual([]);
  });

  it('switches only after the target can be acquired and emits the committed binding', () => {
    const { binding } = setup();
    const changes: EnvironmentBinding[] = [];
    binding.onDidChange((next) => changes.push(next));

    expect(binding.bind('remote')).toEqual({ environmentId: 'remote' });
    expect(binding.current).toEqual({ environmentId: 'remote' });
    expect(changes).toEqual([{ environmentId: 'remote' }]);
  });

  it('keeps the prior binding for missing and unavailable targets without fallback', () => {
    const { registry, binding } = setup();
    registry.register(environment('offline', 'offline-one', 'disconnected'));

    expect(() => binding.bind('missing')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
    expect(() => binding.bind('offline')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(binding.current).toEqual({ environmentId: 'local' });
  });


  it('pins old leases while new calls use the switched environment', () => {
    const { binding, agentEnvironment } = setup();
    const oldLease = agentEnvironment.acquire();
    binding.bind('remote');
    const newLease = agentEnvironment.acquire();

    expect(oldLease.environment.identity).toMatchObject({ environmentId: 'local', generation: 'local-one' });
    expect(newLease.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    oldLease.dispose();
    newLease.dispose();
  });

  it('persists no generation and resolves the current generation after re-registration', async () => {
    const { registry, state, binding, agentEnvironment } = setup();
    binding.bind('remote');
    const registration = registry.register(environment('replaceable', 'one'));
    binding.bind('replaceable');
    await registration.remove();
    registry.register(environment('replaceable', 'two'));

    expect(state.get(agentEnvironmentBindingKey)).toEqual({
      environmentId: 'replaceable',
    });
    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity.generation).toBe('two');
    lease.dispose();
  });

  it('updates capability availability when the binding switches environments', () => {
    const { binding, agentEnvironment } = setup();
    const changes: void[] = [];
    agentEnvironment.onDidChange(() => changes.push(undefined));

    expect(agentEnvironment.isAvailable(['fs'])).toBe(true);
    expect(agentEnvironment.isAvailable(['process'])).toBe(true);

    binding.bind('remote');

    expect(changes).toHaveLength(1);
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    expect(agentEnvironment.isAvailable(['process'])).toBe(true);
  });

  it('snapshots the binding switch and current environment generation', () => {
    const { binding, agentEnvironment } = setup();

    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toEqual({
      binding: { environmentId: 'local' },
      available: true,
      environment: {
        environmentId: 'local',
        generation: 'local-one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      },
    });

    binding.bind('remote');
    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toMatchObject({
      binding: { environmentId: 'remote' },
      available: true,
      environment: { environmentId: 'remote', generation: 'remote-one' },
    });
  });

  it('forwards the bound environment connectError into the snapshot', () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.bind('remote');
    remote.setStatus('disconnected');
    remote.connectError = 'executor process exited before the handshake completed (code 255): ssh: connect failed';

    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toMatchObject({
      binding: { environmentId: 'remote' },
      available: false,
      environment: {
        environmentId: 'remote',
        status: 'disconnected',
        connectError: 'executor process exited before the handshake completed (code 255): ssh: connect failed',
      },
    });
  });

  it('tracks environment changes independently of workspace instances', () => {
    const { local, agentEnvironment } = setup();
    const changes: void[] = [];
    agentEnvironment.onDidChange(() => changes.push(undefined));

    local.setStatus('disconnected');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('ready');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(true);

    expect(changes).toHaveLength(2);
  });

  it('publishes a environment status hint when the bound environment changes status', () => {
    const { local, remote, binding, published } = setup();
    binding.bind('remote');

    remote.setStatus('disconnected');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'environment.status.changed',
      environmentId: 'remote',
      status: 'disconnected',
    });

    published.length = 0;
    local.setStatus('disconnected');
    expect(published).toEqual([]);
  });

  it('does not publish environment status hints for a non-main agent', () => {
    const { remote, binding, published } = setup({ agentId: 'agent-1' });
    binding.bind('remote');
    remote.setStatus('disconnected');
    expect(published).toEqual([]);
  });

  it('applies the shared status gate to every environment lifecycle state', () => {
    const { local, agentEnvironment } = setup();

    local.setStatus('connecting');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('disconnected');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('disposed');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
  });

  it('tracks the re-registered generation without observing the drained generation', async () => {
    const { registry, local, localRegistration, agentEnvironment } = setup();
    const changes: void[] = [];
    agentEnvironment.onDidChange(() => changes.push(undefined));

    await localRegistration.remove();
    registry.register(environment('local', 'local-two', 'ready', ['process']));

    expect(changes).toHaveLength(2);
    expect(agentEnvironment.inspect().identity.generation).toBe('local-two');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    expect(agentEnvironment.isAvailable(['process'])).toBe(true);
    local.setStatus('ready');
    expect(changes).toHaveLength(2);
  });

  it('carries cwd through switch and the persisted op payload', () => {
    const { binding, dispatched } = setup();

    expect(binding.bind('remote', '/remote/work')).toEqual({
      environmentId: 'remote',
      cwd: '/remote/work',
    });
    expect(binding.current.cwd).toBe('/remote/work');
    expect(dispatched.at(-1)).toMatchObject({
      environmentId: 'remote',
      cwd: '/remote/work',
    });

    binding.bind('local');
    expect(binding.current).toEqual({ environmentId: 'local', cwd: undefined });
    expect(dispatched.at(-1)).toMatchObject({ environmentId: 'local' });
  });

  it('pushes the effective workDir to the session context for the main agent', async () => {
    const { binding, workDirWrites, restoreHooks } = setup();

    binding.bind('remote', '/remote/work');
    expect(workDirWrites).toEqual(['/remote/work']);

    binding.bind('local');
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);

    workDirWrites.length = 0;
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    expect(workDirWrites).toEqual(['/workspace']);
  });

  it('does not push workDir for non-main agents', () => {
    const { binding, workDirWrites } = setup({ agentId: 'agent-1' });
    binding.bind('remote', '/remote/work');
    expect(workDirWrites).toEqual([]);
  });

  it('keeps turn acquires working when another session switches cwd on the pinned environment', async () => {
    const { binding, agentEnvironment, registry, makeAgent } = setup();
    connectableEnvironment(registry, { environmentId: 'shared', status: 'ready' });
    binding.bind('shared', '/remote/work');

    const other = makeAgent('agent-2');
    other.binding.bind('shared', '/remote/other');

    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity).toMatchObject({ environmentId: 'shared', generation: 'shared-pending' });
    lease.dispose();
  });

  it('replays the restored binding without reconnecting and raises unavailable on first acquire', async () => {
    const { state, remote, restoreHooks, binding, agentEnvironment, workDirWrites } = setup();
    state.set(environmentBindingKey, { environmentId: 'remote', cwd: '/remote/work' });
    remote.setStatus('disconnected');

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ environmentId: 'remote', cwd: '/remote/work' });
    expect(workDirWrites).toEqual(['/remote/work']);
    expect(() => agentEnvironment.acquire()).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(binding.current.environmentId).toBe('remote');
  });
});

describe('AgentEnvironmentBindingService restore from wire records', () => {
  it('does not reseed a remote binding from raw wire records that replay excluded', async () => {
    const { binding, restoreHooks, dispatched, reminders } = setup({ agentId: 'agent-1' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ environmentId: 'local' });
    expect(dispatched.at(-1)).toMatchObject({ agentId: 'agent-1', environmentId: 'local' });
    expect(reminders).toEqual([]);
  });

  it('emits the seed environment reminder when a remote seed round-trips through a replayed op', async () => {
    const { state, restoreHooks, reminders } = setup({
      seedBinding: { environmentId: 'remote', cwd: '/remote/work' },
    });
    state.set(environmentBindingKey, { environmentId: 'remote', cwd: '/remote/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.variant).toBe(ENVIRONMENT_BINDING_REMINDER_VARIANT);
  });
});

describe('AgentEnvironmentBindingService environment reminder', () => {
  it('emits no reminder for a local create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders } = setup();

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('emits the seed binding environment for a remote create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders } = setup({
      seedBinding: { environmentId: 'remote', cwd: '/remote/work' },
    });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.content).toBe(reminderText('remote', REMOTE_HOST, '/remote/work'));
  });

  it('emits no reminder when the binding is restored from a replayed op', async () => {
    const { state, restoreHooks, reminders } = setup();
    state.set(environmentBindingKey, { environmentId: 'remote', cwd: '/remote/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('does not emit reminders for non-main agents', () => {
    const { binding, reminders } = setup({ agentId: 'agent-1' });

    binding.bind('remote', '/remote/work');

    expect(reminders).toHaveLength(0);
  });
});

function probeFs(files: Record<string, string>, directories: readonly string[] = []): IHostFileSystem {
  const stat = vi.fn(async (path: string): Promise<HostFileStat> => {
    const content = files[path];
    if (content !== undefined) return { isFile: true, isDirectory: false, size: content.length };
    if (directories.includes(path)) return { isFile: false, isDirectory: true, size: 0 };
    throw new Error(`missing: ${path}`);
  });
  const readText = vi.fn(async (path: string): Promise<string> => {
    const content = files[path];
    if (content === undefined) throw new Error(`missing: ${path}`);
    return content;
  });
  return { stat, lstat: stat, readText } as unknown as IHostFileSystem;
}

function probingEnvironment(
  environmentId: string,
  host: Partial<Environment['host']>,
  fs: IHostFileSystem,
): FakeEnvironment {
  const fake = new FakeEnvironment(
    { environmentId, generation: `${environmentId}-one` },
    { status: 'ready', capabilities: ['fs', 'process'], host },
  );
  return Object.assign(fake, { fs, process: {} });
}

function flushProbe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function projectContextReminders(
  reminders: readonly { content: string; variant: string }[],
): { content: string; variant: string }[] {
  return reminders.filter((reminder) => reminder.variant === PROJECT_CONTEXT_REMINDER_VARIANT);
}

describe('AgentEnvironmentBindingService project context reminder', () => {
  it('injects the probed AGENTS.md path chain with supersession text on the first switch to a remote view', async () => {
    const { registry, binding, reminders } = setup();
    const fs = probeFs(
      {
        '/remote/work/AGENTS.md': 'remote root instructions',
        '/remote/work/sub/AGENTS.md': 'remote sub instructions',
      },
      ['/remote/work/.git'],
    );
    registry.register(probingEnvironment('remote-view', REMOTE_HOST, fs));

    binding.bind('remote-view', '/remote/work/sub');
    await flushProbe();

    expect(reminders.map((reminder) => reminder.variant)).toEqual([
      PROJECT_CONTEXT_REMINDER_VARIANT,
    ]);
    expect(projectContextReminders(reminders)[0]!.content).toBe(
      'The active project context is now "remote-view" at working directory /remote/work/sub. ' +
        'Previous working directories, AGENTS.md instructions, and environment details no longer apply. ' +
        'The AGENTS.md file(s) below apply to this working directory:\n' +
        '- /remote/work/AGENTS.md\n' +
        '- /remote/work/sub/AGENTS.md\n' +
        'Read them before making changes in this working directory.',
    );
  });

  it('injects on a remote to same-host remote switch because the view is new', async () => {
    const { registry, binding, reminders } = setup();
    registry.register(
      probingEnvironment('remote-one', REMOTE_HOST, probeFs({ '/remote/one/AGENTS.md': 'one' }, ['/remote/one/.git'])),
    );
    registry.register(
      probingEnvironment('remote-two', REMOTE_HOST, probeFs({ '/remote/two/AGENTS.md': 'two' }, ['/remote/two/.git'])),
    );

    binding.bind('remote-one', '/remote/one');
    await flushProbe();
    binding.bind('remote-two', '/remote/two');
    await flushProbe();

    const injected = projectContextReminders(reminders);
    expect(injected).toHaveLength(2);
    expect(injected[1]!.content).toContain('"remote-two"');
    expect(injected[1]!.content).toContain('- /remote/two/AGENTS.md');
  });

  it('injects the local paths when a session created remote switches to local for the first time', async () => {
    const { binding, local, reminders } = setup({
      seedBinding: { environmentId: 'remote', cwd: '/remote/work' },
    });
    Object.assign(local, { fs: probeFs({ '/workspace/AGENTS.md': 'local instructions' }, ['/workspace/.git']) });

    binding.bind('local');
    await flushProbe();

    const injected = projectContextReminders(reminders);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.content).toContain('"local"');
    expect(injected[0]!.content).toContain('at working directory /workspace');
    expect(injected[0]!.content).toContain('- /workspace/AGENTS.md');
  });

  it('injects on a local to local switch when the cwd view was never visited, without the environment reminder', async () => {
    const { binding, local, reminders } = setup();
    Object.assign(local, { fs: probeFs({ '/other/AGENTS.md': 'other instructions' }, ['/other/.git']) });

    binding.bind('local', '/other');
    await flushProbe();

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.variant).toBe(PROJECT_CONTEXT_REMINDER_VARIANT);
    expect(reminders[0]!.content).toContain('at working directory /other');
    expect(reminders[0]!.content).toContain('- /other/AGENTS.md');
  });

  it('injects nothing when the new view has no AGENTS.md files', async () => {
    const { registry, binding, reminders } = setup();
    registry.register(probingEnvironment('bare-remote', REMOTE_HOST, probeFs({})));

    binding.bind('bare-remote', '/bare/work');
    await flushProbe();

    expect(projectContextReminders(reminders)).toHaveLength(0);
  });

  it('does not inject for non-main agents', async () => {
    const { registry, binding, reminders } = setup({ agentId: 'agent-1' });
    const fs = probeFs({ '/remote/work/AGENTS.md': 'remote instructions' }, ['/remote/work/.git']);
    registry.register(probingEnvironment('remote-view', REMOTE_HOST, fs));

    binding.bind('remote-view', '/remote/work');
    await flushProbe();

    expect(reminders).toHaveLength(0);
  });
});

describe('AgentEnvironmentService workspaceRoots', () => {
  it('resolves the workDir from the binding cwd, host cwd, host homeDir, or session cwd', () => {
    const localDefaults = setup();
    expect(localDefaults.agentEnvironment.workspaceRoots().workDir).toBe('/workspace');

    const hostCwd = setup();
    hostCwd.registry.register(environment('remote-cwd', 'remote-cwd-one', 'ready', ['process'], {
      ...REMOTE_HOST,
      cwd: '/remote/initial',
    }));
    hostCwd.binding.bind('remote-cwd');
    expect(hostCwd.agentEnvironment.workspaceRoots().workDir).toBe('/remote/initial');

    const homeDir = setup();
    homeDir.binding.bind('remote');
    expect(homeDir.agentEnvironment.workspaceRoots().workDir).toBe('/home/fake');

    const bindingCwd = setup();
    bindingCwd.binding.bind('remote', '/remote/work');
    expect(bindingCwd.agentEnvironment.workspaceRoots().workDir).toBe('/remote/work');

    const uninspectable = setup({
      seedBinding: { environmentId: 'ghost' },
    });
    expect(uninspectable.agentEnvironment.workspaceRoots().workDir).toBe('/workspace');
  });
});

describe('acquireOrWhenReady', () => {
  it('returns the current environment lease when it is already available', async () => {
    const { agentEnvironment } = setup();

    const lease = await acquireOrWhenReady(agentEnvironment, ['fs']);

    expect(lease.environment.identity).toMatchObject({ environmentId: 'local', generation: 'local-one' });
    lease.dispose();
  });

  it('rejects through the readiness path when a required capability is missing', async () => {
    const { binding, agentEnvironment } = setup();
    binding.bind('remote');

    await expect(acquireOrWhenReady(agentEnvironment, ['fs'])).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.capability_unavailable' }),
    );
  });

  it('connects a disconnected environment through the whenReady path', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectableEnvironment(registry, { environmentId: 'remote-x', status: 'disconnected' });
    state.set(environmentBindingKey, { environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    const lease = await acquireOrWhenReady(agentEnvironment, ['fs']);

    expect(calls).toEqual(['connect']);
    expect(lease.environment.status).toBe('ready');
    lease.dispose();
  });
});

describe('AgentEnvironmentService on-demand connect', () => {
  function connectSwappingEnvironment(
    registry: EnvironmentRegistry,
    environmentId: string,
    options: { readonly failFirst?: boolean } = {},
  ): { readonly calls: string[]; readonly registration: EnvironmentRegistrationHandle } {
    const calls: string[] = [];
    let attempts = 0;
    let registration: EnvironmentRegistrationHandle;
    const pending = new FakeEnvironment(
      { environmentId, generation: `${environmentId}-pending` },
      { status: 'disconnected', capabilities: ['fs', 'process'] },
    );
    registration = registry.register(Object.assign(pending, {
      fs: {},
      process: {},
      connect: async () => {
        calls.push('connect');
        attempts += 1;
        if (options.failFirst === true && attempts === 1) throw new Error('connect failed');
        await registration.remove();
        registry.register(Object.assign(new FakeEnvironment(
          { environmentId, generation: `${environmentId}-ready` },
          { status: 'ready', capabilities: ['fs', 'process'] },
        ), { fs: {}, process: {} }));
      },
    }));
    return { calls, registration };
  }

  it('connects a restored disconnected environment on the first acquireWhenReady and keeps serving the turn', async () => {
    const { registry, state, restoreHooks, agentEnvironment, publishBus } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    publishBus('turn.started', { agentId: 'main' });

    expect(calls).toEqual([]);
    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    expect(lease.environment.status).toBe('ready');
    lease.dispose();

    const next = agentEnvironment.acquire(['fs']);
    expect(next.environment.identity.generation).toBe('remote-x-ready');
    next.dispose();
    publishBus('turn.ended', { agentId: 'main' });
  });

  it('adopts the generation another session connected before the first turn acquire without reconnecting', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    await registry.current('remote-x')!.connect!();
    expect(calls).toEqual(['connect']);

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    lease.dispose();

    const next = agentEnvironment.acquire(['fs']);
    expect(next.environment.identity.generation).toBe('remote-x-ready');
    next.dispose();
  });

  it('propagates a failed on-demand connect and retries on the next call', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x', { failFirst: true });
    state.set(environmentBindingKey, { environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    await expect(agentEnvironment.acquireWhenReady(['fs'])).rejects.toThrow('connect failed');

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect', 'connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    lease.dispose();
  });
});
