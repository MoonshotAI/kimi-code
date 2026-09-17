import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { LiveRef } from '#/_base/di/instantiation';
import type { ISessionEventBus } from '#/app/event/eventBus';
import type { IFlagService } from '#/app/flag/flag';
import { AgentRuntimeService, snapshotAgentRuntimeBinding } from '#/agent/runtimeBinding/agentRuntime';
import { AgentRuntimeBindingService, agentRuntimeBindingKey, RUNTIME_ENVIRONMENT_REMINDER_VARIANT } from '#/agent/runtimeBinding/runtimeBindingService';
import { runtimeBindingKey, type RuntimeSetBinding } from '#/agent/runtimeBinding/runtimeBindingOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { stubAgentContext } from '../agentContext/stubs';

function runtime(
  runtimeId: string,
  generation: string,
  status: Runtime['status'] = 'ready',
  capabilities: readonly RuntimeCapability[] = [],
  environment?: Partial<Runtime['environment']>,
): FakeRuntime {
  const value = new FakeRuntime(
    { workspaceId: 'workspace', runtimeId, generation },
    { status, capabilities, environment },
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

function setup(options: { agentId?: string; sessionCwd?: string; seedBinding?: RuntimeBinding } = {}) {
  const registry = new RuntimeRegistry('workspace');
  const local = runtime('local', 'local-one', 'ready', ['fs', 'process'], {
    osKind: 'Linux',
    osArch: 'x86_64',
    osVersion: '6.1.0-local',
    shellName: 'bash',
    shellPath: '/bin/bash',
  });
  const remote = runtime('remote', 'remote-one', 'ready', ['process'], {
    osKind: 'FreeBSD',
    osArch: 'arm64',
    osVersion: '13.2-remote',
    shellName: 'sh',
    shellPath: '/usr/local/bin/sh',
  });
  const localRegistration = registry.register(local);
  registry.register(remote);
  const resolver: IRuntimeResolver = {
    _serviceBrand: undefined,
    inspect: (binding: RuntimeBinding) => registry.inspect(binding),
    acquire: (binding: RuntimeBinding, required: readonly RuntimeCapability[] = []): RuntimeLease =>
      registry.acquire(binding, required),
    acquireWhenReady: (binding: RuntimeBinding, required: readonly RuntimeCapability[] = []): Promise<RuntimeLease> =>
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
  const dispatched: RuntimeSetBinding[] = [];
  const restoreHooks = new Map<string, RestoreHook>();
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: (event: RuntimeSetBinding) => {
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
  const published: { readonly type: string; readonly runtimeId?: string; readonly status?: string }[] = [];
  const eventBus = {
    subscribe: (cls: { readonly type: string }, handler: (event: { readonly agentId?: string }) => void) => {
      const handlers = busHandlers.get(cls.type) ?? [];
      handlers.push(handler);
      busHandlers.set(cls.type, handlers);
      return { dispose: () => {} };
    },
    isAgentActive: () => true,
    publish: (event: { readonly type: string; readonly runtimeId?: string; readonly status?: string }) => {
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
  const flagState = { remoteRuntime: false };
  const flags = {
    _serviceBrand: undefined,
    enabled: () => flagState.remoteRuntime,
  } as unknown as IFlagService;
  const binding = new AgentRuntimeBindingService(
    scopeContext,
    state,
    { _serviceBrand: undefined, binding: options.seedBinding ?? { workspaceId: 'workspace', runtimeId: 'local' } },
    session,
    workspaceContext,
    resolver,
    dispatcher,
    eventBus,
    loop,
    flags,
    reminder,
  );
  const workspaceChanges = new Emitter<{ workspaceId: string }>();
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: workspaceChanges.event,
    get: () => ({ runtimes: registry }),
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
    flags,
    flagState,
    reminders,
    agentRuntime: new AgentRuntimeService(scopeContext, binding, resolver, workspaces, eventBus, session, sessionState, flags),
  };
}

describe('AgentRuntimeBindingService', () => {
  it('switches only after the target can be acquired and emits the committed binding', () => {
    const { binding } = setup();
    const changes: RuntimeBinding[] = [];
    binding.onDidChange((next) => changes.push(next));

    expect(binding.switch('remote')).toEqual({ workspaceId: 'workspace', runtimeId: 'remote' });
    expect(binding.get()).toEqual({ workspaceId: 'workspace', runtimeId: 'remote' });
    expect(changes).toEqual([{ workspaceId: 'workspace', runtimeId: 'remote' }]);
  });

  it('keeps the prior binding for missing and unavailable targets without fallback', () => {
    const { registry, binding } = setup();
    registry.register(runtime('offline', 'offline-one', 'disconnected'));

    expect(() => binding.switch('missing')).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.not_found' }),
    );
    expect(() => binding.switch('offline')).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('rejects cross-session workspace bindings', () => {
    const { binding } = setup();
    expect(() => binding.set({ workspaceId: 'other', runtimeId: 'remote' })).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.not_found' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('pins old leases while new calls use the switched runtime', () => {
    const { binding, agentRuntime } = setup();
    const oldLease = agentRuntime.acquire();
    binding.switch('remote');
    const newLease = agentRuntime.acquire();

    expect(oldLease.runtime.identity).toMatchObject({ runtimeId: 'local', generation: 'local-one' });
    expect(newLease.runtime.identity).toMatchObject({ runtimeId: 'remote', generation: 'remote-one' });
    oldLease.dispose();
    newLease.dispose();
  });

  it('persists no generation and resolves the current generation after replacement', async () => {
    const { registry, state, binding, agentRuntime } = setup();
    binding.switch('remote');
    const registration = registry.register(runtime('replaceable', 'one'));
    binding.switch('replaceable');
    await registration.replace(runtime('replaceable', 'two'));

    expect(state.get(agentRuntimeBindingKey)).toEqual({
      workspaceId: 'workspace',
      runtimeId: 'replaceable',
    });
    const lease = agentRuntime.acquire();
    expect(lease.runtime.identity.generation).toBe('two');
    lease.dispose();
  });

  it('updates capability availability when the binding switches runtimes', () => {
    const { binding, agentRuntime } = setup();
    const changes: void[] = [];
    agentRuntime.onDidChange(() => changes.push(undefined));

    expect(agentRuntime.isAvailable(['fs'])).toBe(true);
    expect(agentRuntime.isAvailable(['process'])).toBe(true);

    binding.switch('remote');

    expect(changes).toHaveLength(1);
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    expect(agentRuntime.isAvailable(['process'])).toBe(true);
  });

  it('snapshots the binding switch and current runtime generation', () => {
    const { binding, agentRuntime } = setup();

    expect(snapshotAgentRuntimeBinding(binding, agentRuntime)).toEqual({
      binding: { workspaceId: 'workspace', runtimeId: 'local' },
      available: true,
      runtime: {
        runtimeId: 'local',
        generation: 'local-one',
        status: 'ready',
        capabilities: ['fs', 'process'],
      },
    });

    binding.switch('remote');
    expect(snapshotAgentRuntimeBinding(binding, agentRuntime)).toMatchObject({
      binding: { workspaceId: 'workspace', runtimeId: 'remote' },
      available: true,
      runtime: { runtimeId: 'remote', generation: 'remote-one' },
    });
  });

  it('forwards the bound runtime connectError into the snapshot', () => {
    const { remote, binding, agentRuntime } = setup();
    binding.switch('remote');
    remote.setStatus('disconnected');
    remote.connectError = 'executor process exited before the handshake completed (code 255): ssh: connect failed';

    expect(snapshotAgentRuntimeBinding(binding, agentRuntime)).toMatchObject({
      binding: { workspaceId: 'workspace', runtimeId: 'remote' },
      available: false,
      runtime: {
        runtimeId: 'remote',
        status: 'disconnected',
        connectError: 'executor process exited before the handshake completed (code 255): ssh: connect failed',
      },
    });
  });

  it('tracks disconnect, reconnect, and workspace instance changes', () => {
    const { local, workspaceChanges, agentRuntime } = setup();
    const changes: void[] = [];
    agentRuntime.onDidChange(() => changes.push(undefined));

    local.setStatus('disconnected');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    local.setStatus('ready');
    expect(agentRuntime.isAvailable(['fs'])).toBe(true);
    workspaceChanges.fire({ workspaceId: 'workspace' });

    expect(changes).toHaveLength(3);
  });

  it('publishes a runtime status hint when the bound runtime changes status', () => {
    const { local, remote, binding, published } = setup();
    binding.switch('remote');

    remote.setStatus('disconnected');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      type: 'runtime.status.changed',
      runtimeId: 'remote',
      status: 'disconnected',
    });

    published.length = 0;
    local.setStatus('disconnected');
    expect(published).toEqual([]);
  });

  it('does not publish runtime status hints for a non-main agent', () => {
    const { remote, binding, published } = setup({ agentId: 'agent-1' });
    binding.switch('remote');
    remote.setStatus('disconnected');
    expect(published).toEqual([]);
  });

  it('applies the shared status gate to every runtime lifecycle state', () => {
    const { local, agentRuntime } = setup();

    local.setStatus('connecting');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    local.setStatus('degraded');
    expect(agentRuntime.isAvailable(['fs', 'process'])).toBe(true);
    local.setStatus('draining');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    local.setStatus('disconnected');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    local.setStatus('disposed');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
  });

  it('tracks current-generation replacement without observing the drained generation', async () => {
    const { local, localRegistration, agentRuntime } = setup();
    const changes: void[] = [];
    agentRuntime.onDidChange(() => changes.push(undefined));

    await localRegistration.replace(runtime('local', 'local-two', 'ready', ['process']));

    expect(changes).toHaveLength(1);
    expect(agentRuntime.inspect().identity.generation).toBe('local-two');
    expect(agentRuntime.isAvailable(['fs'])).toBe(false);
    expect(agentRuntime.isAvailable(['process'])).toBe(true);
    local.setStatus('ready');
    expect(changes).toHaveLength(1);
  });

  it('carries cwd through switch and the persisted op payload', () => {
    const { binding, dispatched } = setup();

    expect(binding.switch('remote', '/remote/work')).toEqual({
      workspaceId: 'workspace',
      runtimeId: 'remote',
      cwd: '/remote/work',
    });
    expect(binding.current.cwd).toBe('/remote/work');
    expect(dispatched.at(-1)).toMatchObject({
      workspaceId: 'workspace',
      runtimeId: 'remote',
      cwd: '/remote/work',
    });

    binding.switch('local');
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local', cwd: undefined });
    expect(dispatched.at(-1)).toMatchObject({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('rejects switching while tool calls are executing or pending approval', () => {
    const { binding, activeToolCalls, loopState } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls };
    activeToolCalls.push({ toolCallId: 'call-1', name: 'Bash' });

    expect(() => binding.switch('remote')).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.conflict' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local', cwd: undefined });

    activeToolCalls.length = 0;
    expect(binding.switch('remote').runtimeId).toBe('remote');
  });

  it('pushes the effective workDir to the session context for the main agent', async () => {
    const { binding, workDirWrites, restoreHooks } = setup();

    binding.switch('remote', '/remote/work');
    expect(workDirWrites).toEqual(['/remote/work']);

    binding.switch('local');
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);

    workDirWrites.length = 0;
    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});
    expect(workDirWrites).toEqual(['/workspace']);
  });

  it('defers the workDir switch to the turn boundary while the op commits mid-turn', () => {
    const { binding, loopState, workDirWrites, publishBus } = setup();
    loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [] };

    expect(binding.switch('remote', '/remote/work').runtimeId).toBe('remote');
    expect(binding.current).toMatchObject({ runtimeId: 'remote', cwd: '/remote/work' });
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
    const { binding, agentRuntime, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });

    binding.switch('remote');
    const lease = agentRuntime.acquire();
    expect(lease.runtime.identity).toMatchObject({ runtimeId: 'local', generation: 'local-one' });
    lease.dispose();

    publishBus('turn.ended', { agentId: 'main' });
    const next = agentRuntime.acquire();
    expect(next.runtime.identity).toMatchObject({ runtimeId: 'remote', generation: 'remote-one' });
    next.dispose();
  });

  it('fails turn acquires when the pinned runtime generation changes mid-turn', async () => {
    const { agentRuntime, localRegistration, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });

    await localRegistration.replace(runtime('local', 'local-two', 'ready', ['fs', 'process']));

    expect(() => agentRuntime.acquire()).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );

    publishBus('turn.ended', { agentId: 'main' });
    const lease = agentRuntime.acquire();
    expect(lease.runtime.identity.generation).toBe('local-two');
    lease.dispose();
  });

  it('replays the restored binding without reconnecting and raises unavailable on first acquire', async () => {
    const { state, remote, restoreHooks, binding, agentRuntime, workDirWrites } = setup();
    state.set(runtimeBindingKey, { workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });
    remote.setStatus('disconnected');

    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });
    expect(workDirWrites).toEqual(['/remote/work']);
    expect(() => agentRuntime.acquire()).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );
    expect(binding.current.runtimeId).toBe('remote');
  });

  it('ignores turn events of other agents', () => {
    const { binding, agentRuntime, publishBus } = setup();
    publishBus('turn.started', { agentId: 'agent-9' });
    binding.switch('remote');
    const lease = agentRuntime.acquire();
    expect(lease.runtime.identity.runtimeId).toBe('remote');
    lease.dispose();
  });
});

describe('AgentRuntimeBindingService environment reminder', () => {
  it('emits exactly one reminder with the runtime id and environment on switch', () => {
    const { binding, reminders, flagState } = setup();
    flagState.remoteRuntime = true;

    binding.switch('remote', '/remote/work');
    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!).toEqual({
      variant: RUNTIME_ENVIRONMENT_REMINDER_VARIANT,
      content:
        'The active runtime environment is now "remote": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/work. ' +
        'Tool calls execute in this environment.',
    });
  });

  it('emits the reminder even when the switch commits mid-turn', () => {
    const { binding, reminders, flagState, loopState } = setup();
    flagState.remoteRuntime = true;
    loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [] };

    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(1);
  });

  it('emits no reminder for a local create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders, flagState } = setup();
    flagState.remoteRuntime = true;

    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('emits the seed binding environment for a remote create-seed on a fresh session restore', async () => {
    const { restoreHooks, reminders, flagState } = setup({
      seedBinding: { workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' },
    });
    flagState.remoteRuntime = true;

    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.content).toBe(
      'The active runtime environment is now "remote": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/work. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder when the binding is restored from a replayed op', async () => {
    const { state, restoreHooks, reminders, flagState } = setup();
    flagState.remoteRuntime = true;
    state.set(runtimeBindingKey, { workspaceId: 'workspace', runtimeId: 'remote', cwd: '/remote/work' });

    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('emits the local environment when switching back to local', () => {
    const { binding, reminders, flagState } = setup();
    flagState.remoteRuntime = true;

    binding.switch('remote', '/remote/work');
    binding.switch('local');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(
      'The active runtime environment is now "local": Linux 6.1.0-local x86_64, ' +
        'shell bash (/bin/bash), working directory /workspace. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder for a local to local transition with only a cwd change', () => {
    const { binding, reminders, flagState } = setup();
    flagState.remoteRuntime = true;

    binding.switch('local', '/workspace');

    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local', cwd: '/workspace' });
    expect(reminders).toHaveLength(0);
  });

  it('emits the reminder on a remote to remote switch', () => {
    const { binding, registry, reminders, flagState } = setup();
    flagState.remoteRuntime = true;
    registry.register(
      runtime('remote-two', 'remote-two-one', 'ready', ['process'], {
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
      'The active runtime environment is now "remote-two": Linux 5.15-remote-two x86_64, ' +
        'shell bash (/usr/bin/bash), working directory /remote/two. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('emits no reminder when the non-local target reports the same environment as local', () => {
    const { binding, registry, reminders, flagState } = setup();
    flagState.remoteRuntime = true;
    registry.register(
      runtime('acp:session-1', 'acp-one', 'ready', ['fs', 'process'], {
        osKind: 'Linux',
        osArch: 'x86_64',
        osVersion: '6.1.0-local',
        shellName: 'bash',
        shellPath: '/bin/bash',
      }),
    );

    binding.switch('acp:session-1');

    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'acp:session-1' });
    expect(reminders).toHaveLength(0);
  });

  it('emits the reminder on a remote to remote switch even when the environments match', () => {
    const { binding, registry, reminders, flagState } = setup();
    flagState.remoteRuntime = true;
    registry.register(
      runtime('remote-two', 'remote-two-one', 'ready', ['process'], {
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
      'The active runtime environment is now "remote-two": FreeBSD 13.2-remote arm64, ' +
        'shell sh (/usr/local/bin/sh), working directory /remote/two. ' +
        'Tool calls execute in this environment.',
    );
  });

  it('stays silent when the remote runtime flag is off', async () => {
    const { binding, restoreHooks, reminders } = setup();

    binding.switch('remote', '/remote/work');
    await restoreHooks.get('agent-runtime-binding')?.(undefined, async () => {});

    expect(reminders).toHaveLength(0);
  });

  it('does not emit reminders for non-main agents', () => {
    const { binding, reminders, flagState } = setup({ agentId: 'agent-1' });
    flagState.remoteRuntime = true;

    binding.switch('remote', '/remote/work');

    expect(reminders).toHaveLength(0);
  });
});

describe('AgentRuntimeBindingService.connectAndSwitch', () => {
  function connectableRuntime(
    registry: RuntimeRegistry,
    runtimeId: string,
    options: {
      readonly stat?: (path: string) => Promise<{ isDirectory: boolean }>;
      readonly reroot?: (cwd: string) => Promise<void>;
    } = {},
  ) {
    const calls: string[] = [];
    const rerootCalls: string[] = [];
    const fake = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId, generation: `${runtimeId}-pending` },
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

  it('connects a disconnected runtime, validates the cwd with the target fs, and commits', async () => {
    const { registry, binding, dispatched } = setup();
    const stats: string[] = [];
    const { calls } = connectableRuntime(registry, 'connectable', {
      stat: async (path) => {
        stats.push(path);
        return { isDirectory: true };
      },
    });

    await expect(binding.connectAndSwitch('connectable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      runtimeId: 'connectable',
      cwd: '/remote/work',
    });
    expect(calls).toEqual(['connect']);
    expect(stats).toEqual(['/remote/work']);
    expect(binding.current).toMatchObject({ runtimeId: 'connectable', cwd: '/remote/work' });
    expect(dispatched.at(-1)).toMatchObject({ runtimeId: 'connectable', cwd: '/remote/work' });
  });

  it('keeps the old binding when the connect fails', async () => {
    const { registry, binding } = setup();
    const fake = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'failing', generation: 'failing-pending' },
      { status: 'disconnected', capabilities: [] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        throw new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
      },
    }));

    await expect(binding.connectAndSwitch('failing', '/remote/work')).rejects.toThrow(/code 255/);
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('keeps the old binding and reports runtime.invalid_cwd when the cwd check fails', async () => {
    const { registry, binding, dispatched } = setup();
    connectableRuntime(registry, 'invalid-stat', {
      stat: async (path) => {
        throw new Error(`ENOENT: ${path}`);
      },
    });

    await expect(binding.connectAndSwitch('invalid-stat', '/missing')).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.invalid_cwd' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
    expect(dispatched).toHaveLength(0);
  });

  it('rejects a non-directory cwd and a missing cwd for non-local runtimes', async () => {
    const { registry, binding } = setup();
    connectableRuntime(registry, 'non-dir', { stat: async () => ({ isDirectory: false }) });

    await expect(binding.connectAndSwitch('non-dir', '/remote/file')).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.invalid_cwd' }),
    );
    await expect(binding.connectAndSwitch('non-dir')).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.invalid_cwd' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('raises runtime.unavailable for a disconnected runtime that cannot connect', async () => {
    const { registry, binding } = setup();
    registry.register(runtime('offline', 'offline-one', 'disconnected'));

    await expect(binding.connectAndSwitch('offline', '/work')).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
  });

  it('skips connecting when the target is already available', async () => {
    const { registry, binding } = setup();
    const stats: string[] = [];
    const fake = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'already-ready', generation: 'already-ready-one' },
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
      runtimeId: 'already-ready',
      cwd: '/remote/work',
    });
    expect(stats).toEqual(['/remote/work']);
  });

  it('re-roots the connected runtime with the validated cwd before committing', async () => {
    const { registry, binding } = setup();
    const { calls, rerootCalls } = connectableRuntime(registry, 'rootable', { reroot: async () => {} });

    await expect(binding.connectAndSwitch('rootable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      runtimeId: 'rootable',
      cwd: '/remote/work',
    });
    expect(calls).toEqual(['connect']);
    expect(rerootCalls).toEqual(['/remote/work']);
    expect(binding.current).toMatchObject({ runtimeId: 'rootable', cwd: '/remote/work' });
  });

  it('does not reroot when the cwd validation fails', async () => {
    const { registry, binding } = setup();
    const { rerootCalls } = connectableRuntime(registry, 'invalid-root', {
      stat: async (path) => {
        throw new Error(`ENOENT: ${path}`);
      },
      reroot: async () => {},
    });

    await expect(binding.connectAndSwitch('invalid-root', '/missing')).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.invalid_cwd' }),
    );
    expect(rerootCalls).toEqual([]);
  });

  it('keeps the old binding when the reroot fails', async () => {
    const { registry, binding, dispatched } = setup();
    connectableRuntime(registry, 'failing-root', {
      reroot: async () => {
        throw new Error('registry drained');
      },
    });

    await expect(binding.connectAndSwitch('failing-root', '/remote/work')).rejects.toThrow('registry drained');
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local' });
    expect(dispatched).toHaveLength(0);
  });

  it('does not reroot when switching back to local', async () => {
    const { registry, binding } = setup();
    const { rerootCalls } = connectableRuntime(registry, 'rootable', { reroot: async () => {} });

    await binding.connectAndSwitch('rootable', '/remote/work');
    await binding.connectAndSwitch('local');

    expect(rerootCalls).toEqual(['/remote/work']);
    expect(binding.current).toEqual({ workspaceId: 'workspace', runtimeId: 'local', cwd: undefined });
  });
});

describe('AgentRuntimeService reconnect', () => {
  it('delegates to the connect method of the bound runtime', async () => {
    const { registry, binding, agentRuntime } = setup();
    const calls: string[] = [];
    const fake = new FakeRuntime(
      { workspaceId: 'workspace', runtimeId: 'reconnectable', generation: 'reconnectable-one' },
      { status: 'ready', capabilities: ['process'] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        calls.push('connect');
      },
      process: {},
    }));
    binding.switch('reconnectable');

    await agentRuntime.reconnect();
    expect(calls).toEqual(['connect']);
  });

  it('raises runtime.unavailable when the bound runtime cannot reconnect', async () => {
    const { agentRuntime } = setup();
    await expect(agentRuntime.reconnect()).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );
  });
});

describe('AgentRuntimeService.acquireWhenReady', () => {
  it('acquires a ready runtime without waiting on a readiness signal', async () => {
    const { remote, binding, agentRuntime } = setup();
    binding.switch('remote');
    remote.whenReady = new Promise<void>(() => {});

    const lease = await agentRuntime.acquireWhenReady(['process']);
    expect(lease.runtime.identity).toMatchObject({ runtimeId: 'remote', generation: 'remote-one' });
    lease.dispose();
  });

  it('waits for the in-flight connect of a connecting runtime and acquires once ready', async () => {
    const { remote, binding, agentRuntime } = setup();
    binding.switch('remote');
    remote.setStatus('connecting');
    let releaseReady!: () => void;
    remote.whenReady = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });

    let settled = false;
    const pending = agentRuntime.acquireWhenReady(['process']).then((lease) => {
      settled = true;
      return lease;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    remote.whenReady = undefined;
    remote.setStatus('ready');
    releaseReady();
    const lease = await pending;
    expect(lease.runtime.status).toBe('ready');
    lease.dispose();
  });

  it('rejects with the connect reason when the in-flight connect fails', async () => {
    const { remote, binding, agentRuntime } = setup();
    binding.switch('remote');
    remote.setStatus('connecting');
    const failure = new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
    remote.whenReady = Promise.reject(failure);
    void remote.whenReady.catch(() => {});

    await expect(agentRuntime.acquireWhenReady(['process'])).rejects.toBe(failure);
  });

  it('keeps the immediate runtime.unavailable error for a plainly disconnected runtime', async () => {
    const { remote, binding, agentRuntime } = setup();
    binding.switch('remote');
    remote.setStatus('disconnected');

    await expect(agentRuntime.acquireWhenReady(['process'])).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );
  });

  it('fails when the pinned turn generation changes mid-turn', async () => {
    const { agentRuntime, localRegistration, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });
    await localRegistration.replace(runtime('local', 'local-two', 'ready', ['fs', 'process']));

    await expect(agentRuntime.acquireWhenReady()).rejects.toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'runtime.unavailable' }),
    );

    publishBus('turn.ended', { agentId: 'main' });
    const lease = await agentRuntime.acquireWhenReady();
    expect(lease.runtime.identity.generation).toBe('local-two');
    lease.dispose();
  });
});
