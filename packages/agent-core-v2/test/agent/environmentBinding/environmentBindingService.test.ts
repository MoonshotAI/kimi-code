import { describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import type { LiveRef } from '#/_base/di/instantiation';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { TestInstantiationService } from '#/_base/di/test';
import type { ISessionEventBus } from '#/app/event/eventBus';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentBlobService } from '#/agent/blob/agentBlobService';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import '#/agent/contextMemory/conversationTime';
import { AgentContextMemoryService } from '#/agent/contextMemory/contextMemoryService';
import type { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { IAgentConversationUndoParticipantRegistry } from '#/agent/contextMemory/conversationUndoParticipants';
import type { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { AgentConversationUndoService } from '#/agent/undo/undoService';
import type { IEventService } from '#/app/event/event';
import type { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import type { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ILogService } from '#/_base/log/log';
import { AgentEnvironmentService, acquireOrWhenReady, snapshotAgentEnvironmentBinding } from '#/agent/environmentBinding/agentEnvironment';
import { AgentEnvironmentBindingService, agentEnvironmentBindingKey, ENVIRONMENT_BINDING_REMINDER_VARIANT, PROJECT_CONTEXT_REMINDER_VARIANT } from '#/agent/environmentBinding/environmentBindingService';
import { environmentBindingKey, EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import type { IConfigService } from '#/app/config/config';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { IAgentLoopService } from '#/agent/loop/loop';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { planKey } from '#/features/plan/planOps';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import type { Environment, EnvironmentBinding, EnvironmentCapability, EnvironmentLease } from '#/environment/environment';
import { EnvironmentError, EnvironmentRegistry, type EnvironmentRegistrationHandle } from '#/environment/environmentRegistry';
import type { IHostFileSystem, HostFileStat } from '#/os/interface/hostFileSystem';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { SessionStateService } from '#/session/state/sessionStateService';
import { EventDispatcherService } from '#/state/eventDispatcherService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { WireService } from '#/wire/wireService';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import {
  workspaceContextAdditionalDirsKey,
  workspaceContextWorkDirKey,
} from '#/session/workspaceContext/workspaceContextService';
import type {
  IEnvironmentResolver,
  IWorkspaceInstanceManager,
} from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { stubAgentContext } from '../agentContext/stubs';
import { noopLogger, recordingWireLog } from '../../wire/stubs';
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

function stubAppendLog(records: WireRecord[]): IAppendLogStore {
  return {
    _serviceBrand: undefined,
    read: async function* <R>(): AsyncIterable<R> {
      for (const record of records) yield record as R;
    },
  } as unknown as IAppendLogStore;
}

function declarationService(registry: EnvironmentRegistry, appendLog: IAppendLogStore): IEnvironmentDeclarationService {
  return new EnvironmentDeclarationService(
    { _serviceBrand: undefined, ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService,
    { _serviceBrand: undefined } as unknown as IHostFileSystem,
    { _serviceBrand: undefined, get: async () => undefined } as unknown as IAtomicDocumentStore,
    appendLog,
    stubBootstrap(),
    {
      _serviceBrand: undefined,
      get: () => ({ environments: registry, root: '/workspace' }),
    } as unknown as IWorkspaceInstanceManager,
    noopLogger,
  );
}

const BOOTSTRAP_HOME = '/kimi-home';

function stubBootstrap(): IBootstrapService {
  return {
    _serviceBrand: undefined,
    homeDir: BOOTSTRAP_HOME,
  } as unknown as IBootstrapService;
}

function stubLoop(loopState: {
  turn?: { turnId: number; phase: string; step: number; activeToolCalls: { toolCallId: string; name: string }[] };
}): LiveRef<IAgentLoopService> {
  return {
    current: {
      snapshot: () => ({
        state: 'running',
        queue: [],
        notificationCount: 0,
        paused: false,
        hasPendingRequests: false,
        turn: loopState.turn,
      }),
      tryAcquireQuiescence: () => ({ dispose: () => {} }),
      resetMachineEngine: async () => {},
    } as unknown as IAgentLoopService,
    onDidChange: () => ({ dispose: () => {} }),
  };
}

function registryResolver(registry: EnvironmentRegistry): IEnvironmentResolver {
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

function setup(options: { agentId?: string; sessionCwd?: string; seedBinding?: EnvironmentBinding } = {}) {
  const registry = new EnvironmentRegistry('workspace', 50);
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
  const activeToolCalls: { toolCallId: string; name: string }[] = [];
  const loopState: {
    turn?: { turnId: number; phase: string; step: number; activeToolCalls: { toolCallId: string; name: string }[] };
  } = { turn: undefined };
  const loop = stubLoop(loopState);
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
  const appendLogRecords: WireRecord[] = [];
  const appendLog = stubAppendLog(appendLogRecords);
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
  const makeAgent = (agentId: string) => {
    const agentScopeContext = stubScopeContext(agentId);
    const agentState = new AgentStateService();
    const agentBinding = new AgentEnvironmentBindingService(
      agentScopeContext,
      agentState,
      { _serviceBrand: undefined, binding: options.seedBinding ?? { workspaceId: 'workspace', environmentId: 'local' } },
      session,
      workspaceContext,
      resolver,
      dispatcher,
      loop,
      reminder,
      declarationService(registry, appendLog),
      noopLogger,
      {
        _serviceBrand: undefined,
        register: () => ({ dispose: () => {} }),
        list: () => [],
      } as unknown as IAgentConversationUndoParticipantRegistry,
      stubBootstrap(),
    );
    return {
      binding: agentBinding,
      agentEnvironment: new AgentEnvironmentService(agentScopeContext, agentBinding, resolver, workspaces, eventBus, session, sessionState),
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
    makeAgent,
    agentEnvironment: main.agentEnvironment,
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

  it('applies the workDir switch immediately even while a turn is between tool calls', () => {
    const { binding, loopState, workDirWrites, publishBus } = setup();
    loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [] };

    expect(binding.switch('remote', '/remote/work').environmentId).toBe('remote');
    expect(binding.current).toMatchObject({ environmentId: 'remote', cwd: '/remote/work' });
    expect(workDirWrites).toEqual(['/remote/work']);

    loopState.turn = undefined;
    binding.switch('local');
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);

    publishBus('turn.ended', { agentId: 'main' });
    expect(workDirWrites).toEqual(['/remote/work', '/workspace']);
  });

  it('does not push workDir for non-main agents', () => {
    const { binding, workDirWrites } = setup({ agentId: 'agent-1' });
    binding.switch('remote', '/remote/work');
    expect(workDirWrites).toEqual([]);
  });

  it('re-pins the turn binding and generation when the binding switches mid-turn', () => {
    const { binding, agentEnvironment, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });

    binding.switch('remote');
    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    lease.dispose();

    publishBus('turn.ended', { agentId: 'main' });
    const next = agentEnvironment.acquire();
    expect(next.environment.identity).toMatchObject({ environmentId: 'remote', generation: 'remote-one' });
    next.dispose();
  });

  it('moves the turn lease to the new environment when the binding switches mid-turn', () => {
    const { registry, binding, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });
    expect(registry.idleEnvironments()).not.toContain('local');
    expect(registry.idleEnvironments()).toContain('remote');

    binding.switch('remote');
    expect(registry.idleEnvironments()).toContain('local');
    expect(registry.idleEnvironments()).not.toContain('remote');

    publishBus('turn.ended', { agentId: 'main' });
    expect(registry.idleEnvironments()).toContain('remote');
  });

  it('runs the next tool call of the same turn on the new environment after a change_environment commit', async () => {
    const { registry, binding, agentEnvironment, loopState, publishBus } = setup();
    connectableEnvironment(registry, { environmentId: 'connectable' });
    publishBus('turn.started', { agentId: 'main' });
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };

    const before = agentEnvironment.acquire();
    expect(before.environment.identity.environmentId).toBe('local');
    before.dispose();

    await binding.connectAndSwitchInTurn('connectable', '/remote/work');

    const after = agentEnvironment.acquire();
    expect(after.environment.identity.environmentId).toBe('connectable');
    after.dispose();

    loopState.turn = undefined;
    publishBus('turn.ended', { agentId: 'main' });
  });

  it('rejects the switch while parallel tool calls are in flight and keeps them on the old environment', async () => {
    const { registry, binding, agentEnvironment, loopState, publishBus } = setup();
    connectableEnvironment(registry, { environmentId: 'connectable' });
    publishBus('turn.started', { agentId: 'main' });
    loopState.turn = {
      turnId: 1,
      phase: 'tool_call',
      step: 1,
      activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }, { toolCallId: 'call-2', name: 'Bash' }],
    };

    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    expect(binding.current.environmentId).toBe('local');

    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity.environmentId).toBe('local');
    lease.dispose();

    loopState.turn = undefined;
    publishBus('turn.ended', { agentId: 'main' });
    await Promise.resolve();
    expect(binding.current.environmentId).toBe('local');
  });

  it('leases the pinned environment for the turn duration so it never reports idle', () => {
    const { registry, publishBus } = setup();
    expect(registry.idleEnvironments()).toContain('local');

    publishBus('turn.started', { agentId: 'main' });
    expect(registry.idleEnvironments()).not.toContain('local');

    publishBus('turn.ended', { agentId: 'main' });
    expect(registry.idleEnvironments()).toContain('local');
  });

  it('releases the turn lease when the service is disposed mid-turn', () => {
    const { registry, agentEnvironment, publishBus } = setup();
    publishBus('turn.started', { agentId: 'main' });
    expect(registry.idleEnvironments()).not.toContain('local');

    agentEnvironment.dispose();
    expect(registry.idleEnvironments()).toContain('local');
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

  it('keeps turn acquires working when another session switches cwd on the pinned environment', async () => {
    const { binding, agentEnvironment, registry, publishBus, makeAgent } = setup();
    connectableEnvironment(registry, { environmentId: 'shared', status: 'ready' });
    binding.switch('shared', '/remote/work');
    publishBus('turn.started', { agentId: 'main' });

    const other = makeAgent('agent-2');
    await other.binding.connectAndSwitch('shared', '/remote/other');

    const lease = agentEnvironment.acquire();
    expect(lease.environment.identity).toMatchObject({ environmentId: 'shared', generation: 'shared-pending' });
    lease.dispose();

    publishBus('turn.ended', { agentId: 'main' });
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
  it('does not reseed a remote binding from raw wire records that replay excluded', async () => {
    const { binding, restoreHooks, dispatched, reminders, appendLogRecords } = setup({ agentId: 'agent-1' });
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'remote', cwd: '/remote/work', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched.at(-1)).toMatchObject({ agentId: 'agent-1', workspaceId: 'workspace', environmentId: 'local' });
    expect(reminders).toEqual([]);
  });

  it('does not connect or reroot when raw wire records name a connectable environment', async () => {
    const { registry, binding, restoreHooks, appendLogRecords } = setup({ agentId: 'agent-1' });
    const { connectCalls } = connectableEnvironment(registry, { environmentId: 'connectable' });
    appendLogRecords.push({ type: 'environment.set_binding', agentId: 'agent-1', environmentId: 'connectable', cwd: '/connectable/work', time: 2 });

    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    expect(connectCalls).toEqual([]);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
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
      content: reminderText('remote', REMOTE_HOST, '/remote/work'),
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
    expect(reminders[0]!.content).toBe(reminderText('remote', REMOTE_HOST, '/remote/work'));
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
    expect(reminders[1]!.content).toBe(reminderText('local', LOCAL_HOST, '/workspace'));
  });

  it('emits no reminder for a local to local transition with only a cwd change', () => {
    const { binding, reminders } = setup();

    binding.switch('local', '/workspace');

    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: '/workspace' });
    expect(reminders).toHaveLength(0);
  });

  it('emits the reminder on a remote to remote switch', () => {
    const { binding, registry, reminders } = setup();
    const host = {
      osKind: 'Linux',
      osArch: 'x86_64',
      osVersion: '5.15-remote-two',
      shellName: 'bash',
      shellPath: '/usr/bin/bash',
    } as const;
    registry.register(environment('remote-two', 'remote-two-one', 'ready', ['process'], host));

    binding.switch('remote', '/remote/work');
    binding.switch('remote-two', '/remote/two');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(reminderText('remote-two', host, '/remote/two'));
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
    registry.register(environment('remote-two', 'remote-two-one', 'ready', ['process'], REMOTE_HOST));

    binding.switch('remote', '/remote/work');
    binding.switch('remote-two', '/remote/two');

    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.content).toBe(reminderText('remote-two', REMOTE_HOST, '/remote/two'));
  });

  it('does not emit reminders for non-main agents', () => {
    const { binding, reminders } = setup({ agentId: 'agent-1' });

    binding.switch('remote', '/remote/work');

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
    { workspaceId: 'workspace', environmentId, generation: `${environmentId}-one` },
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

    binding.switch('remote-view', '/remote/work/sub');
    await flushProbe();

    expect(reminders.map((reminder) => reminder.variant)).toEqual([
      ENVIRONMENT_BINDING_REMINDER_VARIANT,
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

  it('injects nothing when the same view is revisited within the session', async () => {
    const { registry, binding, reminders } = setup();
    const fs = probeFs({ '/remote/work/AGENTS.md': 'remote instructions' }, ['/remote/work/.git']);
    registry.register(probingEnvironment('remote-view', REMOTE_HOST, fs));

    binding.switch('remote-view', '/remote/work');
    await flushProbe();
    binding.switch('local');
    await flushProbe();
    binding.switch('remote-view', '/remote/work');
    await flushProbe();

    expect(projectContextReminders(reminders)).toHaveLength(1);
  });

  it('injects on a remote to same-host remote switch because the view is new', async () => {
    const { registry, binding, reminders } = setup();
    registry.register(
      probingEnvironment('remote-one', REMOTE_HOST, probeFs({ '/remote/one/AGENTS.md': 'one' }, ['/remote/one/.git'])),
    );
    registry.register(
      probingEnvironment('remote-two', REMOTE_HOST, probeFs({ '/remote/two/AGENTS.md': 'two' }, ['/remote/two/.git'])),
    );

    binding.switch('remote-one', '/remote/one');
    await flushProbe();
    binding.switch('remote-two', '/remote/two');
    await flushProbe();

    const injected = projectContextReminders(reminders);
    expect(injected).toHaveLength(2);
    expect(injected[1]!.content).toContain('"remote-two"');
    expect(injected[1]!.content).toContain('- /remote/two/AGENTS.md');
  });

  it('injects the local paths when a session created remote switches to local for the first time', async () => {
    const { binding, local, reminders } = setup({
      seedBinding: { workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' },
    });
    Object.assign(local, { fs: probeFs({ '/workspace/AGENTS.md': 'local instructions' }, ['/workspace/.git']) });

    binding.switch('local');
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

    binding.switch('local', '/other');
    await flushProbe();

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.variant).toBe(PROJECT_CONTEXT_REMINDER_VARIANT);
    expect(reminders[0]!.content).toContain('at working directory /other');
    expect(reminders[0]!.content).toContain('- /other/AGENTS.md');
  });

  it('injects nothing when the new view has no AGENTS.md files', async () => {
    const { registry, binding, reminders } = setup();
    registry.register(probingEnvironment('bare-remote', REMOTE_HOST, probeFs({})));

    binding.switch('bare-remote', '/bare/work');
    await flushProbe();

    expect(projectContextReminders(reminders)).toHaveLength(0);
  });

  it('does not inject for non-main agents', async () => {
    const { registry, binding, reminders } = setup({ agentId: 'agent-1' });
    const fs = probeFs({ '/remote/work/AGENTS.md': 'remote instructions' }, ['/remote/work/.git']);
    registry.register(probingEnvironment('remote-view', REMOTE_HOST, fs));

    binding.switch('remote-view', '/remote/work');
    await flushProbe();

    expect(reminders).toHaveLength(0);
  });
});

describe('AgentEnvironmentBindingService.connectAndSwitch', () => {
  it('connects a disconnected environment, validates the cwd with the target fs, and commits', async () => {
    const { registry, binding, dispatched } = setup();
    const stats: string[] = [];
    const { connectCalls } = connectableEnvironment(registry, {
      environmentId: 'connectable',
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
    expect(connectCalls).toEqual(['connect']);
    expect(stats).toContain('/remote/work');
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

  it('keeps the old binding without dispatch when the cwd check fails', async () => {
    const { registry, binding, dispatched } = setup();
    connectableEnvironment(registry, {
      environmentId: 'invalid-stat',
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
    connectableEnvironment(registry, { environmentId: 'non-dir', stat: async () => ({ isDirectory: false }) });

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
    expect(stats).toContain('/remote/work');
  });

  it('commits the validated cwd without replacing the shared environment generation', async () => {
    const { registry, binding } = setup();
    const { fake, connectCalls } = connectableEnvironment(registry, { environmentId: 'rootable' });

    await binding.connectAndSwitch('rootable', '/remote/work');

    expect(connectCalls).toEqual(['connect']);
    expect(binding.current).toMatchObject({ environmentId: 'rootable', cwd: '/remote/work' });
    const generation = registry.current('rootable')!.identity.generation;
    await binding.connectAndSwitch('rootable', '/remote/other');
    expect(registry.current('rootable')).toBe(fake);
    expect(registry.current('rootable')!.identity.generation).toBe(generation);
  });

  it('keeps other sessions\' tracked resources alive when one session switches cwd', async () => {
    const { registry, binding } = setup();
    connectableEnvironment(registry, { environmentId: 'shared', status: 'ready' });
    const lease = registry.acquire({ workspaceId: 'workspace', environmentId: 'shared' }, []);
    let disposed = false;
    lease.track({ dispose: () => { disposed = true; } });

    await binding.connectAndSwitch('shared', '/remote/work');

    expect(disposed).toBe(false);
    expect(registry.current('shared')).toBe(lease.environment);
    lease.dispose();
  });

  it('leaves the remote environment untouched when switching back to local', async () => {
    const { registry, binding } = setup();
    const { calls } = connectableEnvironment(registry, { environmentId: 'rootable' });

    await binding.connectAndSwitch('rootable', '/remote/work');
    await binding.connectAndSwitch('local');

    expect(calls).toEqual(['connect']);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local', cwd: undefined });
  });
});

describe('AgentEnvironmentBindingService.connectAndSwitchInTurn', () => {
  it('commits immediately when no turn is active', async () => {
    const { registry, binding, dispatched } = setup();
    const { connectCalls } = connectableEnvironment(registry, { environmentId: 'connectable' });

    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      environmentId: 'connectable',
      cwd: '/remote/work',
    });
    expect(connectCalls).toEqual(['connect']);
    expect(binding.current).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
    expect(dispatched.at(-1)).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
  });

  it('connects and validates eagerly and commits immediately when only change_environment is in flight', async () => {
    const { registry, binding, dispatched, loopState, workDirWrites } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };
    const stats: string[] = [];
    const { connectCalls } = connectableEnvironment(registry, {
      environmentId: 'connectable',
      stat: async (path) => {
        stats.push(path);
        return { isDirectory: true };
      },
    });

    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).resolves.toEqual({
      workspaceId: 'workspace',
      environmentId: 'connectable',
      cwd: '/remote/work',
    });
    expect(connectCalls).toEqual(['connect']);
    expect(stats).toContain('/remote/work');
    expect(binding.current).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
    expect(dispatched.at(-1)).toMatchObject({ environmentId: 'connectable', cwd: '/remote/work' });
    expect(workDirWrites).toEqual(['/remote/work']);
  });

  it('fails while other tool calls are in flight and commits nothing at the turn boundary', async () => {
    const { registry, binding, dispatched, loopState, workDirWrites, publishBus, reminders } = setup();
    loopState.turn = {
      turnId: 1,
      phase: 'tool_call',
      step: 1,
      activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }, { toolCallId: 'call-2', name: 'Bash' }],
    };
    const { connectCalls } = connectableEnvironment(registry, { environmentId: 'connectable' });

    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).rejects.toThrowError(
      /1 other tool call\(s\) are in flight; retry when no other calls are running/,
    );
    expect(connectCalls).toEqual([]);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched).toHaveLength(0);
    expect(workDirWrites).toEqual([]);
    expect(reminders).toHaveLength(0);

    loopState.turn = undefined;
    publishBus('turn.ended', { agentId: 'main' });
    await Promise.resolve();
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    expect(dispatched).toHaveLength(0);
  });

  it('keeps the old binding when the eager connect fails', async () => {
    const { registry, binding, loopState } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls: [] };
    const fake = new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'failing', generation: 'failing-pending' },
      { status: 'disconnected', capabilities: [] },
    );
    registry.register(Object.assign(fake, {
      connect: async () => {
        throw new Error('executor process exited before the handshake completed (code 255, signal null)');
      },
    }));

    await expect(binding.connectAndSwitchInTurn('failing', '/remote/work')).rejects.toThrow(/code 255/);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('commits each sequential switch immediately so the latest one wins within the turn', async () => {
    const { registry, binding, loopState } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };
    connectableEnvironment(registry, { environmentId: 'first' });
    connectableEnvironment(registry, { environmentId: 'second' });

    await binding.connectAndSwitchInTurn('first', '/remote/one');
    expect(binding.current).toMatchObject({ environmentId: 'first', cwd: '/remote/one' });
    await binding.connectAndSwitchInTurn('second', '/remote/two');
    expect(binding.current).toMatchObject({ environmentId: 'second', cwd: '/remote/two' });
  });

  it('rejects every switch while foreign calls stay in flight', async () => {
    const { registry, binding, loopState } = setup();
    loopState.turn = {
      turnId: 1,
      phase: 'tool_call',
      step: 1,
      activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }, { toolCallId: 'call-2', name: 'Bash' }],
    };
    connectableEnvironment(registry, { environmentId: 'first' });
    connectableEnvironment(registry, { environmentId: 'second' });

    await expect(binding.connectAndSwitchInTurn('first', '/remote/one')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    await expect(binding.connectAndSwitchInTurn('second', '/remote/two')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('commits a later switch immediately once foreign calls drain after an earlier rejection', async () => {
    const { registry, binding, dispatched, loopState, publishBus } = setup();
    loopState.turn = {
      turnId: 1,
      phase: 'tool_call',
      step: 1,
      activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }, { toolCallId: 'call-2', name: 'Bash' }],
    };
    connectableEnvironment(registry, { environmentId: 'first' });
    connectableEnvironment(registry, { environmentId: 'second' });

    await expect(binding.connectAndSwitchInTurn('first', '/remote/one')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });

    loopState.turn = { turnId: 1, phase: 'tool_call', step: 2, activeToolCalls: [{ toolCallId: 'call-3', name: 'change_environment' }] };
    await binding.connectAndSwitchInTurn('second', '/remote/two');
    expect(binding.current).toMatchObject({ environmentId: 'second', cwd: '/remote/two' });

    loopState.turn = undefined;
    publishBus('turn.ended', { agentId: 'main' });
    await Promise.resolve();
    expect(binding.current).toMatchObject({ environmentId: 'second', cwd: '/remote/two' });
    expect(dispatched.map((event) => event.environmentId)).toEqual(['second']);
  });

  it('emits the environment reminder immediately when the switch commits mid-turn', async () => {
    const { registry, binding, loopState, reminders } = setup();
    loopState.turn = { turnId: 1, phase: 'tool_call', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };
    connectableEnvironment(registry, { environmentId: 'connectable' });

    await binding.connectAndSwitchInTurn('connectable', '/remote/work');

    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.variant).toBe(ENVIRONMENT_BINDING_REMINDER_VARIANT);
    expect(reminders[0]!.content).toContain('"connectable"');
  });
});

describe('AgentEnvironmentBindingService plan mode guard', () => {
  it('rejects switch, connectAndSwitch, and connectAndSwitchInTurn while plan mode is active', async () => {
    const { registry, state, binding, dispatched } = setup();
    const { connectCalls } = connectableEnvironment(registry, { environmentId: 'connectable' });
    state.contributeState(planKey);
    state.set(planKey, { active: true, id: 'plan-1' });

    expect(() => binding.switch('remote')).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    expect(() => binding.switch('remote')).toThrowError(/exit plan mode first/);
    await expect(binding.connectAndSwitch('connectable', '/remote/work')).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.conflict' }),
    );
    await expect(binding.connectAndSwitchInTurn('connectable', '/remote/work')).rejects.toThrowError(
      /exit plan mode first/,
    );

    expect(connectCalls).toEqual([]);
    expect(dispatched).toHaveLength(0);
    expect(binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
  });

  it('switches again once plan mode is exited', async () => {
    const { registry, state, binding } = setup();
    connectableEnvironment(registry, { environmentId: 'connectable' });
    state.contributeState(planKey);
    state.set(planKey, { active: true, id: 'plan-1' });
    expect(() => binding.switch('remote')).toThrowError(/exit plan mode first/);

    state.set(planKey, { active: false });

    expect(binding.switch('remote')).toEqual({ workspaceId: 'workspace', environmentId: 'remote' });
    await expect(binding.connectAndSwitch('connectable', '/remote/work')).resolves.toMatchObject({
      environmentId: 'connectable',
      cwd: '/remote/work',
    });
  });

  it('leaves non-switch reads and acquires untouched while plan mode is active', () => {
    const { state, binding, agentEnvironment } = setup();
    state.contributeState(planKey);
    state.set(planKey, { active: true, id: 'plan-1' });

    expect(binding.get()).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    const lease = agentEnvironment.acquire(['fs']);
    expect(lease.environment.identity.environmentId).toBe('local');
    lease.dispose();
  });
});

describe('AgentEnvironmentService workspaceRoots', () => {
  it('falls back to the session cwd for a local binding without a cwd', () => {
    const { agentEnvironment } = setup();
    expect(agentEnvironment.workspaceRoots().workDir).toBe('/workspace');
  });

  it('prefers the remote host cwd over the session cwd when the binding carries no cwd', () => {
    const { registry, binding, agentEnvironment } = setup();
    registry.register(environment('remote-cwd', 'remote-cwd-one', 'ready', ['process'], {
      ...REMOTE_HOST,
      cwd: '/remote/initial',
    } as Partial<Environment['host']>));
    binding.switch('remote-cwd');
    expect(agentEnvironment.workspaceRoots().workDir).toBe('/remote/initial');
  });

  it('falls back to the remote homeDir when the host carries no cwd', () => {
    const { binding, agentEnvironment } = setup();
    binding.switch('remote');
    expect(agentEnvironment.workspaceRoots().workDir).toBe('/home/fake');
  });

  it('keeps the binding cwd when the binding carries one', () => {
    const { binding, agentEnvironment } = setup();
    binding.switch('remote', '/remote/work');
    expect(agentEnvironment.workspaceRoots().workDir).toBe('/remote/work');
  });

  it('falls back to the session cwd when the bound environment cannot be inspected', () => {
    const { agentEnvironment } = setup({
      seedBinding: { workspaceId: 'workspace', environmentId: 'ghost' },
    });
    expect(agentEnvironment.workspaceRoots().workDir).toBe('/workspace');
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

describe('acquireOrWhenReady', () => {
  it('takes the synchronous acquire path when the environment is already available', async () => {
    const { agentEnvironment } = setup();
    const acquire = vi.spyOn(agentEnvironment, 'acquire');
    const whenReady = vi.spyOn(agentEnvironment, 'acquireWhenReady');

    const lease = await acquireOrWhenReady(agentEnvironment, ['fs']);

    expect(acquire).toHaveBeenCalledWith(['fs']);
    expect(whenReady).not.toHaveBeenCalled();
    expect(lease.environment.identity).toMatchObject({ environmentId: 'local', generation: 'local-one' });
    lease.dispose();
  });

  it('falls back to acquireWhenReady when a required capability is missing', async () => {
    const { binding, agentEnvironment } = setup();
    binding.switch('remote');
    const acquire = vi.spyOn(agentEnvironment, 'acquire');
    const whenReady = vi.spyOn(agentEnvironment, 'acquireWhenReady');

    await expect(acquireOrWhenReady(agentEnvironment, ['fs'])).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.capability_unavailable' }),
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(whenReady).toHaveBeenCalledWith(['fs']);
  });

  it('connects a disconnected environment through the whenReady path', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectableEnvironment(registry, { environmentId: 'remote-x', status: 'disconnected' });
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
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
      { workspaceId: 'workspace', environmentId, generation: `${environmentId}-pending` },
      { status: 'disconnected', capabilities: ['fs', 'process'] },
    );
    registration = registry.register(Object.assign(pending, {
      fs: {},
      process: {},
      connect: async () => {
        calls.push('connect');
        attempts += 1;
        if (options.failFirst === true && attempts === 1) throw new Error('connect failed');
        await registration.replace(Object.assign(new FakeEnvironment(
          { workspaceId: 'workspace', environmentId, generation: `${environmentId}-ready` },
          { status: 'ready', capabilities: ['fs', 'process'] },
        ), { fs: {}, process: {} }));
      },
    }));
    return { calls, registration };
  }

  it('connects a restored disconnected environment on the first acquireWhenReady and keeps serving the turn', async () => {
    const { registry, state, restoreHooks, agentEnvironment, publishBus } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
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

  it('takes the turn lease once the pinned environment connects mid-turn', async () => {
    const { registry, state, restoreHooks, agentEnvironment, publishBus } = setup();
    connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    publishBus('turn.started', { agentId: 'main' });
    expect(registry.idleEnvironments()).toContain('remote-x');

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    lease.dispose();
    expect(registry.idleEnvironments()).not.toContain('remote-x');

    publishBus('turn.ended', { agentId: 'main' });
    expect(registry.idleEnvironments()).toContain('remote-x');
  });

  it('connects on demand without an active turn', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    lease.dispose();
  });

  it('adopts the generation another session connected before the first turn acquire without reconnecting', async () => {
    const { registry, state, restoreHooks, agentEnvironment, publishBus } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    publishBus('turn.started', { agentId: 'main' });

    await registry.current('remote-x')!.connect!();
    expect(calls).toEqual(['connect']);

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    lease.dispose();

    const next = agentEnvironment.acquire(['fs']);
    expect(next.environment.identity.generation).toBe('remote-x-ready');
    next.dispose();
    publishBus('turn.ended', { agentId: 'main' });
  });

  it('rejects turn acquires once the on-demand-connected generation is replaced mid-turn', async () => {
    const { registry, state, restoreHooks, agentEnvironment, publishBus } = setup();
    const { registration } = connectSwappingEnvironment(registry, 'remote-x');
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});
    publishBus('turn.started', { agentId: 'main' });

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    lease.dispose();

    await registration.replace(Object.assign(new FakeEnvironment(
      { workspaceId: 'workspace', environmentId: 'remote-x', generation: 'remote-x-two' },
      { status: 'ready', capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));

    expect(() => agentEnvironment.acquire(['fs'])).toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    await expect(agentEnvironment.acquireWhenReady(['fs'])).rejects.toThrowError(
      expect.objectContaining<Partial<EnvironmentError>>({ code: 'environment.unavailable' }),
    );
    publishBus('turn.ended', { agentId: 'main' });
  });

  it('propagates a failed on-demand connect and retries on the next call', async () => {
    const { registry, state, restoreHooks, agentEnvironment } = setup();
    const { calls } = connectSwappingEnvironment(registry, 'remote-x', { failFirst: true });
    state.set(environmentBindingKey, { workspaceId: 'workspace', environmentId: 'remote-x', cwd: '/remote/x' });
    await restoreHooks.get('agent-environment-binding')?.(undefined, async () => {});

    await expect(agentEnvironment.acquireWhenReady(['fs'])).rejects.toThrow('connect failed');

    const lease = await agentEnvironment.acquireWhenReady(['fs']);
    expect(calls).toEqual(['connect', 'connect']);
    expect(lease.environment.identity.generation).toBe('remote-x-ready');
    lease.dispose();
  });
});

const noopBlob: IAgentBlobService = {
  _serviceBrand: undefined,
  offloadParts: async (parts) => parts,
  loadParts: async (parts) => parts,
  isBlobRef: () => false,
};

function stubWireJournal(journal: WireRecord[]): IWireService {
  return {
    _serviceBrand: undefined,
    seal: async () => {},
    appendRecord: (record) => {
      journal.push(record);
    },
    append: (record) => {
      journal.push(record);
    },
    readJournal: async function* () {
      for (const record of journal) yield record;
    },
    readRestorable: async function* () {
      for (const record of journal) yield record;
    },
    readRestoreChains: async () => ({ restorable: [...journal], journal: [...journal] }),
    readHumanChain: () => [],
    read: async function* () {
      for (const record of journal) yield record;
    },
    readRaw: async function* () {
      for (const record of journal) yield record;
    },
    journalRef: { tree: 'stub', branch: 'main' },
    switchBranch: async () => {
      throw new Error('stubWireJournal.switchBranch is not implemented');
    },
    branches: () => ['main'],
    nextSeq: () => journal.length + 1,
    settled: async () => {},
    flush: async () => {},
    drainPersisted: async () => {},
    lineCount: () => journal.length,
    lastContextClearLine: () => undefined,
    journalPath: () => undefined,
  };
}

interface UndoHarness {
  readonly binding: AgentEnvironmentBindingService;
  readonly dispatcher: IEventDispatcher;
  readonly journal: WireRecord[];
  readonly appendLogRecords: WireRecord[];
  readonly participant: { reconcileAfterUndo(): Promise<void> };
  readonly workDirWrites: string[];
  readonly reminders: { content: string; variant: string }[];
  readonly changes: EnvironmentBinding[];
  readonly dispose: () => Promise<void>;
}

function undoSetup(): UndoHarness {
  const registry = new EnvironmentRegistry('workspace');
  registry.register(environment('local', 'local-one', 'ready', ['fs', 'process'], LOCAL_HOST));
  registry.register(environment('remote', 'remote-one', 'ready', ['fs', 'process'], REMOTE_HOST));
  const journal: WireRecord[] = [];
  const appendLogRecords: WireRecord[] = [];
  const wire = stubWireJournal(journal);
  const appendingWire: IWireService = {
    ...wire,
    appendRecord: (record) => {
      appendLogRecords.push(record);
      wire.appendRecord(record);
    },
    append: (record) => {
      appendLogRecords.push(record);
      wire.append(record);
    },
  };
  const ix = new TestInstantiationService();
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IWireService, appendingWire);
  ix.set(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }));
  const agentState = new AgentStateService();
  ix.set(IAgentStateService, agentState);
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const dispatcher = ix.get(IEventDispatcher);
  const session = makeSessionContext({
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    sessionScope: 'sessions/session',
    cwd: '/workspace',
  });
  const workDirWrites: string[] = [];
  const workspaceContext = stubWorkspaceContext(session.cwd, workDirWrites);
  const scopeContext = stubScopeContext('main');
  const reminders: { content: string; variant: string }[] = [];
  const reminder = stubReminder(reminders);
  const appendLog = stubAppendLog(appendLogRecords);
  const loop = stubLoop({});
  const eventBus = {
    subscribe: () => ({ dispose: () => {} }),
    isAgentActive: () => true,
    publish: () => {},
  } as unknown as ISessionEventBus;
  let participant: { reconcileAfterUndo(): Promise<void> } | undefined;
  const undoParticipants = {
    _serviceBrand: undefined,
    register: (entry: { id: string; reconcileAfterUndo(): Promise<void> }) => {
      participant = entry;
      return { dispose: () => {} };
    },
    list: () => (participant === undefined ? [] : [participant]),
  } as unknown as IAgentConversationUndoParticipantRegistry;
  const binding = new AgentEnvironmentBindingService(
    scopeContext,
    agentState,
    { _serviceBrand: undefined, binding: { workspaceId: 'workspace', environmentId: 'local' } },
    session,
    workspaceContext,
    registryResolver(registry),
    dispatcher,
    loop,
    reminder,
    declarationService(registry, appendLog),
    noopLogger,
    undoParticipants,
    stubBootstrap(),
  );
  const changes: EnvironmentBinding[] = [];
  binding.onDidChange((next) => changes.push(next));
  return {
    binding,
    dispatcher,
    journal,
    appendLogRecords,
    participant: {
      reconcileAfterUndo: async () => {
        if (participant === undefined) throw new Error('no undo participant was registered');
        await participant.reconcileAfterUndo();
      },
    },
    workDirWrites,
    reminders,
    changes,
    dispose: async () => {
      binding.dispose();
      ix.dispose();
      await registry.dispose();
    },
  };
}

describe('AgentEnvironmentBindingService conversation undo', () => {
  it('reverts the binding, workDir, and reminder on undo across a switch', async () => {
    const harness = undoSetup();
    try {
      await harness.dispatcher.restore();
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });

      harness.binding.switch('remote', '/remote/work');
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
      expect(harness.journal.map((record) => record['environmentId'])).toEqual(['local', 'remote']);

      harness.journal.pop();
      await harness.dispatcher.restore();
      await harness.participant.reconcileAfterUndo();

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.workDirWrites.at(-1)).toBe('/workspace');
      expect(harness.reminders.at(-1)).toMatchObject({ variant: ENVIRONMENT_BINDING_REMINDER_VARIANT });
      expect(harness.reminders.at(-1)!.content).toContain('"local"');
      expect(harness.changes.at(-1)).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.appendLogRecords.map((record) => record['environmentId'])).toEqual(['local', 'remote']);

      await harness.participant.reconcileAfterUndo();
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.reminders).toHaveLength(2);
    } finally {
      await harness.dispose();
    }
  });
});

interface WireUndoHarness {
  readonly binding: AgentEnvironmentBindingService;
  readonly dispatcher: IEventDispatcher;
  readonly wire: IWireService;
  readonly registry: EnvironmentRegistry;
  readonly appendLogRecords: WireRecord[];
  readonly participant: { reconcileAfterUndo(): Promise<void> };
  readonly context?: IAgentContextMemoryService;
  readonly undo?: AgentConversationUndoService;
  readonly workDirWrites: string[];
  readonly reminders: { content: string; variant: string }[];
  readonly changes: EnvironmentBinding[];
  readonly loopState: {
    turn?: { turnId: number; phase: string; step: number; activeToolCalls: { toolCallId: string; name: string }[] };
  };
  readonly publishBus: (type: string, event: { readonly agentId?: string }) => void;
  readonly dispose: () => Promise<void>;
}

function wireUndoSetup(options: { readonly withUndo?: boolean; readonly withContextReminders?: boolean; readonly journal?: readonly WireRecord[] } = {}): WireUndoHarness {
  const registry = new EnvironmentRegistry('workspace');
  registry.register(environment('local', 'local-one', 'ready', ['fs', 'process'], LOCAL_HOST));
  const remote = environment('remote', 'remote-one', 'ready', ['fs', 'process'], REMOTE_HOST);
  Object.assign(remote, { fs: { stat: async () => ({ isDirectory: true }) } });
  registry.register(remote);
  const appendLogRecords: WireRecord[] = [...options.journal ?? []];
  const appendLog = recordingWireLog(appendLogRecords);
  const ix = new TestInstantiationService();
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentBlobService, noopBlob);
  ix.set(IAppendLogStore, appendLog);
  ix.set(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(ITelemetryService, noopTelemetryService);
  ix.set(ILogService, noopLogger);
  const ixScopeContext = makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' });
  ix.set(IAgentScopeContext, ixScopeContext);
  const agentState = new AgentStateService();
  ix.set(IAgentStateService, agentState);
  ix.set(IWireService, new SyncDescriptor(WireService));
  ix.set(IEventDispatcher, new SyncDescriptor(EventDispatcherService));
  const wire = ix.get(IWireService);
  const dispatcher = ix.get(IEventDispatcher);
  const session = makeSessionContext({
    sessionId: 'session',
    workspaceId: 'workspace',
    sessionDir: '/session',
    sessionScope: 'sessions/session',
    cwd: '/workspace',
  });
  const workDirWrites: string[] = [];
  const workspaceContext = stubWorkspaceContext(session.cwd, workDirWrites);
  const scopeContext = stubScopeContext('main');
  const reminders: { content: string; variant: string }[] = [];
  const loopState: WireUndoHarness['loopState'] = { turn: undefined };
  const loop = stubLoop(loopState);
  const busHandlers = new Map<string, ((event: { readonly agentId?: string }) => void)[]>();
  const eventBus = {
    subscribe: (cls: { readonly type: string }, handler: (event: { readonly agentId?: string }) => void) => {
      const handlers = busHandlers.get(cls.type) ?? [];
      handlers.push(handler);
      busHandlers.set(cls.type, handlers);
      return { dispose: () => {} };
    },
    isAgentActive: () => true,
    publish: () => {},
  } as unknown as ISessionEventBus;
  const publishBus = (type: string, event: { readonly agentId?: string }): void => {
    for (const handler of busHandlers.get(type) ?? []) handler(event);
  };
  let participant: { reconcileAfterUndo(): Promise<void> } | undefined;
  const undoParticipants = {
    _serviceBrand: undefined,
    register: (entry: { id: string; reconcileAfterUndo(): Promise<void> }) => {
      participant = entry;
      return { dispose: () => {} };
    },
    list: () => (participant === undefined ? [] : [participant]),
  } as unknown as IAgentConversationUndoParticipantRegistry;
  const tokenCounting = {
    _serviceBrand: undefined,
    recordTruncation: () => {},
    estimateText: () => 0,
    estimateMessage: () => 0,
    estimateMessages: () => 0,
  } as unknown as ISessionTokenCountingService;
  let context: AgentContextMemoryService | undefined;
  let undo: AgentConversationUndoService | undefined;
  let reminder = stubReminder(reminders);
  if (options.withUndo === true) {
    (ix.get(IEventBus) as EventBusService).activateAgent(ixScopeContext.agentContext);
    context = new AgentContextMemoryService(dispatcher, scopeContext, tokenCounting, agentState);
    if (options.withContextReminders === true) {
      const contextMemory = context;
      reminder = {
        _serviceBrand: undefined,
        notify: (content: string, notification: { variant: string; ownerPromptId?: string }) => {
          reminders.push({ content, variant: notification.variant });
          contextMemory.append({
            role: 'user',
            content: [{ type: 'text', text: wrapSystemReminder(content) }],
            toolCalls: [],
            origin: { kind: 'injection', variant: notification.variant, ownerPromptId: notification.ownerPromptId },
          });
        },
      } as unknown as IAgentReminderService;
    }
    undo = new AgentConversationUndoService(
      loop.current as IAgentLoopService,
      { _serviceBrand: undefined, compacting: null } as unknown as IAgentFullCompactionService,
      context,
      undoParticipants,
      scopeContext,
      session,
      { _serviceBrand: undefined, update: async () => {} } as unknown as ISessionMetadata,
      { _serviceBrand: undefined, publish: () => {} } as unknown as IEventService,
      noopTelemetryService,
      dispatcher,
      agentState,
      tokenCounting,
      wire,
      noopLogger,
    );
  }
  const binding = new AgentEnvironmentBindingService(
    scopeContext,
    agentState,
    { _serviceBrand: undefined, binding: { workspaceId: 'workspace', environmentId: 'local' } },
    session,
    workspaceContext,
    registryResolver(registry),
    dispatcher,
    loop,
    reminder,
    declarationService(registry, appendLog),
    noopLogger,
    undoParticipants,
    stubBootstrap(),
  );
  const changes: EnvironmentBinding[] = [];
  binding.onDidChange((next) => changes.push(next));
  return {
    binding,
    dispatcher,
    wire,
    registry,
    appendLogRecords,
    participant: {
      reconcileAfterUndo: async () => {
        if (participant === undefined) throw new Error('no undo participant was registered');
        await participant.reconcileAfterUndo();
      },
    },
    context,
    undo,
    workDirWrites,
    reminders,
    changes,
    loopState,
    publishBus,
    dispose: async () => {
      undo?.dispose();
      context?.dispose();
      binding.dispose();
      ix.dispose();
      await registry.dispose();
    },
  };
}

describe('AgentEnvironmentBindingService conversation undo over the real wire', () => {
  it('reverts an in-turn switch through the real conversation undo service', async () => {
    const harness = wireUndoSetup({ withUndo: true });
    if (harness.context === undefined || harness.undo === undefined) throw new Error('undo harness incomplete');
    const { context, undo } = harness;
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });

      await harness.dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'switch the environment' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );
      expect(context.get()).toHaveLength(1);

      harness.loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };
      await harness.binding.connectAndSwitchInTurn('remote', '/remote/work');
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
      harness.loopState.turn = undefined;

      await undo.undo(1);

      expect(context.get()).toEqual([]);
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.workDirWrites.at(-1)).toBe('/workspace');
      expect(harness.reminders.at(-1)).toMatchObject({ variant: ENVIRONMENT_BINDING_REMINDER_VARIANT });
      expect(harness.reminders.at(-1)!.content).toContain('"local"');
      expect(harness.changes.at(-1)).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    } finally {
      await harness.dispose();
    }
  });

  it('reverts an in-turn switch across a branch fork and restore', async () => {
    const harness = wireUndoSetup();
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });

      await harness.dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'switch the environment' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );

      harness.loopState.turn = { turnId: 1, phase: 'running', step: 1, activeToolCalls: [{ toolCallId: 'call-1', name: 'change_environment' }] };
      await harness.binding.connectAndSwitchInTurn('remote', '/remote/work');
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });
      harness.loopState.turn = undefined;
      expect(harness.appendLogRecords.map((record) => record.type)).toEqual([
        'metadata',
        'environment.set_binding',
        'context.append_message',
        'environment.set_binding',
      ]);

      await harness.wire.switchBranch({ turns: 1 });
      await harness.dispatcher.restore();
      await harness.participant.reconcileAfterUndo();

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.workDirWrites.at(-1)).toBe('/workspace');
      expect(harness.reminders.at(-1)).toMatchObject({ variant: ENVIRONMENT_BINDING_REMINDER_VARIANT });
      expect(harness.reminders.at(-1)!.content).toContain('"local"');
      expect(harness.changes.at(-1)).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    } finally {
      await harness.dispose();
    }
  });

  it('reverts an out-of-turn switch when the preceding turn is undone', async () => {
    const harness = wireUndoSetup();
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });

      await harness.dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'do some work' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );

      await harness.binding.connectAndSwitch('remote', '/remote/work');
      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work' });

      await harness.wire.switchBranch({ turns: 1 });
      await harness.dispatcher.restore();
      await harness.participant.reconcileAfterUndo();

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.workDirWrites.at(-1)).toBe('/workspace');
      expect(harness.reminders.at(-1)).toMatchObject({ variant: ENVIRONMENT_BINDING_REMINDER_VARIANT });
      expect(harness.reminders.at(-1)!.content).toContain('"local"');
      expect(harness.changes.at(-1)).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
    } finally {
      await harness.dispose();
    }
  });

  it('does not resurrect an undone remote binding when the undo fork crosses the seed record and the session resumes', async () => {
    const harness = wireUndoSetup({
      journal: [
        createWireMetadataRecord(1),
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace', environmentId: 'local', time: 2 },
        {
          type: 'context.append_message',
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'switch the environment' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
          time: 3,
        },
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace', environmentId: 'remote', cwd: '/remote/work', time: 4 },
        { type: 'agent.switched', agentId: 'main', branch: 'b1', base: { branch: 'main', line: 1 }, reason: 'undo', turns: 2, legacyUndoLine: 6, time: 5 },
        { type: 'context.undo', agentId: 'main', count: 2, time: 6 },
        { type: 'context.undone', agentId: 'main', turns: 2, time: 7 },
      ],
    });
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      expect(harness.reminders).toEqual([]);
      expect(harness.workDirWrites).toEqual(['/workspace']);
      expect(
        harness.appendLogRecords.filter(
          (record) => record.type === 'environment.set_binding' && record['environmentId'] === 'remote',
        ),
      ).toHaveLength(1);
      expect(harness.appendLogRecords.at(-1)).toMatchObject({ type: 'environment.set_binding', environmentId: 'local' });
    } finally {
      await harness.dispose();
    }
  });
});

function contextReminderTexts(context: IAgentContextMemoryService, marker: string): string[] {
  return context.get()
    .filter((message) => message.origin?.kind === 'injection')
    .map((message) => message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''))
    .filter((text) => text.includes(marker));
}

async function switchEnvironmentInTurn(harness: WireUndoHarness, text: string, turnId: number): Promise<void> {
  await harness.dispatcher.dispatch(
    new ContextAppendMessage({
      agentId: 'main',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
        toolCalls: [],
        origin: { kind: 'user' },
      },
    }),
  );
  harness.loopState.turn = { turnId, phase: 'running', step: 1, activeToolCalls: [{ toolCallId: `call-${turnId}`, name: 'change_environment' }] };
  await harness.binding.connectAndSwitchInTurn('remote', '/remote/work');
  harness.loopState.turn = undefined;
}

describe('AgentEnvironmentBindingService reminder context across undo', () => {
  it('evicts the in-turn switch reminder from the model context when the turn is undone', async () => {
    const harness = wireUndoSetup({ withUndo: true, withContextReminders: true });
    if (harness.context === undefined || harness.undo === undefined) throw new Error('undo harness incomplete');
    const { context, undo } = harness;
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();
      await switchEnvironmentInTurn(harness, 'switch the environment', 1);
      expect(contextReminderTexts(context, 'The active environment is now')).toHaveLength(1);
      expect(contextReminderTexts(context, 'The active environment is now')[0]).toContain('"remote"');

      await undo.undo(1);

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      const envReminders = contextReminderTexts(context, 'The active environment is now');
      expect(envReminders).toHaveLength(1);
      expect(envReminders[0]).toContain('"local"');
    } finally {
      await harness.dispose();
    }
  });

  it('does not accumulate environment reminders across repeated switch and undo cycles', async () => {
    const harness = wireUndoSetup({ withUndo: true, withContextReminders: true });
    if (harness.context === undefined || harness.undo === undefined) throw new Error('undo harness incomplete');
    const { context, undo } = harness;
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();

      await switchEnvironmentInTurn(harness, 'first switch', 1);
      await undo.undo(1);
      await switchEnvironmentInTurn(harness, 'second switch', 2);
      await undo.undo(1);

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      const envReminders = contextReminderTexts(context, 'The active environment is now');
      expect(envReminders).toHaveLength(1);
      expect(envReminders[0]).toContain('"local"');
    } finally {
      await harness.dispose();
    }
  });

  it('evicts an out-of-turn switch reminder from the model context when the preceding turn is undone', async () => {
    const harness = wireUndoSetup({ withUndo: true, withContextReminders: true });
    if (harness.context === undefined || harness.undo === undefined) throw new Error('undo harness incomplete');
    const { context, undo } = harness;
    try {
      await harness.wire.seal();
      await harness.dispatcher.restore();
      await harness.dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'do some work' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );
      await harness.binding.connectAndSwitch('remote', '/remote/work');
      expect(contextReminderTexts(context, 'The active environment is now')[0]).toContain('"remote"');

      await undo.undo(1);

      expect(harness.binding.current).toEqual({ workspaceId: 'workspace', environmentId: 'local' });
      const envReminders = contextReminderTexts(context, 'The active environment is now');
      expect(envReminders).toHaveLength(1);
      expect(envReminders[0]).toContain('"local"');
    } finally {
      await harness.dispose();
    }
  });

  it('evicts a stale project context reminder from an undone view once a new view is probed', async () => {
    const harness = wireUndoSetup({ withUndo: true, withContextReminders: true });
    if (harness.context === undefined || harness.undo === undefined) throw new Error('undo harness incomplete');
    const { context, undo } = harness;
    try {
      harness.registry.register(probingEnvironment('remote-a', REMOTE_HOST, probeFs({ '/remote/a/AGENTS.md': 'a instructions' }, ['/remote/a/.git'])));
      harness.registry.register(probingEnvironment('remote-b', REMOTE_HOST, probeFs({ '/remote/b/AGENTS.md': 'b instructions' }, ['/remote/b/.git'])));
      await harness.wire.seal();
      await harness.dispatcher.restore();

      await harness.dispatcher.dispatch(
        new ContextAppendMessage({
          agentId: 'main',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'switch to a' }],
            toolCalls: [],
            origin: { kind: 'user' },
          },
        }),
      );
      harness.binding.switch('remote-a', '/remote/a');
      await flushProbe();
      expect(contextReminderTexts(context, 'The active project context is now')[0]).toContain('"remote-a"');

      await undo.undo(1);
      harness.binding.switch('remote-b', '/remote/b');
      await flushProbe();

      const projectReminders = contextReminderTexts(context, 'The active project context is now');
      expect(projectReminders).toHaveLength(1);
      expect(projectReminders[0]).toContain('"remote-b"');
      const envReminders = contextReminderTexts(context, 'The active environment is now');
      expect(envReminders).toHaveLength(1);
      expect(envReminders[0]).toContain('"remote-b"');
    } finally {
      await harness.dispose();
    }
  });
});
