import { IEnvironmentService } from '#/app/environment/environment';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import type { ILogService } from '#/_base/log/log';
import type { IConfigService } from '#/app/config/config';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { reloadOnStale } from '#/app/sessionManager/sessionLookup';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import { ErrorCodes } from '#/errors';
import { IAgentCronService } from '#/features/cron/cronService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { InMemorySessionLockService } from '#/persistence/backends/memory/sessionLockService';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import { fakeEnvironment, connectableEnvironment } from '../../environment/stubs';
import type {
  SessionArchivedEvent,
  SessionCloseReason,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionCreateSource,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';


function environmentRegistryOf(workspaces: IWorkspaceInstanceManager): EnvironmentRegistry | undefined {
  for (const id of ['workspace', 'workspace-1']) {
    const holder = workspaces.get(id) as { environments?: EnvironmentRegistry } | undefined;
    if (holder?.environments !== undefined) return holder.environments;
  }
  return undefined;
}

function makeSessionManager(
  workspaces: IWorkspaceInstanceManager,
  index: ISessionIndex,
  overrides: {
    readonly config?: IConfigService;
    readonly hostFs?: IHostFileSystem;
    readonly locks?: InMemorySessionLockService;
  } = {},
): SessionManager {
  const log = { _serviceBrand: undefined, warn: () => {}, info: () => {}, error: () => {} } as unknown as ILogService;
  const environments = {
    ready: Promise.resolve(),
    current: (id: string) => environmentRegistryOf(workspaces)?.current(id),
    acquire: (binding: { environmentId: string }, required: never) => {
      const registry = environmentRegistryOf(workspaces);
      if (registry === undefined) throw new Error('environment registry is not stubbed');
      return registry.acquire(binding, required);
    },
  } as unknown as IEnvironmentService;
  return new SessionManager(
    workspaces,
    index,
    new EnvironmentDeclarationService(
      overrides.config ??
        ({ _serviceBrand: undefined, ready: Promise.resolve(), assertValid: () => {}, get: () => undefined } as unknown as IConfigService),
      log,
    ),
    environments,
    overrides.hostFs ??
      ({
        _serviceBrand: undefined,
        stat: async () => ({ isFile: false, isDirectory: true, size: 0 }),
        realpath: async (path: string) => path,
      } as unknown as IHostFileSystem),
    overrides.locks ?? new InMemorySessionLockService(),
  );
}

function controller(sessionId = 'session-1'): {
  readonly service: SessionLifecycleService;
  readonly handle: ISessionScopeHandle;
} {
  const handle = { id: sessionId } as unknown as ISessionScopeHandle;
  const willCreate = new Emitter<SessionWillCreateEvent>();
  const didCreate = new Emitter<SessionCreatedEvent>();
  const didClose = new Emitter<SessionClosedEvent>();
  const service = {
    onWillCreateSession: willCreate.event,
    onDidCreateSession: didCreate.event,
    onWillCloseSession: Event.None,
    onDidCloseSession: didClose.event,
    onDidArchiveSession: Event.None,
    onDidForkSession: Event.None,
    create: async () => {
      didCreate.fire({ sessionId, handle, source: 'startup' });
      return handle;
    },
    get: (id: string) => id === sessionId ? handle : undefined,
    list: () => [handle],
    resume: async () => handle,
    close: async (sessionId: string) => { didClose.fire({ sessionId }); },
    archive: async () => {},
    restore: async () => handle,
    delete: async () => {},
    fork: async () => handle,
    createChild: async () => handle,
    dispose: () => {},
  } as unknown as SessionLifecycleService;
  return { service, handle };
}

type WorkspaceLease = Awaited<ReturnType<IWorkspaceInstanceManager['acquire']>>;

function workspaceManager(workspace: WorkspaceInstance): IWorkspaceInstanceManager & {
  readonly leases: readonly WorkspaceLease[];
} {
  const leases: WorkspaceLease[] = [];
  return {
    acquire: vi.fn(async () => {
      let disposed = false;
      const lease = {
        instance: workspace,
        dispose: vi.fn(() => {
          if (disposed) return;
          disposed = true;
        }),
      };
      leases.push(lease);
      return lease;
    }),
    get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    leases,
  } as unknown as IWorkspaceInstanceManager & { readonly leases: readonly WorkspaceLease[] };
}

async function drainMicrotasks(ticks = 50): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

describe('SessionManager', () => {
  it('serializes resume, close, and lifecycle critical sections per session', async () => {
    const didCreate = new Emitter<SessionCreatedEvent>();
    const didClose = new Emitter<SessionClosedEvent>();
    const handle = { id: 'session-1' } as unknown as ISessionScopeHandle;
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const order: string[] = [];
    const service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: didClose.event,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async () => handle,
      get: () => undefined,
      list: () => [],
      resume: async () => {
        order.push('resume:start');
        await resumeGate;
        didCreate.fire({ sessionId: 'session-1', handle, source: 'startup' });
        order.push('resume:end');
        return handle;
      },
      close: async () => {
        order.push('close');
        didClose.fire({ sessionId: 'session-1' });
      },
      archive: async () => {},
      restore: async () => handle,
      delete: async () => {},
      fork: async () => handle,
      createChild: async () => handle,
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    const resumePromise = manager.resume('session-1');
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section');
    });
    const closePromise = manager.close('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['resume:start']);
    releaseResume();
    await Promise.all([resumePromise, section, closePromise]);
    expect(order).toEqual(['resume:start', 'resume:end', 'section', 'close']);
    manager.dispose();
  });

  it('holds a resume started during a lifecycle critical section', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const order: string[] = [];
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const resumePromise = manager.resume('session-1').then((handle) => {
      order.push('resume');
      return handle;
    });
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, resumePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'resume']);
    manager.dispose();
  });

  it('serializes delete with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { delete: () => Promise<void> }).delete = async () => {
      order.push('delete');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const deletePromise = manager.delete('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, deletePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'delete']);
    manager.dispose();
  });

  it('serializes fork of the source session with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes fork of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { fork: () => Promise<unknown> }).fork = async () => {
      order.push('fork');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const forkPromise = manager.fork({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, forkPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'fork']);
    manager.dispose();
  });

  it('serializes createChild of an explicit target id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { createChild: () => Promise<unknown> }).createChild = async () => {
      order.push('createChild');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-2', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const childPromise = manager.createChild({ sourceSessionId: 'session-1', newSessionId: 'session-2' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, childPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'createChild']);
    manager.dispose();
  });

  it('serializes create with an explicit session id with the lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { create: () => Promise<unknown> }).create = async () => {
      order.push('create');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const createPromise = manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, createPromise]);
    expect(order).toEqual(['section:start', 'section:end', 'create']);
    manager.dispose();
  });

  it('serializes archive with the per-session lifecycle chain', async () => {
    const order: string[] = [];
    const fake = controller();
    (fake.service as unknown as { archive: () => Promise<void> }).archive = async () => {
      order.push('archive');
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    let releaseSection!: () => void;
    const sectionGate = new Promise<void>((resolve) => {
      releaseSection = resolve;
    });
    const section = manager.withLifecycleSerialization('session-1', async () => {
      order.push('section:start');
      await sectionGate;
      order.push('section:end');
    });
    const archivePromise = manager.archive('session-1');
    await drainMicrotasks();
    expect(order).toEqual(['section:start']);
    releaseSection();
    await Promise.all([section, archivePromise]);
    expect(order).toEqual(['section:start', 'section:end', 'archive']);
    manager.dispose();
  });

  it('propagates a failed resume to the next settle until a fresh attempt supersedes', async () => {
    let fail = true;
    const fake = controller();
    (fake.service as unknown as { resume: () => Promise<unknown> }).resume = async () => {
      if (fail) throw new Error('boom');
      return fake.handle;
    };
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);

    await expect(manager.resume('session-1')).rejects.toThrow('boom');
    await expect(manager.whenResumeSettled('session-1')).rejects.toThrow('boom');

    fail = false;
    await manager.resume('session-1');
    await expect(manager.whenResumeSettled('session-1')).resolves.toBeUndefined();
    manager.dispose();
  });

  it('owns one global live-session registry across workspace controllers', async () => {
    const fake = controller();
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const index = { get: async () => undefined } as unknown as ISessionIndex;
    const manager = makeSessionManager(workspaces, index);
    const created = await manager.create({ workDir: '/workspace' });
    expect(created).toBe(fake.handle);
    expect(manager.get('session-1')).toBe(fake.handle);
    expect(manager.list()).toEqual([fake.handle]);
    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.list()).toEqual([]);
    manager.dispose();
  });

  it('uses the replacement Program generation for new sessions while retaining live owners', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    expect(await manager.create({ workDir: '/workspace' })).toBe(first.handle);
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(manager.list()).toEqual([first.handle, second.handle]);

    await manager.close('session-1');
    expect(manager.get('session-1')).toBeUndefined();
    expect(manager.get('session-2')).toBe(second.handle);
    expect(workspaces.leases).toHaveLength(4);
    expect(workspaces.leases[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.leases[1]!.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.leases[2]!.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.leases[3]!.dispose).not.toHaveBeenCalled();
    manager.dispose();
    expect(workspaces.leases[3]!.dispose).toHaveBeenCalledTimes(1);
  });

  it('retires a failed controller as soon as its operation ends', async () => {
    const first = controller('session-1');
    const second = controller('session-2');
    (first.service as { create: unknown }).create = async () => {
      throw new Error('boom');
    };
    const disposeFirst = vi.fn();
    (first.service as { dispose: unknown }).dispose = disposeFirst;
    let generation = 'generation-1';
    const workspace = {
      id: 'workspace-1',
      program: {
        get sessionControllerGeneration() { return generation; },
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = workspaceManager(workspace);
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    await expect(manager.create({ workDir: '/workspace' })).rejects.toThrow('boom');
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(workspaces.leases).toHaveLength(2);
    expect(workspaces.leases[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.leases[1]!.dispose).toHaveBeenCalledTimes(1);
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(workspaces.leases).toHaveLength(4);
    expect(workspaces.leases[2]!.dispose).toHaveBeenCalledTimes(1);
    expect(workspaces.leases[3]!.dispose).not.toHaveBeenCalled();
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
    expect(workspaces.leases[3]!.dispose).toHaveBeenCalledTimes(1);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });
});

describe('SessionManager closeIfIdle', () => {
  interface Guards {
    readonly busy?: boolean;
    readonly pending?: 'none' | 'approval' | 'question';
    readonly cronTasks?: number;
  }

  const managers: SessionManager[] = [];

  function setup(guards: Guards = {}) {
    const didCreate = new Emitter<SessionCreatedEvent>();
    const didClose = new Emitter<SessionClosedEvent>();
    const locks = new InMemorySessionLockService();
    const state = {
      busy: false,
      pending: 'none' as const,
      cronTasks: 0,
      activeAt: Date.now(),
      ...guards,
    };
    const agent = {
      accessor: {
        get: (token: unknown) => token === IAgentCronService
          ? { list: () => Array.from({ length: state.cronTasks }) }
          : undefined,
      },
    };
    const handle = {
      id: 'session-1',
      accessor: {
        get: (token: unknown) => {
          if (token === ISessionActivityView) {
            return {
              state: () => ({ busy: state.busy, mainTurnActive: false, pendingInteraction: state.pending }),
              lastActiveAt: () => state.activeAt,
            };
          }
          if (token === IAgentLifecycleService) {
            return { list: () => [{ agentId: 'main' }], handleOf: () => agent };
          }
          return undefined;
        },
      },
    } as unknown as ISessionScopeHandle;
    let manager: SessionManager;
    const resume = vi.fn(async (
      sessionId: string,
      _options: unknown,
      source: SessionCreateSource = 'resume',
    ) => {
      if (manager.get(sessionId) === undefined) didCreate.fire({ sessionId, handle, source });
      return handle;
    });
    const close = vi.fn(async (sessionId: string, _reason: SessionCloseReason = 'exit') => {
      didClose.fire({ sessionId });
    });
    const service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: didCreate.event,
      onWillCloseSession: Event.None,
      onDidCloseSession: didClose.event,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async () => {
        didCreate.fire({ sessionId: 'session-1', handle, source: 'startup' });
        return handle;
      },
      resume,
      close,
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const workspace = {
      id: 'workspace-1',
      program: { sessionControllerGeneration: 'generation-1', createSessionController: () => service },
    } as unknown as WorkspaceInstance;
    manager = makeSessionManager(
      workspaceManager(workspace),
      { get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }) } as unknown as ISessionIndex,
      { locks },
    );
    managers.push(manager);
    return { manager, handle, resume, close, locks };
  }

  const create = (fake: ReturnType<typeof setup>): Promise<ISessionScopeHandle> =>
    fake.manager.create({ sessionId: 'session-1', workDir: '/workspace' } as never);

  beforeEach(() => vi.useFakeTimers());

  afterEach(() => {
    for (const manager of managers) manager.dispose();
    managers.length = 0;
    vi.useRealTimers();
  });

  it('reclaims after the activity idle timeout and reloads only once', async () => {
    const fake = setup();
    expect(await fake.manager.closeIfIdle('session-1', 0)).toBe(false);
    await create(fake);
    vi.setSystemTime(Date.now() + 999);
    expect(await fake.manager.closeIfIdle('session-1', 1000)).toBe(false);
    await fake.manager.resume('session-1');
    vi.setSystemTime(Date.now() + 1);
    expect(await fake.manager.closeIfIdle('session-1', 1000)).toBe(true);
    expect(fake.manager.get('session-1')).toBeUndefined();
    await fake.manager.resume('session-1');
    await fake.manager.close('session-1');
    await fake.manager.resume('session-1');
    expect(fake.close.mock.calls[0]?.[1]).toBe('reclaim');
    expect(fake.resume.mock.calls.map((call) => call[2])).toEqual(['resume', 'reclaimed', 'resume']);
  });

  const eligibilityCases: Array<[string, Guards]> = [
    ['a busy turn', { busy: true }],
    ['a pending approval', { pending: 'approval' }],
    ['a pending question', { pending: 'question' }],
    ['pending cron tasks', { cronTasks: 1 }],
  ];

  it.each(eligibilityCases)('retains sessions with %s', async (_label, guards) => {
    const fake = setup(guards);
    await create(fake);
    expect(await fake.manager.closeIfIdle('session-1', 0)).toBe(false);
    expect(fake.manager.get('session-1')).toBeDefined();
  });

  it('releases the lease when the close path fails', async () => {
    const fake = setup();
    fake.close.mockRejectedValue(new Error('boom'));
    await create(fake);
    await expect(fake.manager.closeIfIdle('session-1', 0)).rejects.toThrow('boom');
    expect(fake.locks.held('session-1')).toBe(false);
    expect(fake.manager.get('session-1')).toBeDefined();
  });

  it('serializes a reclaim with a racing resume', async () => {
    const fake = setup();
    await create(fake);
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = fake.close.getMockImplementation();
    fake.close.mockImplementation(async (id, reason) => {
      await closeGate;
      await close?.(id, reason);
    });
    const reclaim = fake.manager.closeIfIdle('session-1', 0);
    const resumed = fake.manager.resume('session-1');
    await drainMicrotasks();
    expect(fake.resume).not.toHaveBeenCalled();
    releaseClose();
    expect(await reclaim).toBe(true);
    expect(await resumed).toBe(fake.handle);
    expect(fake.manager.get('session-1')).toBe(fake.handle);
  });
});

describe('SessionManager controller retirement', () => {
  function remoteEnvironment(generation: string): FakeEnvironment {
    return Object.assign(
      new FakeEnvironment(
        { environmentId: 'remote', generation },
        { capabilities: ['fs', 'process'] },
      ),
      { fs: { stat: async () => ({ isDirectory: true }) }, process: {} },
    ) as FakeEnvironment;
  }

  function liveProgram(): {
    readonly registry: EnvironmentRegistry;
    readonly program: Program;
    readonly controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[];
  } {
    const registry = new EnvironmentRegistry();
    const controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[] = [];
    let nextSession = 0;
    const program = new Program(
      'workspace',
      registry as unknown as IEnvironmentService,
      {
        _serviceBrand: undefined,
        workspaceId: 'workspace',
        cwd: '/workspace',
        source: 'local',
        meta: {
          id: 'workspace',
          name: 'workspace',
          root: '/workspace',
          kind: 'implicit',
          createdAt: 0,
          lastOpenedAt: 0,
        },
        persistenceScope: 'sessions/workspace',
      },
      {
        agentProfiles: { entries: () => [] },
        environmentDeclarations: { assertAllowed: () => {} },
        createSessionController: (input: ProgramSessionControllerInput) => {
          const didCreate = new Emitter<SessionCreatedEvent>();
          const didClose = new Emitter<SessionClosedEvent>();
          const didArchive = new Emitter<SessionArchivedEvent>();
          const live = new Map<string, ISessionScopeHandle>();
          const dispose = vi.fn(() => {
            input.onDispose();
            didCreate.dispose();
            didClose.dispose();
            didArchive.dispose();
          });
          const service = {
            onWillCreateSession: Event.None,
            onDidCreateSession: didCreate.event,
            onWillCloseSession: Event.None,
            onDidCloseSession: didClose.event,
            onDidArchiveSession: didArchive.event,
            onDidForkSession: Event.None,
            create: async () => {
              nextSession += 1;
              const sessionId = `session-${nextSession}`;
              const handle = { id: sessionId } as unknown as ISessionScopeHandle;
              live.set(sessionId, handle);
              didCreate.fire({ sessionId, handle, source: 'startup' });
              return handle;
            },
            get: (sessionId: string) => live.get(sessionId),
            list: () => [...live.values()],
            resume: async () => undefined,
            close: async (sessionId: string) => {
              if (live.delete(sessionId)) didClose.fire({ sessionId });
            },
            archive: async (sessionId: string) => {
              if (live.delete(sessionId)) didArchive.fire({ sessionId });
            },
            restore: async () => undefined,
            delete: async () => {},
            fork: async () => {
              throw new Error('fork not supported');
            },
            createChild: async () => {
              throw new Error('createChild not supported');
            },
            dispose,
          } as unknown as SessionLifecycleService;
          controllers.push({ service, dispose });
          return service;
        },
      } as never,
    );
    const createGeneration = vi.fn(() => {
      const lease = registry.acquire({ environmentId: 'local' }, ['fs', 'process']);
      const id = lease.environment.identity.generation;
      lease.dispose();
      const behavior = {
        ready: Promise.resolve(),
        dispose: () => {},
      };
      const catalog = {
        listSkills: () => [],
        listInvocableSkills: () => [],
        getSkippedByPolicy: () => [],
        getSkillRoots: () => [],
      };
      return {
        id,
        state: behavior,
        dirs: behavior,
        fs: behavior,
        watch: behavior,
        git: behavior,
        instructions: { ...behavior, snapshot: {} },
        mcpConfig: { ...behavior, servers: () => ({}) },
        mcp: behavior,
        trust: { ...behavior, isTrusted: () => false },
        skills: { ...behavior, catalog },
        agentProfiles: behavior,
        userAgentProfiles: behavior,
        pluginAgentProfiles: behavior,
        explicitAgentProfiles: behavior,
        extraAgentProfiles: behavior,
        disposables: [behavior],
        ready: false,
        failed: false,
        references: 1,
        retired: false,
      };
    });
    (program as unknown as { createGeneration: typeof createGeneration }).createGeneration = createGeneration;
    return { registry, program, controllers };
  }

  function managerFor(program: Program, registry?: EnvironmentRegistry, config?: IConfigService): SessionManager {
    const workspace = { id: 'workspace', program, environments: registry } as unknown as WorkspaceInstance;
    return makeSessionManager(
      workspaceManager(workspace),
      { get: async () => undefined } as unknown as ISessionIndex,
      { config },
    );
  }

  it('keeps the superseded session controller until its last session closes', async () => {
    const { registry, program, controllers } = liveProgram();
    const first = fakeEnvironment('local', 'one');
    const registration = registry.register(first);
    await program.ready;
    const manager = managerFor(program, registry);

    const handleOne = await manager.create({ workDir: '/workspace' });
    await registration.remove();
    registry.register(fakeEnvironment('local', 'two'));
    const handleTwo = await manager.create({ workDir: '/workspace' });
    expect(manager.list()).toEqual([handleOne, handleTwo]);
    expect(first.disposed).toBe(true);

    await manager.close(handleOne.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).not.toHaveBeenCalled();
    expect(manager.get(handleTwo.id)).toBe(handleTwo);

    manager.dispose();
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    await program.dispose();
    await registry.dispose();
  });

  it('retires an idle current-generation controller and rebuilds it for the next session', async () => {
    const { registry, program, controllers } = liveProgram();
    registry.register(fakeEnvironment('local', 'one'));
    await program.ready;
    const manager = managerFor(program, registry);

    const first = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(1);
    await manager.close(first.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);

    const second = await manager.create({ workDir: '/workspace' });
    expect(controllers).toHaveLength(2);
    expect(manager.get(second.id)).toBe(second);

    manager.dispose();
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    await program.dispose();
    await registry.dispose();
  });

  it('routes local and remote sessions of one workspace through the same controller', async () => {
    const { registry, program, controllers } = liveProgram();
    registry.register(fakeEnvironment('local', 'one'));
    registry.register(remoteEnvironment('remote-one'));
    await program.ready;
    const manager = managerFor(program, registry, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      assertValid: () => {},
      get: (domain: string) =>
        domain === 'environments' ? { remote: { command: 'remote', defaultCwd: '/remote/work' } } : undefined,
    } as unknown as IConfigService);

    const local = await manager.create({ workDir: '/workspace' });
    const remote = await manager.create({ workDir: '/workspace', environmentId: 'remote' });

    expect(controllers).toHaveLength(1);
    expect(manager.get(local.id)).toBe(local);
    expect(manager.get(remote.id)).toBe(remote);

    manager.dispose();
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    await program.dispose();
    await registry.dispose();
  });
});

describe('SessionManager creation environment', () => {
  let manager!: SessionManager;
  let registry!: EnvironmentRegistry;
  afterEach(async () => {
    manager.dispose();
    await registry.dispose();
  });

  function configWith(section: unknown): IConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      assertValid: () => {},
      get: (domain: string) => (domain === 'environments' ? section : undefined),
    } as unknown as IConfigService;
  }

  function setup(config: IConfigService, remote = false) {
    registry = new EnvironmentRegistry();
    registry.register(Object.assign(new FakeEnvironment(
      { environmentId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    if (remote) {
      registry.register(Object.assign(new FakeEnvironment(
        { environmentId: 'sandbox', generation: 'sandbox-one' },
        { status: 'disconnected', capabilities: ['fs', 'process'] },
      ), { fs: {}, process: {} }));
    }
    const options: unknown[] = [];
    const service = {
      onWillCreateSession: Event.None,
      onDidCreateSession: Event.None,
      onWillCloseSession: Event.None,
      onDidCloseSession: Event.None,
      onDidArchiveSession: Event.None,
      onDidForkSession: Event.None,
      create: async (opts: unknown) => {
        options.push(opts);
        return { id: `session-${options.length}` } as unknown as ISessionScopeHandle;
      },
      dispose: () => {},
    } as unknown as SessionLifecycleService;
    const program = {
      sessionControllerGeneration: 'generation',
      createSessionController: () => service,
    } as unknown as Program;
    const workspace = { id: 'workspace-1', root: '/workspace', environments: registry, program } as unknown as WorkspaceInstance;
    manager = makeSessionManager(
      workspaceManager(workspace),
      { get: async () => undefined } as unknown as ISessionIndex,
      { config },
    );
    return { options };
  }

  it('binds a new session to the configured default environment and cwd', async () => {
    const { options } = setup(configWith({
      default: 'sandbox',
      sandbox: { command: 'sandbox', args: ['ssh'], defaultCwd: '/home/me/sandbox' },
    }), true);

    await manager.create({ workDir: '/workspace' });
    expect(options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' });
  });

  it('applies the declaration defaultCwd for an explicit environment id and rejects undeclared ids', async () => {
    const { options } = setup(configWith({ sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } }), true);

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/elsewhere' });
    expect(options).toMatchObject([
      { environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' },
      { environmentId: 'sandbox', environmentCwd: '/elsewhere' },
    ]);
    await expect(manager.create({ workDir: '/workspace', environmentId: 'missing' })).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('keeps new sessions local when no default is configured', async () => {
    const { options } = setup(configWith(undefined));

    await manager.create({ workDir: '/workspace' });
    expect(options[0]).toMatchObject({ workDir: '/workspace' });
    expect((options[0] as { environmentId?: string }).environmentId).toBeUndefined();
  });

  it('rejects creation when declaration resolution fails and allows explicit local', async () => {
    const { options } = setup({
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      assertValid: () => {},
      get: () => {
        throw new Error('config store corrupted');
      },
    } as unknown as IConfigService);

    await expect(manager.create({ workDir: '/workspace', environmentId: 'sandbox' })).rejects.toThrow('config store corrupted');
    await expect(manager.create({ workDir: '/workspace' })).rejects.toThrow('config store corrupted');
    expect(options).toHaveLength(0);

    await manager.create({ workDir: '/workspace', environmentId: 'local' });
    await manager.create({ workDir: '/workspace', environmentId: 'local', environmentCwd: '/tmp/proj-a' });
    expect(options[0]).toMatchObject({ workDir: '/workspace', environmentId: 'local' });
    expect(options[1]).toMatchObject({
      workDir: '/workspace',
      environmentId: 'local',
      environmentCwd: '/tmp/proj-a',
    });
  });

  it('normalizes a declared remote cwd before handing it to the controller', async () => {
    const { options } = setup(configWith({ sandbox: { command: 'sandbox', defaultCwd: '/remote//project/./sub/..' } }), true);
    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    expect(options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/remote/project' });
  });

  it('requires a cwd for a registered environment that is not declared', async () => {
    const { options } = setup(configWith(undefined), true);
    await expect(manager.create({ workDir: '/workspace', environmentId: 'sandbox' })).rejects.toThrow('requires a cwd');
    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: 'relative/dir' });
    expect(options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: 'relative/dir' });
  });
});

describe('reloadOnStale', () => {
  function staleAccessor(): {
    readonly accessor: ServicesAccessor;
    readonly order: string[];
    readonly reloaded: ISessionScopeHandle;
  } {
    const order: string[] = [];
    const reloaded = { id: 'session-1' } as unknown as ISessionScopeHandle;
    const manager = {
      close: async () => {
        order.push('close');
      },
      resume: async () => {
        order.push('resume');
        return reloaded;
      },
    };
    const accessor = {
      get: (id: unknown) => {
        if (id === ISessionManager) return manager;
        throw new Error('unexpected service');
      },
    } as unknown as ServicesAccessor;
    return { accessor, order, reloaded };
  }

  it('reloads the session and retries once after a stale rejection', async () => {
    const { accessor, order, reloaded } = staleAccessor();
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error2(ErrorCodes.SESSION_STALE, 'stale'))
      .mockResolvedValue('done');
    const onReloaded = vi.fn(async (session: ISessionScopeHandle) => {
      order.push(`reloaded:${session === reloaded}`);
    });

    await expect(reloadOnStale(accessor, 'session-1', run, { onReloaded })).resolves.toBe('done');

    expect(order).toEqual(['close', 'resume', 'reloaded:true']);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reloads but rethrows the stale rejection when retry is off', async () => {
    const { accessor, order } = staleAccessor();
    const stale = new Error2(ErrorCodes.SESSION_STALE, 'stale');
    const run = vi.fn(async () => {
      throw stale;
    });

    await expect(reloadOnStale(accessor, 'session-1', run, { retry: false })).rejects.toBe(stale);

    expect(order).toEqual(['close', 'resume']);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes other failures through without reloading', async () => {
    const { accessor, order } = staleAccessor();
    const occupied = new Error2(ErrorCodes.SESSION_OCCUPIED, 'occupied');

    await expect(
      reloadOnStale(accessor, 'session-1', async () => {
        throw occupied;
      }),
    ).rejects.toBe(occupied);

    expect(order).toEqual([]);
  });
});
