import { describe, expect, it, vi } from 'vitest';

import type { ISessionEventBus } from '#/app/event/eventBus';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import '#/agent/contextMemory/conversationTime';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { AgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import { AgentEnvironmentBindingService, PROJECT_CONTEXT_REMINDER_VARIANT } from '#/agent/environmentBinding/environmentBindingService';
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
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import { IEnvironmentService, type EnvironmentResolver } from '#/app/environment/environment';
import { stubAgentContext } from '../agentContext/stubs';
import { noopLogger } from '../../wire/stubs';
import { fakeEnvironment } from '../../environment/stubs';

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
    makeAgent,
    agentEnvironment: main.agentEnvironment,
  };
}

describe('AgentEnvironmentBindingService', () => {
  it.each(['C:\\repo\\src'])('restores native Windows ACP cwd %s without POSIX normalization', async (cwd) => {
    const restored = setup({ seedBinding: { environmentId: 'acp:example', cwd } });
    restored.registry.register(environment('acp:example', 'acp-one', 'ready', ['process'], { ...LOCAL_HOST, pathClass: 'win32' }));
    restored.state.set(environmentBindingKey, { environmentId: 'acp:example', cwd });
    await restored.restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    expect(restored.binding.current).toEqual({ environmentId: 'acp:example', cwd });
    expect(restored.workDirWrites).toEqual([cwd]);
    restored.agentEnvironment.acquire().dispose();
    await restored.registry.dispose();
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
