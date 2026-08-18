import { describe, expect, it } from 'vitest';

import { Emitter } from '#/_base/event';
import { AgentRuntimeService, snapshotAgentRuntimeBinding } from '#/agent/runtimeBinding/agentRuntime';
import { AgentRuntimeBindingService, agentRuntimeBindingKey } from '#/agent/runtimeBinding/runtimeBindingService';
import { AgentStateService } from '#/agent/state/agentStateService';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { Runtime, RuntimeBinding, RuntimeCapability, RuntimeLease } from '#/runtime/runtime';
import { RuntimeError, RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type {
  IRuntimeResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';

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
    watch: capabilities.includes('watch') ? {} : undefined,
    terminal: capabilities.includes('terminal') ? {} : undefined,
  });
}

function setup() {
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
    cwd: '/workspace',
  });
  const dispatcher = {
    _serviceBrand: undefined,
    dispatch: () => Promise.resolve(),
    hooks: { onDidRestore: { register: () => ({ dispose: () => {} }) } },
  } as unknown as IEventDispatcher;
  const binding = new AgentRuntimeBindingService(
    state,
    { _serviceBrand: undefined, binding: { workspaceId: 'workspace', runtimeId: 'local' } },
    session,
    resolver,
    dispatcher,
  );
  const workspaceChanges = new Emitter<{ workspaceId: string }>();
  const workspaces = {
    _serviceBrand: undefined,
    onDidChange: workspaceChanges.event,
    get: () => ({ runtimes: registry }),
  } as unknown as IWorkspaceInstanceManager;
  return {
    registry,
    resolver,
    state,
    binding,
    local,
    remote,
    localRegistration,
    workspaceChanges,
    agentRuntime: new AgentRuntimeService(binding, resolver, workspaces),
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
});
