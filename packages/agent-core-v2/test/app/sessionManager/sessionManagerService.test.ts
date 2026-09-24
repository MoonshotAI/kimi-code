import { IEnvironmentService } from '#/app/environment/environment';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Emitter, Event } from '#/_base/event';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { ILogService } from '#/_base/log/log';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
import { EnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclarationService';
import { SessionManager } from '#/app/sessionManager/sessionManagerService';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { Program } from '#/program/program';
import type { ProgramSessionControllerInput } from '#/program/programDependencies';
import { FakeEnvironment } from '#/environment/fakeEnvironment';
import { fakeEnvironment, connectableEnvironment } from '../../environment/stubs';
import { EnvironmentRegistry } from '#/environment/environmentRegistry';
import type {
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
import type { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';
import { createWireMetadataRecord, type WireRecord } from '#/wire/record';

function makeSessionManager(
  workspaces: IWorkspaceInstanceManager,
  index: ISessionIndex,
  overrides: {
    readonly config?: IConfigService;
    readonly appendLogStore?: IAppendLogStore;
    readonly bootstrap?: IBootstrapService;
    readonly log?: ILogService;
  } = {},
): SessionManager {
  const log =
    overrides.log ??
    ({ _serviceBrand: undefined, warn: () => {}, info: () => {}, error: () => {} } as unknown as ILogService);
  const environments = {
    ready: Promise.resolve(),
    current: (id: string) => (workspaces.get('workspace') as unknown as { environments?: EnvironmentRegistry } | undefined)?.environments?.current(id),
    acquire: (binding: { environmentId: string }, required: never) => (workspaces.get('workspace') as unknown as { environments: EnvironmentRegistry }).environments.acquire(binding, required),
  } as unknown as IEnvironmentService;
  return new SessionManager(
    workspaces,
    index,
    new EnvironmentDeclarationService(
      overrides.config ??
        ({ _serviceBrand: undefined, ready: Promise.resolve(), get: () => undefined } as unknown as IConfigService),
      overrides.appendLogStore ??
        ({ _serviceBrand: undefined, read: async function* () {} } as unknown as IAppendLogStore),
      overrides.bootstrap ?? ({ _serviceBrand: undefined, scope: (name: string) => name } as unknown as IBootstrapService),
      environments,
      log,
    ),
    log,
    environments,
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
    const createGeneration = vi.fn((environmentId: string) => {
      const lease = registry.acquire({ environmentId }, ['fs', 'process']);
      const id = lease.environment.identity.generation;
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

  function managerFor(program: Program, registry?: EnvironmentRegistry, config?: IConfigService): SessionManager {
    const workspace = { id: 'workspace', program, environments: registry } as unknown as WorkspaceInstance;
    const workspaces = {
      getOrCreate: async () => workspace,
      get: (workspaceId: string) => workspaceId === workspace.id ? workspace : undefined,
    } as unknown as IWorkspaceInstanceManager;
    return makeSessionManager(
      workspaces,
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
    await registration.replace(fakeEnvironment('local', 'two'));
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
    program.dispose();
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
    program.dispose();
    await registry.dispose();
  });

  it('keeps per-environment controllers isolated for same-workspace sessions on different environments', async () => {
    const { registry, program, controllers } = liveProgram();
    registry.register(fakeEnvironment('local', 'one'));
    registry.register(remoteEnvironment('remote-one'));
    await program.ready;
    const manager = managerFor(program, registry, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      get: (domain: string) =>
        domain === 'environments' ? { remote: { command: 'remote', defaultCwd: '/remote/work' } } : undefined,
    } as unknown as IConfigService);

    const local = await manager.create({ workDir: '/workspace' });
    const remote = await manager.create({ workDir: '/workspace', environmentId: 'remote' });

    expect(controllers).toHaveLength(2);
    expect(manager.get(local.id)).toBe(local);
    expect(manager.get(remote.id)).toBe(remote);
    expect(program.sessionControllerGenerationFor('local')).toBe('one');
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

describe('SessionManager remote environment wiring', () => {
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
      get: (domain: string) => (domain === 'environments' ? section : undefined),
    } as unknown as IConfigService;
  }

  function createCapture() {
    const created: { readonly options: readonly unknown[]; readonly service: SessionLifecycleService }[] = [];
    const createCalls: { readonly environmentId: string; readonly cwd?: string }[] = [];
    const byEnvironment = new Map<string, { options: unknown[]; service: SessionLifecycleService; handle: ISessionScopeHandle }>();
    const program = {
      sessionControllerGenerationFor: (environmentId: string) => `generation-${environmentId}`,
      createSessionController: (environmentId: string, cwd?: string) => {
        createCalls.push({ environmentId, cwd });
        const handle = { id: `session-${environmentId}` } as unknown as ISessionScopeHandle;
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
        byEnvironment.set(environmentId, { options, service, handle });
        created.push({ options, service });
        return service;
      },
    } as unknown as Program;
    return { program, byEnvironment, createCalls };
  }

  function workspaceWith(
    registry: EnvironmentRegistry,
    program: Program,
    root = '/workspace',
  ): WorkspaceInstance {
    return { id: 'workspace-1', root, environments: registry, program } as unknown as WorkspaceInstance;
  }

  function localRegistry(): EnvironmentRegistry {
    const registry = new EnvironmentRegistry();
    registry.register(Object.assign(new FakeEnvironment(
      { environmentId: 'local', generation: 'local-one' },
      { capabilities: ['fs', 'process'] },
    ), { fs: {}, process: {} }));
    return registry;
  }

  function workspacesFor(registry: EnvironmentRegistry, program: Program): IWorkspaceInstanceManager {
    const workspace = workspaceWith(registry, program);
    return {
      getOrCreate: async () => workspace,
      get: () => workspace,
    } as unknown as IWorkspaceInstanceManager;
  }

  it('binds a new session to the configured default environment and cwd', async () => {
    const { manager, registry, byEnvironment } = remoteWiringSetup({
      config: {
        default: 'sandbox',
        sandbox: { command: 'sandbox', args: ['ssh'], defaultCwd: '/home/me/sandbox' },
      },
    });

    await manager.create({ workDir: '/workspace' });
    expect(byEnvironment.has('local')).toBe(true);
    expect(byEnvironment.get('local')!.options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' });
  });

  it('applies the declaration defaultCwd for an explicit environment id and rejects undeclared ids', async () => {
    const { manager, registry, byEnvironment } = remoteWiringSetup({
      config: {
        sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' },
      },
    });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    expect(byEnvironment.get('local')!.options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/elsewhere' });
    expect(byEnvironment.get('local')!.options[1]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/elsewhere' });

    await expect(manager.create({ workDir: '/workspace', environmentId: 'missing' })).rejects.toMatchObject({
      code: 'config.invalid',
    });
  });

  it('binds a new session to an already-registered environment that is not declared', async () => {
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
    });
    connectableEnvironment(registry, {
      environmentId: 'temp-box',
      stat: async () => ({ isDirectory: true }),
    });

    await expect(manager.create({ workDir: '/workspace', environmentId: 'temp-box' })).rejects.toThrow(
      'requires a cwd',
    );
    await manager.create({
      workDir: '/workspace',
      environmentId: 'temp-box',
      environmentCwd: '/srv/work',
    });
    expect(remote).toBeUndefined();
    expect(byEnvironment.get('temp-box')!.options[0]).toMatchObject({
      environmentId: 'temp-box',
      environmentCwd: '/srv/work',
    });
  });

  it('keeps new sessions local when no default is configured', async () => {
    const { manager, registry, byEnvironment } = remoteWiringSetup({ config: undefined });

    await manager.create({ workDir: '/workspace' });
    expect(byEnvironment.get('local')!.options[0]).toMatchObject({ workDir: '/workspace' });
    expect((byEnvironment.get('local')!.options[0] as { environmentId?: string }).environmentId).toBeUndefined();
  });

  function remoteWiringSetup(options: {
    readonly config: unknown;
    readonly remote?: {
      readonly environmentId?: string;
      readonly status?: 'ready' | 'disconnected';
      readonly connect?: () => Promise<void>;
      readonly stat?: (path: string) => Promise<{ isDirectory: boolean }>;
    };
  }) {
    registry = localRegistry();
    const remote = options.remote === undefined
      ? undefined
      : connectableEnvironment(registry, { environmentId: 'sandbox', ...options.remote });
    const { program, byEnvironment, createCalls } = createCapture();
    manager = makeSessionManager(
      workspacesFor(registry, program),
      { get: async () => undefined } as unknown as ISessionIndex,
      {
        config: configWith(options.config),
      },
    );
    return { manager, registry, byEnvironment, createCalls, remote };
  }

  it('rejects an explicit environment id whose declaration does not set defaultCwd', async () => {
    const { manager, registry, byEnvironment } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox' } },
    });

    await expect(manager.create({ workDir: '/workspace', environmentId: 'sandbox' })).rejects.toMatchObject({
      code: 'config.invalid',
    });
    expect(byEnvironment.size).toBe(0);

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/elsewhere' });
    expect(byEnvironment.get('local')!.options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/elsewhere' });
  });

  it('rejects an explicit environment id when declaration resolution fails', async () => {
    registry = localRegistry();
    const { program, byEnvironment } = createCapture();
    manager = makeSessionManager(
      workspacesFor(registry, program),
      { get: async () => undefined } as unknown as ISessionIndex,
      {
        config: {
          _serviceBrand: undefined,
          ready: Promise.resolve(),
          get: () => {
            throw new Error('config store corrupted');
          },
        } as unknown as IConfigService,
      },
    );

    await expect(manager.create({ workDir: '/workspace', environmentId: 'sandbox' })).rejects.toMatchObject({
      code: 'config.invalid',
    });
    expect(byEnvironment.size).toBe(0);

    await manager.create({ workDir: '/workspace' });
    expect(byEnvironment.get('local')!.options[0]).toMatchObject({ workDir: '/workspace' });
  });

  it('connects a disconnected declared environment before creating the session', async () => {
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { default: 'sandbox', sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: {},
    });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    expect(remote!.calls).toEqual(['connect']);
    expect(byEnvironment.has('sandbox')).toBe(true);
    expect(byEnvironment.get('sandbox')!.options[0]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' });

    await manager.create({ workDir: '/workspace' });
    expect(byEnvironment.get('sandbox')!.options[1]).toMatchObject({ environmentId: 'sandbox', environmentCwd: '/home/me/sandbox' });
  });

  it('aborts creation when the environment connect fails', async () => {
    const handshake = new Error('executor process exited before the handshake completed (code 255, signal null): ssh: connect failed');
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: {
        connect: async () => {
          throw handshake;
        },
      },
    });

    const failure = await manager.create({ workDir: '/workspace', environmentId: 'sandbox' }).catch((error: unknown) => error);
    expect(remote!.calls).toEqual(['connect']);
    expect(failure).toMatchObject({ code: 'environment.unavailable' });
    expect((failure as Error).message).toContain('sandbox');
    expect((failure as Error).message).toContain('code 255');
    expect((failure as { cause?: unknown }).cause).toBe(handshake);
    expect(byEnvironment.size).toBe(0);
  });

  it('does not reconnect a environment that is already ready', async () => {
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: { status: 'ready' },
    });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    expect(remote!.calls).toEqual([]);
    expect(byEnvironment.has('sandbox')).toBe(true);
  });

  it('validates the session cwd on the connected environment without mutating the shared registration', async () => {
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: {},
    });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox' });
    expect(remote!.calls).toEqual(['connect']);
    expect(registry.current('sandbox')).toBe(remote!.fake);
    expect(byEnvironment.has('sandbox')).toBe(true);

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/elsewhere' });
    expect(remote!.calls).toEqual(['connect']);
    expect(registry.current('sandbox')).toBe(remote!.fake);
  });

  it('creates a controller per session cwd on the same environment', async () => {
    const { manager, createCalls } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: { status: 'ready' },
    });

    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/remote/a' });
    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/remote/b' });
    await manager.create({ workDir: '/workspace', environmentId: 'sandbox', environmentCwd: '/remote/a' });

    expect(createCalls).toEqual([
      { environmentId: 'sandbox', cwd: '/remote/a' },
      { environmentId: 'sandbox', cwd: '/remote/b' },
    ]);
  });

  it('aborts creation with environment.invalid_cwd when the cwd is not a directory on the target', async () => {
    let statMode: 'file' | 'unreadable' = 'file';
    const { manager, registry, byEnvironment, remote } = remoteWiringSetup({
      config: { sandbox: { command: 'sandbox', defaultCwd: '/home/me/sandbox' } },
      remote: {
        stat: async (path) => {
          if (statMode === 'unreadable') throw new Error(`ENOENT: ${path}`);
          return { isDirectory: false };
        },
      },
    });

    const failure = await manager.create({ workDir: '/workspace', environmentId: 'sandbox' }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'environment.invalid_cwd' });
    expect(remote!.calls).toEqual(['connect']);
    expect(byEnvironment.size).toBe(0);

    statMode = 'unreadable';
    const unreadable = await manager.create({ workDir: '/workspace', environmentId: 'sandbox' }).catch((error: unknown) => error);
    expect(unreadable).toMatchObject({ code: 'environment.invalid_cwd' });
    expect(byEnvironment.size).toBe(0);
  });

  function restoreSetup(options: {
    readonly remoteStatus: 'ready' | 'disconnected';
    readonly persistedEnvironmentId?: string;
    readonly persistedCwd?: string | null;
    readonly connectFails?: boolean;
    readonly journal?: readonly WireRecord[];
  }) {
    registry = localRegistry();
    const remote = new FakeEnvironment(
      { environmentId: 'remote', generation: 'remote-one' },
      { status: options.remoteStatus, capabilities: ['fs', 'process'] },
    );
    const remoteConnect = vi.fn(async () => {
      if (options.connectFails === true) throw new Error('ssh unreachable');
      remote.setStatus('ready');
    });
    registry.register(Object.assign(remote, { fs: {}, process: {}, connect: remoteConnect }));
    const { program, byEnvironment, createCalls } = createCapture();
    const index = {
      get: async () => ({ workspaceId: 'workspace-1', cwd: '/workspace' }),
    } as unknown as ISessionIndex;
    const persistedEnvironmentId = options.persistedEnvironmentId ?? 'remote';
    const persistedCwd = options.persistedCwd === undefined ? '/remote/work' : options.persistedCwd;
    const journal = options.journal ?? [
      {
        type: 'environment.set_binding',
        agentId: 'main',
        environmentId: persistedEnvironmentId,
        cwd: persistedCwd ?? undefined,
        time: 1,
      },
    ];
    const appendLogStore = {
      _serviceBrand: undefined,
      read: async function* () {
        for (const record of journal) yield record;
      },
    } as unknown as IAppendLogStore;
    const warn = vi.fn();
    manager = makeSessionManager(workspacesFor(registry, program), index, {
      appendLogStore,
      log: { _serviceBrand: undefined, warn, info: () => {}, error: () => {} } as unknown as ILogService,
    });
    return { manager, byEnvironment, createCalls, registry, remote, remoteConnect, warn };
  }

  it('restores a remote-bound session on the remote controller after connecting the disconnected environment', async () => {
    const { manager, byEnvironment, createCalls, registry, remote, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
    });

    const handle = await manager.resume('session-1');
    expect(handle).toBeDefined();
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(byEnvironment.has('remote')).toBe(true);
    expect(byEnvironment.has('local')).toBe(false);
    expect(createCalls).toEqual([{ environmentId: 'remote', cwd: '/remote/work' }]);
    expect(registry.current('remote')).toBe(remote);
    expect(registry.current('remote')!.identity.generation).toBe('remote-one');
    expect(registry.current('remote')!.status).toBe('ready');
    registry.acquire({ environmentId: 'remote' }).dispose();
  });

  it('resumes with the binding kept on a local controller when the persisted environment cannot connect', async () => {
    const { manager, byEnvironment, createCalls, registry, remoteConnect, warn } = restoreSetup({
      remoteStatus: 'disconnected',
      connectFails: true,
    });

    const handle = await manager.resume('session-1');
    expect(handle).toBeDefined();
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(byEnvironment.has('local')).toBe(true);
    expect(byEnvironment.has('remote')).toBe(false);
    expect(createCalls).toEqual([{ environmentId: 'local', cwd: undefined }]);
    expect(registry.current('remote')!.status).toBe('disconnected');
    expect(warn).toHaveBeenCalledTimes(1);
    await expect(manager.whenResumeSettled('session-1')).resolves.toBeUndefined();
  });

  it('recovers a degraded remote binding on demand and resumes onto the remote controller once reconnected', async () => {
    const { manager, byEnvironment, createCalls, registry, remote, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
      connectFails: true,
    });

    await manager.resume('session-1');
    expect(createCalls).toEqual([{ environmentId: 'local', cwd: undefined }]);

    remoteConnect.mockImplementation(async () => {
      remote.setStatus('ready');
    });
    await remoteConnect();
    expect(remoteConnect).toHaveBeenCalledTimes(2);
    expect(registry.current('remote')!.status).toBe('ready');
    registry.acquire({ environmentId: 'remote' }).dispose();

    await manager.resume('session-1');
    expect(createCalls).toEqual([
      { environmentId: 'local', cwd: undefined },
      { environmentId: 'remote', cwd: '/remote/work' },
    ]);
    expect(byEnvironment.has('remote')).toBe(true);
  });

  it('waits for an in-flight connect and resumes onto the remote controller once ready', async () => {
    const { manager, byEnvironment, createCalls, remote, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
    });
    let releaseConnect: () => void = () => undefined;
    remoteConnect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseConnect = () => {
            remote.setStatus('ready');
            resolve();
          };
        }),
    );

    let opened = false;
    const resumePromise = manager.resume('session-1').then((handle) => {
      opened = true;
      return handle;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(opened).toBe(false);
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(byEnvironment.has('remote')).toBe(false);

    releaseConnect();
    const handle = await resumePromise;
    expect(handle).toBeDefined();
    expect(byEnvironment.has('remote')).toBe(true);
    expect(byEnvironment.has('local')).toBe(false);
    expect(createCalls).toEqual([{ environmentId: 'remote', cwd: '/remote/work' }]);
  });

  it('leaves a local restored binding untouched', async () => {
    const { manager, byEnvironment, registry, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
      persistedEnvironmentId: 'local',
    });

    await manager.resume('session-1');
    expect(byEnvironment.has('local')).toBe(true);
    expect(remoteConnect).not.toHaveBeenCalled();
  });

  it('connects the persisted environment when restoring an archived remote-bound session', async () => {
    const { manager, registry, remoteConnect } = restoreSetup({ remoteStatus: 'disconnected' });

    await manager.restore('session-1');
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(registry.current('remote')!.status).toBe('ready');
  });

  it('restores a remote-bound session on the remote controller rooted at the persisted cwd when the environment is ready', async () => {
    const { manager, byEnvironment, createCalls, registry, remote, remoteConnect } = restoreSetup({ remoteStatus: 'ready' });

    await manager.resume('session-1');
    expect(byEnvironment.has('remote')).toBe(true);
    expect(createCalls).toEqual([{ environmentId: 'remote', cwd: '/remote/work' }]);
    expect(remoteConnect).not.toHaveBeenCalled();
    expect(registry.current('remote')).toBe(remote);
  });

  it('resumes a remote-bound session without a persisted cwd on the remote controller at the default root', async () => {
    const { manager, createCalls, registry, remote, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
      persistedCwd: null,
    });

    await manager.resume('session-1');
    expect(remoteConnect).toHaveBeenCalledTimes(1);
    expect(createCalls).toEqual([{ environmentId: 'remote', cwd: undefined }]);
    expect(registry.current('remote')).toBe(remote);
  });

  it.each<{ title: string; journal: readonly WireRecord[] }>([
    {
      title: 'crossed the switch',
      journal: [
        createWireMetadataRecord(1),
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace-1', environmentId: 'local', time: 2 },
        {
          type: 'context.append_message',
          agentId: 'main',
          message: { role: 'user', content: [{ type: 'text', text: 'switch the environment' }], toolCalls: [] },
          time: 3,
        },
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace-1', environmentId: 'remote', cwd: '/remote/work', time: 4 },
        { type: 'agent.switched', agentId: 'main', branch: 'b1', base: { branch: 'main', line: 2 }, reason: 'undo', turns: 1, legacyUndoLine: 6, time: 5 },
        { type: 'context.undo', agentId: 'main', count: 1, time: 6 },
        { type: 'context.undone', agentId: 'main', turns: 1, time: 7 },
      ],
    },
    {
      title: 'crossed every persisted binding record',
      journal: [
        createWireMetadataRecord(1),
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace-1', environmentId: 'remote', cwd: '/remote/work', time: 2 },
        { type: 'agent.switched', agentId: 'main', branch: 'b1', base: { branch: 'main', line: 1 }, reason: 'undo', turns: 1, legacyUndoLine: 4, time: 3 },
        { type: 'context.undo', agentId: 'main', count: 1, time: 4 },
        { type: 'context.undone', agentId: 'main', turns: 1, time: 5 },
      ],
    },
  ])('does not reconnect or rebind an undone remote binding when the undo fork $title', async ({ journal }) => {
    const { manager, byEnvironment, createCalls, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
      journal,
    });

    await manager.resume('session-1');
    expect(remoteConnect).not.toHaveBeenCalled();
    expect(byEnvironment.has('remote')).toBe(false);
    expect(byEnvironment.has('local')).toBe(true);
    expect(createCalls).toEqual([{ environmentId: 'local', cwd: undefined }]);
  });

  it('honors the restorable chain boundary when the journal holds JSON-valid lines that are not wire records', async () => {
    const { manager, byEnvironment, createCalls, remoteConnect } = restoreSetup({
      remoteStatus: 'disconnected',
      journal: [
        { note: 'a JSON-valid line that is not a wire record' } as unknown as WireRecord,
        createWireMetadataRecord(2),
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace-1', environmentId: 'local', time: 3 },
        { type: 'environment.set_binding', agentId: 'main', workspaceId: 'workspace-1', environmentId: 'remote', cwd: '/remote/work', time: 4 },
        { type: 'agent.switched', agentId: 'main', branch: 'b1', base: { branch: 'main', line: 3 }, reason: 'undo', turns: 1, legacyUndoLine: 6, time: 5 },
        { type: 'context.undo', agentId: 'main', count: 1, time: 6 },
        { type: 'context.undone', agentId: 'main', turns: 1, time: 7 },
      ],
    });

    await manager.resume('session-1');
    expect(remoteConnect).not.toHaveBeenCalled();
    expect(byEnvironment.has('remote')).toBe(false);
    expect(byEnvironment.has('local')).toBe(true);
    expect(createCalls).toEqual([{ environmentId: 'local', cwd: undefined }]);
  });
});
