import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { LiveRef } from '#/_base/di/instantiation';
import type { ISessionEventBus } from '#/app/event/eventBus';
import type { ILogService } from '#/_base/log/log';
import { AgentEnvironmentService, snapshotAgentEnvironmentBinding } from '#/agent/environmentBinding/agentEnvironment';
import { AgentEnvironmentBindingService, agentEnvironmentBindingKey, ENVIRONMENT_BINDING_REMINDER_VARIANT } from '#/agent/environmentBinding/environmentBindingService';
import { environmentBindingKey, type EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import { EnvironmentError, EnvironmentRegistry } from '#/environment/environmentRegistry';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { WireRecord } from '#/wire/record';
import type {
  IEnvironmentResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { stubAgentContext } from '../agentContext/stubs';

function environment(
  environmentId: string,
  generation: string,
  status: Environment['status'] = 'ready',
  capabilities: readonly EnvironmentCapability[] = [],
  host?: Partial<Environment['host']>,
): FakeEnvironment {
  const value = new FakeEnvironment(
    { workspaceId: 'workspace', environmentId, generation },
    { status, capabilities, host },
  );
  return Object.assign(value, {
    fs: capabilities.includes('fs') ? {} : undefined,
    process: capabilities.includes('process') ? {} : undefined,
    terminal: capabilities.includes('terminal') ? {} : undefined,
  });
}

interface RestoreHook {
  (ctx: unknown, next: () => Promise<void>): Promise<void>;
}

function setup(options: { agentId?: string; sessionCwd?: string; seedBinding?: EnvironmentBinding } = {}) {
  const registry = new EnvironmentRegistry('workspace');
  const local = environment('local', 'local-one', 'ready', ['fs', 'process'], {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: '6.1.0-local',
    shellName: 'bash',
    shellPath: '/bin/bash',
  });
  const remote = environment('remote', 'remote-one', 'ready', ['process'], {
    osKind: 'FreeBSD',
    osArch: 'arm64',
    osVersion: '13.2-remote',
    shellName: 'sh',
    shellPath: '/usr/local/bin/sh',
  });
  const localRegistration = registry.register(local);
  registry.register(remote);
  const resolver: IEnvironmentResolver = {
    _serviceBrand: undefined,
    inspect: (binding: EnvironmentBinding) => registry.inspect(binding),
    acquire: (binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): EnvironmentLease =>
      registry.acquire(binding, required),
    acquireWhenReady: (binding: EnvironmentBinding, required: readonly EnvironmentCapability[] = []): Promise<EnvironmentLease> =>
      registry.acquireWhenReady(binding, required),
  };
  const state = new AgentStateService();
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
  const workspaceContext = {
    _serviceBrand: undefined,
    workDir: session.cwd,
    additionalDirs: [],
    setWorkDir: (dir: string) => {
      workDirWrites.push(dir);
    },
  } as unknown as ISessionWorkspaceContext;
  const activeToolCalls: { toolCallId: string; name: string }[] = [];
  const loopState: {
    turn?: { turnId: number; phase: string; step: number; activeToolCalls: { toolCallId: string; name: string }[] };
  } = { turn: undefined };
  const loop: LiveRef<IAgentLoopService> = {
    current: {
      snapshot: () => ({
        state: 'running',
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
        turn: loopState.turn,
      }),
    } as unknown as IAgentLoopService,
    onDidChange: () => ({ dispose: () => {} }),
  };
  const scopeContext = {
    _serviceBrand: undefined,
    agentId: options.agentId ?? 'main',
    agentContext: stubAgentContext(options.agentId ?? 'main', 1),
    scope: (subKey?: string) => subKey ?? '',
  };
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
  const reminder = {
    _serviceBrand: undefined,
    notify: (content: string, notification: { variant: string }) => {
      reminders.push({ content, variant: notification.variant });
    },
  } as unknown as IAgentReminderService;
  const appendLogRecords: WireRecord[] = [];
  const appendLog = {
    _serviceBrand: undefined,
    read: async function* <R>(): AsyncIterable<R> {
      for (const record of appendLogRecords) yield record as R;
    },
  } as unknown as IAppendLogStore;
  const noopLog = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    error: () => {},
    warn: () => {},
    info: () => {},
    debug: () => {},
    child: () => noopLog,
  } as unknown as ILogService;
  const binding = new AgentEnvironmentBindingService(
    scopeContext,
    state,
    { _serviceBrand: undefined, binding: options.seedBinding ?? { workspaceId: 'workspace', environmentId: 'local' } },
    session,
    workspaceContext,
    resolver,
    dispatcher,
    eventBus,
    loop,
    reminder,
    appendLog,
    noopLog,
  );
  const workspaceChanges = new Emitter<{ workspaceId: string }>();
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: workspaceChanges.event,
    get: () => ({ environments: registry }),
  } as unknown as IWorkspaceInstanceManager;
  const sessionState = new SessionStateService();
  sessionState.contributeState(workspaceContextWorkDirKey);
  sessionState.contributeState(workspaceContextAdditionalDirsKey);
  sessionState.set(workspaceContextWorkDirKey, session.cwd);
  return {
    registry,
    resolver,
    state,
    binding,
    local,
    remote,
    localRegistration,
    workspaceChanges,
    dispatched,
    restoreHooks,
    workDirWrites,
    activeToolCalls,
    loopState,
    publishBus,
    published,
    sessionState,
    reminders,
    appendLogRecords,
    agentEnvironment: new AgentEnvironmentService(scopeContext, binding, resolver, workspaces, eventBus, session, sessionState),
  };
}

describe('AgentEnvironmentBindingService', () => {
  it('switches only after the target can be acquired and emits the committed binding', () => {
    const { binding } = setup();
    const changes: EnvironmentBinding[] = [];
    binding.onDidChange((next) => changes.push(next));

    expect(binding.switch('remote')).toEqual({ workspaceId: 'workspace', environmentId: 'remote' });
    expect(binding.get()).toEqual({ workspaceId: 'workspace', environmentId: 'remote' });
    expect(changes).toEqual([{ workspaceId: 'workspace', environmentId: 'remote' }]);
  });

  it('keeps the prior binding for missing and unavailable targets without fallback', () => {
    const { registry, binding } = setup();
    registry.register(environment('offline', 'offline-one', 'disconnected'));

    expect(() => binding.switch('missing')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
    expect(() => binding.switch('offline')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('rejects cross-session workspace bindings', () => {
    const { binding } = setup();
    expect(() => binding.set({ workspaceId: 'other', environmentId: 'remote' })).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('pins old leases while new calls use the switched environment', () => {
    const { binding, agentEnvironment } = setup();
    const oldLease = agentEnvironment.acquire();
    binding.switch('remote');
    const newLease = agentEnvironment.acquire();

    expect(oldLease.environment.identity).toMatchObject({ environmentId: 'local', generation: 'local-one' });
    expect(newLease.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    oldLease.dispose();
    newLease.dispose();
  });

  it('persists no generation and resolves the current generation after replacement', async () => {
    const { registry, state, binding, agentEnvironment } = setup();
    binding.switch('remote');
    const registration = registry.register(environment('replaceable', 'one'));
    binding.switch('replaceable');
    await registration.replace(environment('replaceable', 'two'));

    expect(state.get(agentEnvironmentBindingKey)).toEqual({
      workspaceId: 'workspace',
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

    binding.switch('remote');

    expect(changes).toHaveLength(1);
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    expect(agentEnvironment.isAvailable(['process'])).toBe(true);
  });

  it('snapshots the binding switch and current environment generation', () => {
    const { binding, agentEnvironment } = setup();

    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toEqual({
      binding: { workspaceId: 'workspace', environmentId: 'local' },
      available: true,
      environment: {
        environmentId: 'local',
        generation: 'local-one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      },
    });

    binding.switch('remote');
    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toMatchObject({
      binding: { workspaceId: 'workspace', environmentId: 'remote' },
      available: true,
      environment: { environmentId: 'remote', generation: 'remote-one' },
    });
  });

  it('forwards the bound environment connectError into the snapshot', () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.switch('remote');
    remote.setStatus('disconnected');
    remote.connectError = 'executor process exited before the handshake completed (code 255): ssh: connect failed';

    expect(snapshotAgentEnvironmentBinding(binding, agentEnvironment)).toMatchObject({
      binding: { workspaceId: 'workspace', environmentId: 'remote' },
      available: false,
      environment: {
        environmentId: 'remote',
        status: 'disconnected',
        connectError: 'executor process exited before the handshake completed (code 255): ssh: connect failed',
      },
    });
  });

  it('tracks disconnect, reconnect, and workspace instance changes', () => {
    const { local, workspaceChanges, agentEnvironment } = setup();
    const changes: void[] = [];
    agentEnvironment.onDidChange(() => changes.push(undefined));

    local.setStatus('disconnected');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('ready');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(true);
    workspaceChanges.fire({ workspaceId: 'workspace' });

    expect(changes).toHaveLength(3);
  });

  it('publishes a environment status hint when the bound environment changes status', () => {
    const { local, remote, binding, published } = setup();
    binding.switch('remote');

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
    binding.switch('remote');
    remote.setStatus('disconnected');
    expect(published).toEqual([]);
  });

  it('applies the shared status gate to every environment lifecycle state', () => {
    const { local, agentEnvironment } = setup();

    local.setStatus('connecting');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('degraded');
    expect(agentEnvironment.isAvailable(['fs', 'process'])).toBe(true);
    local.setStatus('draining');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('disconnected');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    local.setStatus('disposed');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
  });

  it('tracks current-generation replacement without observing the drained generation', async () => {
    const { local, localRegistration, agentEnvironment } = setup();
    const changes: void[] = [];
    agentEnvironment.onDidChange(() => changes.push(undefined));

    await localRegistration.replace(environment('local', 'local-two', 'ready', ['process']));

    expect(changes).toHaveLength(1);
    expect(agentEnvironment.inspect().identity.generation).toBe('local-two');
    expect(agentEnvironment.isAvailable(['fs'])).toBe(false);
    expect(agentEnvironment.isAvailable(['process'])).toBe(true);
    local.setStatus('ready');
    expect(changes).toHaveLength(1);
  });

  it('carries cwd through switch and the persisted op payload', () => {
    const { binding, dispatched } = setup();

    expect(binding.switch('remote', '/remote/work')).toEqual({
      workspaceId: 'workspace',
      environmentId: 'remote',
      cwd: '/remote/work',
    });
    expect(binding.current.cwd).toBe('/remote/work');
    expect(dispatched.at(-1)).toMatchObject({
      workspaceId: 'workspace',
      environmentId: 'remote',
      cwd: '/remote/work',
    });

    binding.switch('local');
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: undefined });
    expect(dispatched.at(-1)).toMatchObject({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('rejects switching while tool calls are executing or pending approval', () => {
    const { binding, activeToolCalls, loopState } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls };
    activeToolCalls.push({ toolCallId: 'call-1', name: 'Bash' });

    expect(() => binding.switch('remote')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: undefined });

    activeToolCalls.length = 0;
    expect(binding.switch('remote').environmentId).toBe('remote');
  });

  it('pushes the effective workDir to the session context for the main agent', async () => {
    const { binding, workDirWrites, restoreHooks } = setup();

    binding.switch('remote', '/remote/work');
    expect(workDirWrites).toEqual(['/remote/work']);

    binding.switch('local');
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);

    workDirWrites.length = 0;
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    expect(workDirWrites).toEqual(['/workspace']);
  });

  it('defers the workDir switch to the turn boundary while the op commits mid-turn', () => {
    const { binding, loopState, workDirWrites, publishBus } = setup();
    loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [] };

    expect(binding.switch('remote', '/remote/work').environmentId).toBe('remote');
    expect(binding.current).toMatchObject({ environmentId: 'remote', cwd: '/remote/work' });
    expect(workDirWrites).toEqual([]);

    publishBus('turn.ended', { agentId: 'main' });
    expect(workDirWrites).toEqual(['/remote/work']);

    loopState.turn = { turnId: 2, phase: 'running', step: 1, activeToolCalls: [] };
    binding.switch('local');
    expect(workDirWrites).toEqual(['/remote/work']);

    publishBus('turn.ended', { agentId: 'agent-9' });
    expect(workDirWrites).toEqual(['/remote/work']);

    publishBus('turn.ended', { agentId: 'main' });
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);
  });

  it('does not push workDir for non-main agents', () => {
    const { binding, workDirWrites } = setup({ agentId: 'agent-1' });
    binding.switch('remote', '/remote/work');
    expect(workDirWrites).toEqual([]);
  });

  it('pins the turn binding and generation from turn start until turn end', () => {
    const { binding, agentEnvironment, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });

    binding.switch('remote');
    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity).toMatchObject({ environmentId: 'local', generation: 'local-one' });
    lease.dispose();

    publishBus('turn.ended', { agentId: 'main' });
    const next = agentEnvironment.acquire();
    expect(next.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    next.dispose();
  });

  it('fails turn acquires when the pinned environment generation changes mid-turn', async () => {
    const { agentEnvironment, localRegistration, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });

    await localRegistration.replace(environment('local', 'local-two', 'ready', ['fs', 'process']));

    expect(() => agentEnvironment.acquire()).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );

    publishBus('turn.ended', { agentId: 'main' });
    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity.generation).toBe('local-two');
    lease.dispose();
  });

  it('replays the restored binding without reconnecting and raises unavailable on first acquire', async () => {
    const { state, remote, restoreHooks, binding, agentEnvironment, workDirWrites } = setup();
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
    remote.setStatus('disconnected');

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
    expect(workDirWrites).toEqual(['/remote/work']);
    expect(() => agentEnvironment.acquire()).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(binding.current.environmentId).toBe('remote');
  });

  it('ignores turn events of other agents', () => {
    const { binding, agentEnvironment, publishBus } = setup();
    publishBus('turn.started', { agentId: 'agent-9' });
    binding.switch('remote');
    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity.environmentId).toBe('remote');
    lease.dispose();
  });
});

describe('AgentEnvironmentBindingService restore from wire records', () => {
  function connectableRemote(registry: EnvironmentRegistry, environmentId: string) {
    const connectCalls: string[] = [];
    const rerootCalls: string[] = [];
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId, generation: `${environmentId}-pending` },
      { status: 'disconnected', capabilities: ['fs', 'process'] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        connectCalls.push('connect');
        fake.setStatus('ready');
      },
      reroot: async (cwd: string) => {
        rerootCalls.push(cwd);
      },
      fs: {},
      process: {},
    }));
    return { fake, connectCalls, rerootCalls };
  }

  it('reseeds a remote binding from the agent wire records when replay produced none', async () => {
    const { binding, restoreHooks, dispatched, appendLogRecords } = setup({ agentId: 'agent-1' });
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'remote', cwd: '/remote/work', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
    expect(dispatched.at(-1)).toMatchObject({
      agentId: 'agent-1',
      workspaceId: 'workspace',
      environmentId: 'remote',
      cwd: '/remote/work',
    });
  });

  it('background-reconnects and reroots a reseeded remote binding', async () => {
    const { registry, restoreHooks, appendLogRecords } = setup({ agentId: 'agent-1' });
    const { connectCalls, rerootCalls } = connectableRemote(registry, 'connectable');
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'connectable', cwd: '/connectable/work', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(connectCalls).toEqual(['connect']);
    expect(rerootCalls).toEqual(['/connectable/work']);
  });

  it('keeps a gone declaration bound after reseed and fails explicitly at use', async () => {
    const { binding, agentEnvironment, restoreHooks, appendLogRecords } = setup({ agentId: 'agent-1' });
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'ghost', cwd: '/ghost/work', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'ghost', cwd: '/ghost/work' });
    expect(() => agentEnvironment.acquire()).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.not_found' }),
    );
  });

  it('background-reconnects and reroots a replayed remote binding for non-main agents', async () => {
    const { registry, state, restoreHooks } = setup({ agentId: 'agent-1' });
    const { connectCalls, rerootCalls } = connectableRemote(registry, 'connectable');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'connectable', cwd: '/connectable/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(connectCalls).toEqual(['connect']);
    expect(rerootCalls).toEqual(['/connectable/work']);
  });

  it('does not reconnect a replayed remote binding for the main agent', async () => {
    const { registry, state, restoreHooks } = setup();
    const { connectCalls } = connectableRemote(registry, 'connectable');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'connectable', cwd: '/connectable/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(connectCalls).toEqual([]);
  });

  it('ignores local binding records and keeps the seed dispatch', async () => {
    const { binding, restoreHooks, dispatched, appendLogRecords } = setup({ agentId: 'agent-1' });
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'local', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched.at(-1)).toMatchObject({ agentId: 'agent-1', workspaceId: 'workspace', environmentId: 'local' });
  });

  it('emits the seed environment reminder when a remote seed round-trips through a replayed op', async () => {
    const { state, restoreHooks, reminders } = setup({
      seedBinding: { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' },
    });
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.variant).toBe(ENVIRONMENT_BINDING_REMINDER_VARIANT);
  });
});

describe('AgentEnvironmentBindingService environment reminder', () => {
  it('emits exactly one reminder with the environment id and environment on switch', () => {
    const { binding, reminders } = setup();

    binding.switch('remote', '/remote/work');
    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!).toEqual({
      variant: ENVIRONMENT_BINDING_REMINDER_VARIANT,
      content:
        'The active environment is now "remote": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/work. ' +
        'Tool calls execute in this environment.',
    });
  });

  it('emits the reminder even when the switch commits mid-turn', () => {
    const { binding, reminders, loopState } = setup();
    loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [] };

    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(1);
  });

  it('emits no reminder for a local create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders } = setup();

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('emits the seed binding environment for a remote create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders } = setup({
      seedBinding: { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' },
    });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.content).toBe(
      'The active environment is now "remote": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/work. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder when the binding is restored from a replayed op', async () => {
    const { state, restoreHooks, reminders } = setup();
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('emits the local environment when switching back to local', () => {
    const { binding, reminders } = setup();

    binding.switch('remote', '/remote/work');
    binding.switch('local');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(
      'The active environment is now "local": Linux 6.1.0-local x86_64, ' +
        'shell bash (/bin/bash), working directory /workspace. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder for a local to local transition with only a cwd change', () => {
    const { binding, reminders } = setup();

    binding.switch('local', '/workspace');

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: '/workspace' });
    expect(reminders).toHaveLength(0);
  });

  it('emits the reminder on a remote to remote switch', () => {
    const { binding, registry, reminders } = setup();
    registry.register(
      environment('remote-two', 'remote-two-one', 'ready', ['process'], {
        osKind: 'Linux',
        osArch: 'x86_64',
        osVersion: '5.15-remote-two',
        shellName: 'bash',
        shellPath: '/usr/bin/bash',
      }),
    );

    binding.switch('remote', '/remote/work');
    binding.switch('remote-two', '/remote/two');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(
      'The active environment is now "remote-two": Linux 5.15-remote-two x86_64, ' +
        'shell bash (/usr/bin/bash), working directory /remote/two. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder when the non-local target reports the same environment as local', () => {
    const { binding, registry, reminders } = setup();
    registry.register(
      environment('acp:session-1', 'acp-one', 'ready', ['fs', 'process'], {
        osKind: 'Linux',
        osArch: 'x86_64',
        osVersion: '6.1.0-local',
        shellName: 'bash',
        shellPath: '/bin/bash',
      }),
    );

    binding.switch('acp:session-1');

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'acp:session-1' });
    expect(reminders).toHaveLength(0);
  });

  it('emits the reminder on a remote to remote switch even when the environments match', () => {
    const { binding, registry, reminders } = setup();
    registry.register(
      environment('remote-two', 'remote-two-one', 'ready', ['process'], {
        osKind: 'FreeBSD',
        osArch: 'arm64',
        osVersion: '13.2-remote',
        shellName: 'sh',
        shellPath: '/usr/local/bin/sh',
      }),
    );

    binding.switch('remote', '/remote/work');
    binding.switch('remote-two', '/remote/two');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(
      'The active environment is now "remote-two": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/two. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('does not emit reminders for non-main agents', () => {
    const { binding, reminders } = setup({ agentId: 'agent-1' });

    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(0);
  });
});

describe('AgentEnvironmentBindingService.connectAndSwitch', () => {
  function connectableEnvironment(
    registry: EnvironmentRegistry,
    environmentId: string,
    options: {
      readonly stat?: (path: string) => Promise<{ isDirectory: boolean }>;
      readonly reroot?: (cwd: string) => Promise<void>;
    } = {},
  ) {
    const calls: string[] = [];
    const rerootCalls: string[] = [];
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId, generation: `${environmentId}-pending` },
      { status: 'disconnected', capabilities: ['fs', 'process'] },
    );
    const connectable = Object.assign(fake, {
      connect: async () => {
        calls.push('connect');
        fake.setStatus('ready');
      },
      fs: {
        stat: options.stat ?? (async () => ({ isDirectory: true })),
      },
      process: {},
      reroot: options.reroot === undefined
        ? undefined
        : async (cwd: string) => {
          rerootCalls.push(cwd);
          await options.reroot!(cwd);
        },
    });
    registry.register(connectable);
    return { fake: connectable, calls, rerootCalls };
  }

  it('connects a disconnected environment, validates the cwd with the target fs, and commits', async () => {
    const { registry, binding, dispatched } = setup();
    const stats: string[] = [];
    const { calls } = connectableEnvironment(registry, 'connectable', {
      stat: async (path) => {
        stats.push(path);
        return { isDirectory: true };
      },
    });

    await expect(binding.connectAndSwitch('connectable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      environmentId: 'connectable',
      cwd: '/remote/work',
    });
    expect(calls).toEqual(['connect']);
    expect(stats).toEqual(['/remote/work']);
    expect(binding.current).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
    expect(dispatched.at(-1)).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
  });

  it('keeps the old binding when the connect fails', async () => {
    const { registry, binding } = setup();
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'failing', generation: 'failing-pending' },
      { status: 'disconnected', capabilities: [] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        throw new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
      },
    }));

    await expect(binding.connectAndSwitch('failing', '/remote/work')).rejects.toThrow(/code 255/);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('keeps the old binding and reports environment.invalid_cwd when the cwd check fails', async () => {
    const { registry, binding, dispatched } = setup();
    connectableEnvironment(registry, 'invalid-stat', {
      stat: async (path) => {
        throw new Error(`ENOENT: ${path}`);
      },
    });

    await expect(binding.connectAndSwitch('invalid-stat', '/missing')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.invalid_cwd' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a non-directory cwd and a missing cwd for non-local environments', async () => {
    const { registry, binding } = setup();
    connectableEnvironment(registry, 'non-dir', { stat: async () => ({ isDirectory: false }) });

    await expect(binding.connectAndSwitch('non-dir', '/remote/file')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.invalid_cwd' }),
    );
    await expect(binding.connectAndSwitch('non-dir')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.invalid_cwd' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('raises environment.unavailable for a disconnected environment that cannot connect', async () => {
    const { registry, binding } = setup();
    registry.register(environment('offline', 'offline-one', 'disconnected'));

    await expect(binding.connectAndSwitch('offline', '/work')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('skips connecting when the target is already available', async () => {
    const { registry, binding } = setup();
    const stats: string[] = [];
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'already-ready', generation: 'already-ready-one' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        throw new Error('must not be called');
      },
      fs: {
        stat: async (path: string) => {
          stats.push(path);
          return { isDirectory: true };
        },
      },
      process: {},
    }));

    await expect(binding.connectAndSwitch('already-ready', '/remote/work')).resolves.toMatchObject({
      environmentId: 'already-ready',
      cwd: '/remote/work',
    });
    expect(stats).toEqual(['/remote/work']);
  });

  it('re-roots the connected environment with the validated cwd before committing', async () => {
    const { registry, binding } = setup();
    const { calls, rerootCalls } = connectableEnvironment(registry, 'rootable', { reroot: async () => {} });

    await expect(binding.connectAndSwitch('rootable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      environmentId: 'rootable',
      cwd: '/remote/work',
    });
    expect(calls).toEqual(['connect']);
    expect(rerootCalls).toEqual(['/remote/work']);
    expect(binding.current).toMatchObject({ environmentId: 'rootable', cwd: '/remote/work' });
  });

  it('does not reroot when the cwd validation fails', async () => {
    const { registry, binding } = setup();
    const { rerootCalls } = connectableEnvironment(registry, 'invalid-root', {
      stat: async (path) => {
        throw new Error(`ENOENT: ${path}`);
      },
      reroot: async () => {},
    });

    await expect(binding.connectAndSwitch('invalid-root', '/missing')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.invalid_cwd' }),
    );
    expect(rerootCalls).toEqual([]);
  });

  it('keeps the old binding when the reroot fails', async () => {
    const { registry, binding, dispatched } = setup();
    connectableEnvironment(registry, 'failing-root', {
      reroot: async () => {
        throw new Error('registry drained');
      },
    });

    await expect(binding.connectAndSwitch('failing-root', '/remote/work')).rejects.toThrow('registry drained');
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched).toHaveLength(0);
  });

  it('does not reroot when switching back to local', async () => {
    const { registry, binding } = setup();
    const { rerootCalls } = connectableEnvironment(registry, 'rootable', { reroot: async () => {} });

    await binding.connectAndSwitch('rootable', '/remote/work');
    await binding.connectAndSwitch('local');

    expect(rerootCalls).toEqual(['/remote/work']);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: undefined });
  });
});

describe('AgentEnvironmentService reconnect', () => {
  it('delegates to the connect method of the bound environment', async () => {
    const { registry, binding, agentEnvironment } = setup();
    const calls: string[] = [];
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'reconnectable', generation: 'reconnectable-one' },
      { status: 'ready', capabilities: ['process'] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        calls.push('connect');
      },
      process: {},
    }));
    binding.switch('reconnectable');

    await agentEnvironment.reconnect();
    expect(calls).toEqual(['connect']);
  });

  it('raises environment.unavailable when the bound environment cannot reconnect', async () => {
    const { agentEnvironment } = setup();
    await expect(agentEnvironment.reconnect()).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
  });
});

describe('AgentEnvironmentService.acquireWhenReady', () => {
  it('acquires a ready environment without waiting on a readiness signal', async () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.switch('remote');
    remote.whenReady = new Promise<void>(() => {});

    const lease = await agentEnvironment.acquireWhenReady(['process']);
    expect(lease.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    lease.dispose();
  });

  it('waits for the in-flight connect of a connecting environment and acquires once ready', async () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.switch('remote');
    remote.setStatus('connecting');
    let releaseReady!: () => void;
    remote.whenReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });

    let settled = false;
    const pending = agentEnvironment.acquireWhenReady(['process']).then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    remote.whenReady = undefined;
    remote.setStatus('ready');
    releaseReady();
    const lease = await pending;
    expect(lease.environment.status).toBe('ready');
    lease.dispose();
  });

  it('rejects with the connect reason when the in-flight connect fails', async () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.switch('remote');
    remote.setStatus('connecting');
    const failure = new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
    remote.whenReady = Promise.reject(failure);
    void remote.whenReady.catch(() => {});

    await expect(agentEnvironment.acquireWhenReady(['process'])).rejects.toBe(failure);
  });

  it('keeps the immediate environment.unavailable error for a plainly disconnected environment', async () => {
    const { remote, binding, agentEnvironment } = setup();
    binding.switch('remote');
    remote.setStatus('disconnected');

    await expect(agentEnvironment.acquireWhenReady(['process'])).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
  });

  it('fails when the pinned turn generation changes mid-turn', async () => {
    const { agentEnvironment, localRegistration, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });
    await localRegistration.replace(environment('local', 'local-two', 'ready', ['fs', 'process']));

    await expect(agentEnvironment.acquireWhenReady()).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );

    publishBus('turn.ended', { agentId: 'main' });
    const lease = await agentEnvironment.acquireWhenReady();
    expect(lease.environment.identity.generation).toBe('local-two');
    lease.dispose();
  });
});
