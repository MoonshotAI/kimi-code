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
import type { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import type { IFlagService } from '#/app/flag/flag';
import { MULTI_ENVIRONMENT_FLAG_ID } from '#/agent/environmentBinding/flag';
import { AgentEnvironmentRosterService, ENVIRONMENT_ROSTER_REMINDER_VARIANT } from '#/agent/environmentBinding/environmentRoster';
import {
  SessionEnvironmentMountsService,
  type EnvironmentMount,
  type ISessionEnvironmentMounts,
} from '#/session/environmentMounts/environmentMounts';
import { InMemorySkillCatalog } from '#/features/skill/catalog/registry';
import type { SkillContribution } from '#/features/skill/catalog/skillSource';
import type { ISessionSkillCatalog } from '#/features/skill/session/skillCatalog';
import type { IWorkspaceSkillCatalog } from '#/features/skill/workspace/workspaceSkillCatalog';
import type { ISessionInstructionsProvider } from '#/session/sessionInstructions/instructionsProvider';
import type { ISessionWorkdir, SessionEnvironmentWorkdir } from '#/session/workdir/workdir';
import type { IWorkspaceInstructionsService } from '#/workspace/workspaceInstructions/workspaceInstructions';
import { stubSkill } from '../../features/skill/catalog/stubs';
import type { ContextInjectionContext, ContextInjectionProvider, ContextInjectionResult } from '#/features/reminder/types';
import type { RemoteEnvironmentEntry } from '#/remote/declaration/remoteEnvironmentDeclaration';
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

interface MultiEnvironmentOptions {
  readonly enabled?: boolean;
  readonly declarations: readonly { readonly id: string; readonly defaultCwd?: string }[];
}

function multiEnvironmentServices(options: MultiEnvironmentOptions | undefined): {
  readonly flags?: IFlagService;
  readonly declarations?: IEnvironmentDeclarationService;
} {
  if (options === undefined) return {};
  return {
    flags: { enabled: (id: string) => id === MULTI_ENVIRONMENT_FLAG_ID && options.enabled !== false } as unknown as IFlagService,
    declarations: {
      snapshot: () => ({
        entries: options.declarations.map((declaration) => ({
          id: declaration.id,
          entry: { type: 'ssh', host: declaration.id, defaultCwd: declaration.defaultCwd } as RemoteEnvironmentEntry,
        })),
      }),
    } as unknown as IEnvironmentDeclarationService,
  };
}

function setup(options: {
  agentId?: string;
  sessionCwd?: string;
  seedBinding?: EnvironmentBinding;
  multiEnvironment?: MultiEnvironmentOptions;
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
    const multi = multiEnvironmentServices(options.multiEnvironment);
    return {
      binding: agentBinding,
      agentEnvironment: new AgentEnvironmentService(
        agentScopeContext,
        agentBinding,
        registry as unknown as IEnvironmentService,
        eventBus,
        session,
        sessionState,
        multi.flags,
        multi.declarations,
      ),
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

describe('AgentEnvironmentService multi-environment targets', () => {
  it('exposes only the primary binding while the flag is off', () => {
    const { agentEnvironment } = setup({
      multiEnvironment: { enabled: false, declarations: [{ id: 'remote', defaultCwd: '/srv/app' }] },
    });

    expect(agentEnvironment.targets()).toEqual([{ environmentId: 'local', primary: true, cwd: undefined }]);
    expect(() => agentEnvironment.acquire([], 'remote')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
  });

  it('routes declared environments to their own environment and default working directory', () => {
    const { agentEnvironment, registry, sessionState } = setup({
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app/' }] },
    });
    sessionState.set(workspaceContextAdditionalDirsKey, ['/workspace-extra']);
    registry.register(environment('acp:other-session', 'acp-one', 'ready', ['fs', 'process']));

    expect(agentEnvironment.targets()).toEqual([
      { environmentId: 'local', primary: true, cwd: undefined },
      { environmentId: 'remote', primary: false, cwd: '/srv/app/' },
    ]);
    const lease = agentEnvironment.acquire(['process'], 'remote');
    expect(lease.environment.identity.environmentId).toBe('remote');
    lease.dispose();
    expect(agentEnvironment.workspaceRoots('remote')).toEqual({ workDir: '/srv/app', additionalDirs: [] });
    expect(agentEnvironment.workspaceRoots()).toEqual({ workDir: '/workspace', additionalDirs: ['/workspace-extra'] });
    expect(() => agentEnvironment.acquire([], 'acp:other-session')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
  });

  it('offers local beside a declared remote primary and resolves it to the session directory', () => {
    const { agentEnvironment } = setup({
      seedBinding: { environmentId: 'remote', cwd: '/srv/app' },
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app' }] },
    });

    expect(agentEnvironment.targets()).toEqual([
      { environmentId: 'remote', primary: true, cwd: '/srv/app' },
      { environmentId: 'local', primary: false, cwd: '/workspace' },
    ]);
    expect(agentEnvironment.workspaceRoots('local')).toEqual({ workDir: '/workspace', additionalDirs: [] });
  });

  it('keeps a session-private primary isolated from other environments', () => {
    const { agentEnvironment, registry } = setup({
      seedBinding: { environmentId: 'acp:session', cwd: '/workspace' },
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app' }] },
    });
    registry.register(environment('acp:session', 'acp-session-one', 'ready', ['fs', 'process']));

    expect(agentEnvironment.targets()).toEqual([{ environmentId: 'acp:session', primary: true, cwd: '/workspace' }]);
  });

  it('rejects a relative default working directory instead of guessing one', () => {
    const { agentEnvironment } = setup({
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: 'relative/dir' }] },
    });

    expect(() => agentEnvironment.acquire([], 'remote')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.invalid_cwd' }),
    );
  });

  it('falls back to the connected host directory when no default working directory is declared', () => {
    const { agentEnvironment } = setup({ multiEnvironment: { declarations: [{ id: 'remote' }] } });

    expect(agentEnvironment.workspaceRoots('remote').workDir).toBe('/home/fake');
  });
});

const ROSTER_GUIDANCE =
  'Tools with an `environment` argument run in the environment you name; omit it to use the primary environment. ' +
  'Each environment has its own files, shell, and installed programs, and relative paths resolve against its working directory. ' +
  'A remote environment connects on its first use; if it cannot connect, the call fails instead of running elsewhere. ' +
  "The system prompt's working directory, AGENTS.md instructions, and skills describe the primary environment. " +
  'Once another environment connects, the AGENTS.md files found there are listed under it; read them before changing files in that environment. ' +
  'Skills found in another environment are named `<skill>@<environment>`.';

function stubMounts(results: Record<string, EnvironmentMount> = {}) {
  const calls: { readonly environmentId: string; readonly cwd: string }[] = [];
  const mounts: ISessionEnvironmentMounts = {
    _serviceBrand: undefined,
    mount: (environmentId: string, cwd: string) => {
      calls.push({ environmentId, cwd });
      return Promise.resolve(results[environmentId] ?? { status: 'mounted', agentsMdPaths: [] });
    },
  };
  return { mounts, calls };
}

describe('AgentEnvironmentRosterService', () => {
  function rosterProvider(
    agentEnvironment: ConstructorParameters<typeof AgentEnvironmentRosterService>[1],
    mounts: ISessionEnvironmentMounts = stubMounts().mounts,
  ) {
    let provider: ContextInjectionProvider<string> | undefined;
    const reminder = {
      _serviceBrand: undefined,
      register: (variant: string, registered: ContextInjectionProvider<string>) => {
        expect(variant).toBe(ENVIRONMENT_ROSTER_REMINDER_VARIANT);
        provider = registered;
        return { dispose: () => {} };
      },
    } as unknown as IAgentReminderService;
    const roster = new AgentEnvironmentRosterService(reminder, agentEnvironment, mounts);
    const provide = async (context: Partial<ContextInjectionContext<string>>) =>
      (await provider!({ injectedPositions: [], lastInjectedAt: null, isNewTurn: true, ...context })) as
        | ContextInjectionResult<string>
        | undefined;
    return { roster, provide };
  }

  it('lists every environment once and repeats only after the roster changes or leaves the context', async () => {
    const { agentEnvironment, registry } = setup({
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app' }, { id: 'staging' }, { id: 'unregistered' }] },
    });
    registry.register(environment('staging', 'staging-one', 'pending'));
    const { mounts, calls } = stubMounts();
    const { provide } = rosterProvider(agentEnvironment, mounts);

    const first = await provide({});
    expect(first?.content).toBe(
      [
        'Execution environments available in this session:',
        '- `local` (primary): working directory /workspace',
        '- `remote`: working directory /srv/app',
        '- `staging`: not connected yet; working directory resolved on first use',
        ROSTER_GUIDANCE,
      ].join('\n'),
    );
    const injected = { role: 'user' as const, content: [] };
    expect(await provide({ lastInjection: injected, lastDisclosure: first?.disclosure })).toBeUndefined();
    expect((await provide({ lastDisclosure: first?.disclosure }))?.content).toBe(first?.content);
    expect(calls).toEqual([{ environmentId: 'remote', cwd: '/srv/app' }]);
  });

  it('shows the declared working directory of an environment that has not connected yet', async () => {
    const { agentEnvironment, registry } = setup({
      multiEnvironment: { declarations: [{ id: 'staging', defaultCwd: '/srv/staging' }] },
    });
    registry.register(environment('staging', 'staging-one', 'pending'));
    const { mounts, calls } = stubMounts();
    const { provide } = rosterProvider(agentEnvironment, mounts);

    expect((await provide({}))?.content).toContain('- `staging`: working directory /srv/staging; not connected yet');
    expect(calls).toEqual([]);
  });

  it('mounts an environment once it connects, lists its AGENTS.md files, and keeps them across disconnects', async () => {
    const { agentEnvironment, registry } = setup({
      multiEnvironment: { declarations: [{ id: 'staging' }] },
    });
    const staging = environment('staging', 'staging-one', 'pending', [], { cwd: '/home/deploy' });
    registry.register(staging);
    const { mounts, calls } = stubMounts({
      staging: { status: 'mounted', agentsMdPaths: ['/home/deploy/AGENTS.md', '/home/deploy/api/AGENTS.md'] },
    });
    const { provide } = rosterProvider(agentEnvironment, mounts);
    const injected = { role: 'user' as const, content: [] };

    const before = await provide({});
    expect(before?.content).toContain('- `staging`: not connected yet; working directory resolved on first use');

    staging.setStatus('ready');
    const connected = await provide({ lastInjection: injected, lastDisclosure: before?.disclosure });
    expect(connected?.content).toBe(
      [
        'Execution environment updates:',
        '- `staging`: working directory /home/deploy',
        '  - AGENTS.md: /home/deploy/AGENTS.md',
        '  - AGENTS.md: /home/deploy/api/AGENTS.md',
        'Read the AGENTS.md files listed above before changing files in that environment.',
      ].join('\n'),
    );

    staging.setStatus('disconnected');
    expect(await provide({ lastInjection: injected, lastDisclosure: connected?.disclosure })).toBeUndefined();
    expect(calls).toEqual([{ environmentId: 'staging', cwd: '/home/deploy' }]);
  });

  it('sends only the environments that left since the last roster', async () => {
    const { agentEnvironment, registry } = setup({
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app' }, { id: 'staging' }] },
    });
    const staging = registry.register(environment('staging', 'staging-one', 'pending'));
    const { provide } = rosterProvider(agentEnvironment);
    const injected = { role: 'user' as const, content: [] };

    const first = await provide({});
    await staging.remove();

    expect(await provide({ lastInjection: injected, lastDisclosure: first?.disclosure })).toEqual({
      content: ['Execution environment updates:', '- `staging` is no longer available.'].join('\n'),
      disclosure: {
        local: '- `local` (primary): working directory /workspace',
        remote: '- `remote`: working directory /srv/app',
      },
    });
  });

  it('reports an environment whose project context could not be loaded', async () => {
    const { agentEnvironment } = setup({
      multiEnvironment: { declarations: [{ id: 'remote', defaultCwd: '/srv/app' }] },
    });
    const { mounts } = stubMounts({ remote: { status: 'failed', error: 'cwd /srv/app is not a directory' } });
    const { provide } = rosterProvider(agentEnvironment, mounts);

    expect((await provide({}))?.content).toContain(
      '- `remote`: working directory /srv/app; its AGENTS.md files and skills could not be loaded: cwd /srv/app is not a directory',
    );
  });

  it('withdraws the roster once only the primary environment remains', async () => {
    const { agentEnvironment } = setup({
      multiEnvironment: { enabled: false, declarations: [{ id: 'remote', defaultCwd: '/srv/app' }] },
    });
    const { mounts, calls } = stubMounts();
    const { provide } = rosterProvider(agentEnvironment, mounts);
    const injected = { role: 'user' as const, content: [] };

    expect(await provide({})).toBeUndefined();
    expect(await provide({ lastInjection: injected, lastDisclosure: '- `local` (primary): working directory /workspace' })).toEqual({
      content: 'Only the primary environment `local` is available now. Tools no longer take an `environment` argument.',
      disclosure: 'single',
    });
    expect(await provide({ lastInjection: injected, lastDisclosure: 'single' })).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe('SessionEnvironmentMountsService', () => {
  function setupMounts(options: {
    readonly acquire?: (environmentId: string, cwd: string) => Promise<SessionEnvironmentWorkdir>;
    readonly primaryAgentsMdPaths?: readonly string[];
  } = {}) {
    const contributions = new Map<string, SkillContribution>();
    const acquired: { readonly environmentId: string; readonly cwd: string }[] = [];
    let disposedWorkdirs = 0;
    const environmentCatalog = new InMemorySkillCatalog();
    environmentCatalog.register(stubSkill('deploy', { source: 'project', dir: '/srv/app/.agents/skills/deploy' }));
    environmentCatalog.register(stubSkill('notes', { source: 'user' }));
    const defaultWorkdir: SessionEnvironmentWorkdir = {
      skills: { catalog: environmentCatalog, load: async () => {} } as unknown as IWorkspaceSkillCatalog,
      instructions: {
        ready: Promise.resolve(),
        snapshot: {
          agentsMd: undefined,
          agentsMdWarning: undefined,
          agentsMdPaths: ['/kimi-home/AGENTS.md', '/srv/app/AGENTS.md'],
        },
      } as unknown as IWorkspaceInstructionsService,
      dispose: () => {
        disposedWorkdirs += 1;
      },
    };
    const workdir = {
      _serviceBrand: undefined,
      environmentId: 'local',
      acquireEnvironmentWorkdir: (environmentId: string, cwd: string) => {
        acquired.push({ environmentId, cwd });
        return options.acquire?.(environmentId, cwd) ?? Promise.resolve(defaultWorkdir);
      },
    } as unknown as ISessionWorkdir;
    const catalog = {
      set: (id: string, contribution: SkillContribution) => {
        contributions.set(id, contribution);
      },
    } as unknown as ISessionSkillCatalog;
    const instructions = {
      ready: Promise.resolve(),
      agentsMdPaths: options.primaryAgentsMdPaths ?? ['/kimi-home/AGENTS.md', '/workspace/AGENTS.md'],
    } as unknown as ISessionInstructionsProvider;
    const service = new SessionEnvironmentMountsService(workdir, catalog, instructions);
    return { service, contributions, acquired, disposedWorkdirs: () => disposedWorkdirs };
  }

  it('adds the project skills of a mounted environment under an environment-qualified name', async () => {
    const { service, contributions } = setupMounts();

    await service.mount('remote', '/srv/app');

    const skills = contributions.get('environment:remote')?.skills ?? [];
    expect(skills.map((skill) => [skill.name, skill.environmentId, skill.dir])).toEqual([
      ['deploy@remote', 'remote', '/srv/app/.agents/skills/deploy'],
    ]);
  });

  it('lists only the AGENTS.md files the primary environment did not already load', async () => {
    const { service } = setupMounts();

    await expect(service.mount('remote', '/srv/app')).resolves.toEqual({
      status: 'mounted',
      agentsMdPaths: ['/srv/app/AGENTS.md'],
    });
  });

  it('loads each environment once and releases its workdir with the session', async () => {
    const { service, acquired, disposedWorkdirs } = setupMounts();

    const first = service.mount('remote', '/srv/app');
    const second = service.mount('remote', '/srv/app');
    expect(second).toBe(first);
    await first;
    expect(acquired).toEqual([{ environmentId: 'remote', cwd: '/srv/app' }]);

    service.dispose();
    expect(disposedWorkdirs()).toBe(1);
  });

  it('reports a workdir that cannot be opened without adding skills', async () => {
    const { service, contributions } = setupMounts({
      acquire: () => Promise.reject(new Error('cwd /srv/app is not a directory on environment remote')),
    });

    await expect(service.mount('remote', '/srv/app')).resolves.toEqual({
      status: 'failed',
      error: 'cwd /srv/app is not a directory on environment remote',
    });
    expect(contributions.size).toBe(0);
  });
});
