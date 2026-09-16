import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import type { LiveRef } from '#/_base/di/instantiation';
import type { ISessionEventBus } from '#/app/event/eventBus';
import { AgentRuntimeService, snapshotAgentRuntimeBinding } from '#/agent/runtimeBinding/agentRuntime';
import { AgentRuntimeBindingService, agentRuntimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingService';
import { runtimeBindingKey, type RuntimeSetBinding } from '#/agent/runtimeBinding/runtimeBindingOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import type { IAgentLoopService } from '#/agent/loop/loop';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
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
): FakeRuntime {
  const value = new FakeRuntime(
    { workspaceId: 'workspace', runtimeId, generation },
    { status, capabilities },
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

function setup(options: { agentId?: string; sessionCwd?: string } = {}) {
  const registry = new RuntimeRegistry('workspace');
  const local = runtime('local', 'local-one', 'ready', ['fs', 'process']);
  const remote = runtime('remote', 'remote-one', 'ready', ['process']);
  const localRegistration = registry.register(local);
  registry.register(remote);
  const resolver: IRuntimeResolver = {
    _serviceBrand: undefined,
    inspect: (binding: RuntimeBinding) => registry.inspect(binding),
    acquire: (binding: RuntimeBinding, required: readonly RuntimeCapability[] = []): RuntimeLease =>
      registry.acquire(binding, required),
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
  const loop: LiveRef<IAgentLoopService> = {
    current: {
      snapshot: () => ({
        state: 'running',
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
        turn: { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls },
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
  const binding = new AgentRuntimeBindingService(
    scopeContext,
    state,
    { _serviceBrand: undefined, binding: { workspaceId: 'workspace', runtimeId: 'local' } },
    session,
    workspaceContext,
    resolver,
    dispatcher,
    loop,
  );
  const workspaceChanges = new Emitter<{ workspaceId: string }>();
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: workspaceChanges.event,
    get: () => ({ runtimes: registry }),
  } as unknown as IWorkspaceInstanceManager;
  const busHandlers = new Map<string, ((event: { readonly agentId?: string }) => void)[]>();
  const eventBus = {
    subscribe: (cls: { readonly type: string }, handler: (event: { readonly agentId?: string }) => void) => {
      const handlers = busHandlers.get(cls.type) ?? [];
      handlers.push(handler);
      busHandlers.set(cls.type, handlers);
      return { dispose: () => {} };
    },
  } as unknown as ISessionEventBus;
  const publishBus = (type: string, event: { readonly agentId?: string }): void => {
    for (const handler of busHandlers.get(type) ?? []) handler(event);
  };
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
    publishBus,
    agentRuntime: new AgentRuntimeService(scopeContext, binding, resolver, workspaces, eventBus),
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
    const { binding, activeToolCalls } = setup();
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
