import { describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { ILogService } from '#/_base/log/log';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { RuntimeRegistry } from '#/runtime/runtimeRegistry';
import { writeWorkspaceTrust } from '#/workspace/workspaceTrust/trustRecord';
import type {
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

function makeSessionManager(
  workspaces: IWorkspaceInstanceManager,
  index: ISessionIndex,
  overrides: {
    readonly flags?: IFlagService;
    readonly config?: IConfigService;
    readonly fs?: IHostFileSystem;
    readonly docs?: IAtomicDocumentStore;
    readonly appendLogStore?: IAppendLogStore;
    readonly bootstrap?: IBootstrapService;
    readonly log?: ILogService;
  } = {},
): SessionManager {
  return new SessionManager(
    workspaces,
    index,
    overrides.flags ?? ({ _serviceBrand: undefined, enabled: () => false } as unknown as IFlagService),
    overrides.config ??
      ({ _serviceBrand: undefined, ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService),
    overrides.fs ?? ({ _serviceBrand: undefined } as unknown as IHostFileSystem),
    overrides.docs ?? ({ _serviceBrand: undefined, get: async () => undefined } as unknown as IAtomicDocumentStore),
    overrides.appendLogStore ??
      ({ _serviceBrand: undefined, read: async function* () {} } as unknown as IAppendLogStore),
    overrides.bootstrap ?? ({ _serviceBrand: undefined, scope: (name: string) => name } as unknown as IBootstrapService),
    overrides.log ??
      ({ _serviceBrand: undefined, warn: () => {}, info: () => {}, error: () => {} } as unknown as ILogService),
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
      program: { sessionControllerGenerationFor: () => 'generation-1', createSessionController: () => fake.service },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
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
        sessionControllerGenerationFor: () => generation,
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
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
    manager.dispose();
  });

  it('retires a superseded controller that never came to own a session', async () => {
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
        sessionControllerGenerationFor: () => generation,
        createSessionController: () => generation === 'generation-1' ? first.service : second.service,
      },
    } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );

    await expect(manager.create({ workDir: '/workspace' })).rejects.toThrow('boom');
    expect(disposeFirst).not.toHaveBeenCalled();
    generation = 'generation-2';
    expect(await manager.create({ workDir: '/workspace' })).toBe(second.handle);
    expect(disposeFirst).toHaveBeenCalledTimes(1);
    expect(manager.get('session-2')).toBe(second.handle);
    manager.dispose();
    expect(disposeFirst).toHaveBeenCalledTimes(1);
  });
});

describe('SessionManager controller retirement', () => {
  function runtime(generation: string): FakeRuntime {
    return Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace', runtimeId: 'local', generation },
        { capabilities: ['fs', 'process'] },
      ),
      { fs: {}, process: {} },
    ) as FakeRuntime;
  }

  function remoteRuntime(generation: string): FakeRuntime {
    return Object.assign(
      new FakeRuntime(
        { workspaceId: 'workspace', runtimeId: 'remote', generation },
        { capabilities: ['fs', 'process'] },
      ),
      { fs: {}, process: {} },
    ) as FakeRuntime;
  }

  function liveProgram(drainTimeoutMs: number): {
    readonly registry: RuntimeRegistry;
    readonly program: Program;
    readonly controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[];
  } {
    const registry = new RuntimeRegistry('workspace', drainTimeoutMs);
    const controllers: { readonly service: SessionLifecycleService; readonly dispose: ReturnType<typeof vi.fn> }[] = [];
    let nextSession = 0;
    const program = new Program(
      'workspace',
      registry,
      {
        _serviceBrand: undefined,
        workspaceId: 'workspace',
        cwd: '/workspace',
        source: 'local',
        meta: {
          id: 'workspace',
          name: 'workspace',
          root: '/workspace',
          createdAt: 0,
          lastOpenedAt: 0,
        },
        persistenceScope: 'sessions/workspace',
      },
      {
        agentProfiles: { entries: () => [] },
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
    const createGeneration = vi.fn((runtimeId: string) => {
      const lease = registry.acquire({ workspaceId: 'workspace', runtimeId }, ['fs', 'process']);
      const id = lease.runtime.identity.generation;
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
        lease,
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

  function managerFor(program: Program, registry?: RuntimeRegistry): SessionManager {
    const workspace = { id: 'workspace', program, runtimes: registry } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    return makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
    );
  }

  it('releases the superseded program generation once its last session closes, before the drain timeout', async () => {
    const { registry, program, controllers } = liveProgram(60_000);
    const first = runtime('one');
    const registration = registry.register(first);
    await program.ready;
    const manager = managerFor(program, registry);

    const handleOne = await manager.create({ workDir: '/workspace' });
    const replacement = registration.replace(runtime('two'));
    await Promise.resolve();
    const handleTwo = await manager.create({ workDir: '/workspace' });
    expect(manager.list()).toEqual([handleOne, handleTwo]);
    expect(first.disposed).toBe(false);

    await manager.close(handleOne.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).not.toHaveBeenCalled();
    await replacement;
    expect(first.disposed).toBe(true);
    expect(manager.get(handleTwo.id)).toBe(handleTwo);

    manager.dispose();
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });

  it('retires an idle current-generation controller and rebuilds it for the next session', async () => {
    const { registry, program, controllers } = liveProgram(50);
    registry.register(runtime('one'));
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
    program.dispose();
    await registry.dispose();
  });

  it('keeps per-runtime controllers isolated for same-workspace sessions on different runtimes', async () => {
    const { registry, program, controllers } = liveProgram(50);
    registry.register(runtime('one'));
    registry.register(remoteRuntime('remote-one'));
    await program.ready;
    const manager = managerFor(program, registry);

    const local = await manager.create({ workDir: '/workspace' });
    const remote = await manager.create({ workDir: '/workspace', runtimeId: 'remote' });

    expect(controllers).toHaveLength(2);
    expect(manager.get(local.id)).toBe(local);
    expect(manager.get(remote.id)).toBe(remote);
    expect(program.sessionControllerGeneration).toBe('one');
    expect(program.sessionControllerGenerationFor('remote')).toBe('remote-one');

    await manager.close(local.id);
    expect(controllers[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(controllers[1]!.dispose).not.toHaveBeenCalled();

    manager.dispose();
    expect(controllers[1]!.dispose).toHaveBeenCalledTimes(1);
    program.dispose();
    await registry.dispose();
  });
});

describe('SessionManager remote runtime wiring', () => {
  function flagsOn(): IFlagService {
    return { _serviceBrand: undefined, enabled: (id: string) => id === 'remote_runtime' } as unknown as IFlagService;
  }

  function configWith(section: unknown): IConfigService {
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) => (domain === 'runtimes' ? section : undefined),
    } as unknown as IConfigService;
  }

  function fsWith(files: Readonly<Record<string, string>>): IHostFileSystem {
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

  function docsStore(): IAtomicDocumentStore & { readonly records: Map<string, unknown> } {
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

  function createCapture() {
    const created: { readonly options: readonly unknown[]; readonly service: SessionLifecycleService }[] = [];
    const byRuntime = new Map<string, { options: unknown[]; service: SessionLifecycleService; handle: ISessionScopeHandle }>();
    const program = {
      sessionControllerGenerationFor: (runtimeId: string) => `generation-${runtimeId}`,
      createSessionController: (runtimeId: string) => {
        const handle = { id: `session-${runtimeId}` } as unknown as ISessionScopeHandle;
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
            return handle;
          },
          resume: async () => handle,
          restore: async () => handle,
          get: () => undefined,
          list: () => [],
          close: async () => {},
          archive: async () => {},
          delete: async () => {},
          fork: async () => handle,
          createChild: async () => handle,
          dispose: () => {},
        } as unknown as SessionLifecycleService;
        byRuntime.set(runtimeId, { options, service, handle });
        created.push({ options, service });
        return service;
      },
    } as unknown as Program;
    return { program, byRuntime };
  }

  function workspaceWith(
    registry: RuntimeRegistry,
    program: Program,
    root = '/workspace',
  ): WorkspaceInstance {
    return { id: 'workspace-1', root, runtimes: registry, program } as unknown as WorkspaceInstance;
  }

  it('binds a new session to the configured default runtime and cwd', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    const { program, byRuntime } = createCapture();
    const workspace = workspaceWith(registry, program);
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      {
        flags: flagsOn(),
        config: configWith({
          default: 'gym',
          gym: { command: 'agi', args: ['sandbox'], defaultCwd: '/home/me/gym' },
        }),
      },
    );

    await manager.create({ workDir: '/workspace' });
    expect(byRuntime.has('local')).toBe(true);
    expect(byRuntime.get('local')!.options[0]).toMatchObject({ runtimeId: 'gym', runtimeCwd: '/home/me/gym' });
    manager.dispose();
    await registry.dispose();
  });

  it('prefers a trusted project default over the user default', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    const { program, byRuntime } = createCapture();
    const workspace = workspaceWith(registry, program);
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const docs = docsStore();
    await writeWorkspaceTrust(docs, '/workspace', Date.now());
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      {
        flags: flagsOn(),
        config: configWith({
          default: 'user-box',
          'user-box': { type: 'ssh', host: 'user-box', defaultCwd: '/user' },
        }),
        fs: fsWith({
          '/workspace/.kimi-code/runtimes.toml': 'default = "project-box"\n\n[project-box]\ntype = "ssh"\nhost = "project-box"\ndefaultCwd = "/project"\n',
        }),
        docs,
      },
    );

    await manager.create({ workDir: '/workspace' });
    expect(byRuntime.get('local')!.options[0]).toMatchObject({ runtimeId: 'project-box', runtimeCwd: '/project' });
    manager.dispose();
    await registry.dispose();
  });

  it('applies the declaration defaultCwd for an explicit runtime id and rejects undeclared ids', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    const { program, byRuntime } = createCapture();
    const workspace = workspaceWith(registry, program);
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const manager = makeSessionManager(
      workspaces,
      { get: async () => undefined } as unknown as ISessionIndex,
      {
        flags: flagsOn(),
        config: configWith({
          gym: { command: 'agi', defaultCwd: '/home/me/gym' },
        }),
      },
    );

    await manager.create({ workDir: '/workspace', runtimeId: 'gym' });
    expect(byRuntime.get('local')!.options[0]).toMatchObject({ runtimeId: 'gym', runtimeCwd: '/home/me/gym' });

    await manager.create({ workDir: '/workspace', runtimeId: 'gym', runtimeCwd: '/elsewhere' });
    expect(byRuntime.get('local')!.options[1]).toMatchObject({ runtimeId: 'gym', runtimeCwd: '/elsewhere' });

    await expect(manager.create({ workDir: '/workspace', runtimeId: 'missing' })).rejects.toMatchObject({
      code: 'config.invalid',
    });
    manager.dispose();
    await registry.dispose();
  });

  it('keeps new sessions local when no default is configured or the flag is off', async () => {
    const registry = new RuntimeRegistry('workspace-1');
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    const { program, byRuntime } = createCapture();
    const workspace = workspaceWith(registry, program);
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = { get: async () => undefined } as unknown as ISessionIndex;

    const noDefault = makeSessionManager(workspaces, index, { flags: flagsOn(), config: configWith(undefined) });
    await noDefault.create({ workDir: '/workspace' });
    expect(byRuntime.get('local')!.options[0]).toMatchObject({ workDir: '/workspace' });
    expect((byRuntime.get('local')!.options[0] as { runtimeId?: string }).runtimeId).toBeUndefined();
    noDefault.dispose();

    const flagOff = makeSessionManager(workspaces, index, {
      config: configWith({
        default: 'gym',
        gym: { command: 'agi', defaultCwd: '/home/me/gym' },
      }),
    });
    await flagOff.create({ workDir: '/workspace' });
    const last = byRuntime.get('local')!.options.at(-1) as { runtimeId?: string };
    expect(last.runtimeId).toBeUndefined();
    flagOff.dispose();
    await registry.dispose();
  });

  function restoreSetup(options: {
    readonly remoteStatus: 'ready' | 'disconnected';
    readonly flagOn: boolean;
  }) {
    const registry = new RuntimeRegistry('workspace-1');
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    registry.register(Object.assign(new FakeRuntime(
      { workspaceId: 'workspace-1', runtimeId: 'remote', generation: 'remote-one' },
      { status: options.remoteStatus, capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    const { program, byRuntime } = createCapture();
    const workspace = workspaceWith(registry, program);
    const workspaces = {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const appendLogStore = {
      _serviceBrand: undefined,
      read: async function* () {
        yield { type: 'runtime.set_binding', agentId: 'main', workspaceId: 'workspace-1', runtimeId: 'remote', cwd: '/remote/work', time: 1 };
      },
    } as unknown as IAppendLogStore;
    const manager = makeSessionManager(workspaces, index, {
      flags: options.flagOn ? flagsOn() : undefined,
      appendLogStore,
    });
    return { manager, byRuntime, registry };
  }

  it('restores a remote-bound session on the local controller without connecting when the runtime is disconnected', async () => {
    const { manager, byRuntime, registry } = restoreSetup({ remoteStatus: 'disconnected', flagOn: true });

    await manager.resume('session-1');
    expect(byRuntime.has('local')).toBe(true);
    expect(byRuntime.has('remote')).toBe(false);
    manager.dispose();
    await registry.dispose();
  });

  it('restores a remote-bound session on the remote controller when the runtime is ready', async () => {
    const { manager, byRuntime, registry } = restoreSetup({ remoteStatus: 'ready', flagOn: true });

    await manager.resume('session-1');
    expect(byRuntime.has('remote')).toBe(true);
    manager.dispose();
    await registry.dispose();
  });

  it('ignores the persisted remote binding when the flag is off', async () => {
    const { manager, byRuntime, registry } = restoreSetup({ remoteStatus: 'ready', flagOn: false });

    await manager.resume('session-1');
    expect(byRuntime.has('local')).toBe(true);
    expect(byRuntime.has('remote')).toBe(false);
    manager.dispose();
    await registry.dispose();
  });
});
