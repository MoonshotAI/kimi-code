import { IEnvironmentService } from '#/app/environment/environment';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { Error2, ErrorCodes, unwrapErrorCause } from '#/errors';
import { environmentBindingId, LOCAL_ENVIRONMENT_ID, type EnvironmentBinding } from '#/environment/environment';
import { EnvironmentError, environmentIsReady } from '#/environment/environmentRegistry';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { sessionScopeOf, workspacePersistenceScope } from '#/workspace/sessionLifecycle/internal/addressing';
import type {
  CreateChildSessionOptions,
  ForkSessionOptions,
  ResumeSessionOptions,
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionForkedEvent,
  SessionWillCloseEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  ISessionManager,
  type CreateManagedSessionOptions,
  type UnguardedSessionLifecycle,
} from './sessionManager';

interface SessionControllerEntry {
  readonly generation: string;
  readonly controller: SessionLifecycleService;
  readonly subscriptions: DisposableStore;
  sessionCount: number;
}

export class SessionManager implements ISessionManager {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly owners = new Map<string, SessionLifecycleService>();
  private readonly pendingResumes = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly resumeFailures = new Map<string, Error>();
  private readonly lifecycleChains = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, SessionControllerEntry>();
  private readonly controllerEntries = new Set<SessionControllerEntry>();
  private readonly willCreateEmitter = new Emitter<SessionWillCreateEvent>();
  readonly onWillCreateSession: Event<SessionWillCreateEvent> = this.willCreateEmitter.event;
  private readonly didCreateEmitter = new Emitter<SessionCreatedEvent & IWaitUntil>();
  readonly onDidCreateSession = this.didCreateEmitter.event;
  private readonly willCloseEmitter = new Emitter<SessionWillCloseEvent & IWaitUntil>();
  readonly onWillCloseSession = this.willCloseEmitter.event;
  private readonly didCloseEmitter = new Emitter<SessionClosedEvent>();
  readonly onDidCloseSession = this.didCloseEmitter.event;
  private readonly willDeleteEmitter = new Emitter<{ readonly sessionId: string } & IWaitUntil>();
  readonly onWillDeleteSession = this.willDeleteEmitter.event;
  private readonly didArchiveEmitter = new Emitter<SessionArchivedEvent>();
  readonly onDidArchiveSession = this.didArchiveEmitter.event;
  private readonly didForkEmitter = new Emitter<SessionForkedEvent>();
  readonly onDidForkSession = this.didForkEmitter.event;

  constructor(
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ISessionIndex private readonly index: ISessionIndex,
    @IEnvironmentDeclarationService private readonly environmentDeclarations: IEnvironmentDeclarationService,
    @ILogService private readonly log: ILogService,
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle> {
    await this.environments.ready;
    const declarations = await this.environmentDeclarations.declarations();
    const requestedEnvironmentId = options.environmentId;
    const explicitRemote =
      requestedEnvironmentId !== undefined && requestedEnvironmentId !== LOCAL_ENVIRONMENT_ID;
    const registered = explicitRemote ? this.environments.current(requestedEnvironmentId) : undefined;
    const declared = explicitRemote
      ? declarations?.entries.find((entry) => entry.id === requestedEnvironmentId)
      : undefined;
    if (explicitRemote) {
      if (declared === undefined && registered === undefined) {
        if (declarations === undefined) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `environment declarations failed to resolve; cannot validate environment "${requestedEnvironmentId}"`,
          );
        }
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `environment "${requestedEnvironmentId}" is not declared in [environments]`,
        );
      }
      if (options.environmentCwd === undefined && declared?.entry.defaultCwd === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          declared === undefined
            ? `environment "${requestedEnvironmentId}" requires a cwd`
            : `environment "${requestedEnvironmentId}" does not set defaultCwd in [environments]`,
        );
      }
    }
    const resolved = options.environmentId === undefined ? declarations?.default : undefined;
    const environmentId = options.environmentId ?? resolved?.environmentId;
    const environmentCwd = options.environmentCwd ?? resolved?.cwd ?? declared?.entry.defaultCwd;
    const effective =
      environmentId === undefined && environmentCwd === undefined
        ? options
        : { ...options, environmentId, environmentCwd };
    if ((environmentId === undefined || environmentId === LOCAL_ENVIRONMENT_ID) && options.workDir !== undefined) {
      await this.assertUsableWorkDir(options.workDir);
    }
    const workspace = await this.workspaces.getOrCreate(
      options.workspaceId === undefined
        ? { root: options.workDir }
        : { workspaceId: options.workspaceId, root: options.workDir },
    );
    const create = async () => {
      if (environmentId !== undefined) await this.connectForCreate(environmentId, environmentCwd);
      const controllerEnvironmentId = environmentId ?? LOCAL_ENVIRONMENT_ID;
      if (controllerEnvironmentId !== LOCAL_ENVIRONMENT_ID) this.assertControllerEnvironmentReady(controllerEnvironmentId);
      const controllerCwd = controllerEnvironmentId === LOCAL_ENVIRONMENT_ID ? undefined : environmentCwd ?? options.workDir;
      return this.controllerForWorkspace(workspace.id, controllerEnvironmentId, controllerCwd).create(effective);
    };
    if (options.sessionId === undefined) return create();
    return this.serializeLifecycle(options.sessionId, create);
  }

  private async assertUsableWorkDir(workDir: string): Promise<void> {
    let stat;
    try {
      stat = await this.hostFs.stat(workDir);
    } catch (error) {
      const code = (unwrapErrorCause(error) as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${workDir} does not exist`);
      }
      throw error;
    }
    if (!stat.isDirectory) {
      try {
        stat = await this.hostFs.stat(await this.hostFs.realpath(workDir));
      } catch {
      }
    }
    if (!stat.isDirectory) {
      throw new Error2(ErrorCodes.FS_PATH_NOT_FOUND, `workspace root ${workDir} is not a directory`);
    }
  }

  private async connectForCreate(environmentId: string, environmentCwd?: string): Promise<void> {
    if (environmentId === LOCAL_ENVIRONMENT_ID) return;
    await this.connectBoundEnvironment(environmentId);
    if (environmentCwd === undefined) return;
    const lease = this.environments.acquire({ environmentId }, ['fs']);
    try {
      const fs = lease.environment.fs;
      if (fs === undefined) {
        throw new EnvironmentError('environment.capability_unavailable', `environment ${environmentId} does not provide fs`);
      }
      const stat = await fs.stat(environmentCwd).catch((error: unknown) => {
        throw new EnvironmentError(
          'environment.invalid_cwd',
          `cwd ${environmentCwd} is not readable on environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      if (!stat.isDirectory) {
        throw new EnvironmentError('environment.invalid_cwd', `cwd ${environmentCwd} is not a directory on environment ${environmentId}`);
      }
    } finally {
      lease.dispose();
    }
  }

  private async connectBoundEnvironment(environmentId: string): Promise<void> {
    const environment = this.environments.current(environmentId);
    if (environment === undefined) {
      throw new EnvironmentError('environment.unavailable', `environment ${environmentId} is not registered`);
    }
    if (environmentIsReady(environment)) return;
    if (typeof environment.connect !== 'function') {
      throw new EnvironmentError('environment.unavailable', `environment ${environmentId} is ${environment.status}`);
    }
    try {
      await environment.connect();
    } catch (error) {
      throw new EnvironmentError(
        'environment.unavailable',
        `failed to connect environment ${environmentId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    this.assertControllerEnvironmentReady(environmentId);
  }

  private assertControllerEnvironmentReady(environmentId: string): void {
    const environment = this.environments.current(environmentId);
    if (environment !== undefined && environmentIsReady(environment)) return;
    throw new EnvironmentError(
      'environment.unavailable',
      `environment ${environmentId} is ${environment === undefined ? 'not registered' : environment.status}`,
    );
  }

  async resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.pendingResumes.get(sessionId);
    if (inflight !== undefined) return inflight;
    this.resumeFailures.delete(sessionId);
    const promise = this.serializeLifecycle(sessionId, async () => {
      const controller = await this.locateSession(sessionId, { connect: true });
      if (controller === undefined) return undefined;
      return controller.resume(sessionId, options);
    }).finally(() => this.pendingResumes.delete(sessionId));
    this.pendingResumes.set(sessionId, promise);
    void promise.catch((error: unknown) => {
      this.resumeFailures.set(sessionId, error instanceof Error ? error : new Error('session resume failed'));
    });
    return promise;
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  status(sessionId: string): Promise<SessionSummary | undefined> {
    return this.index.get(sessionId);
  }

  async whenResumeSettled(sessionId: string): Promise<void> {
    await this.pendingResumes.get(sessionId);
    const failure = this.resumeFailures.get(sessionId);
    if (failure !== undefined) throw failure;
    await this.owners.get(sessionId)?.whenResumeSettled(sessionId);
  }

  private serializeLifecycle<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(work, work);
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleChains.set(sessionId, next);
    void next.finally(() => {
      if (this.lifecycleChains.get(sessionId) === next) this.lifecycleChains.delete(sessionId);
    });
    return run;
  }

  private serializeLifecycleForKeys<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const [first, ...rest] = keys;
    if (first === undefined) return work();
    return this.serializeLifecycle(first, () => this.serializeLifecycleForKeys(rest, work));
  }

  private lifecycleKeys(...ids: (string | undefined)[]): string[] {
    return [...new Set(ids.filter((id): id is string => id !== undefined))].toSorted();
  }

  withLifecycleSerialization<T>(
    sessionId: string,
    work: (unguarded: UnguardedSessionLifecycle) => Promise<T>,
  ): Promise<T> {
    return this.serializeLifecycle(sessionId, () =>
      work({
        archive: () => this.archiveInner(sessionId),
        restore: () => this.restoreInner(sessionId),
      }),
    );
  }

  list(): readonly ISessionScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, async () => this.owners.get(sessionId)?.close(sessionId));
  }

  private async archiveInner(sessionId: string): Promise<void> {
    await (await this.controllerForSession(sessionId))?.archive(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, () => this.archiveInner(sessionId));
  }

  private async restoreInner(
    sessionId: string,
    options?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const controller = await this.locateSession(sessionId, { connect: true });
    if (controller === undefined) return undefined;
    return controller.restore(sessionId, options);
  }

  async restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    return this.serializeLifecycle(sessionId, () => this.restoreInner(sessionId, options));
  }

  async delete(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, async () => {
      const controller = await this.controllerForSession(sessionId);
      if (controller === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      await controller.close(sessionId);
      const cleanups: Promise<unknown>[] = [];
      this.willDeleteEmitter.fire({
        sessionId,
        signal: new AbortController().signal,
        waitUntil: (cleanup) => {
          if (Object.isFrozen(cleanups)) throw new Error('waitUntil must be called synchronously');
          cleanups.push(cleanup);
        },
      });
      void Object.freeze(cleanups);
      const settled = await Promise.allSettled(cleanups);
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      await controller.delete(sessionId);
    });
  }

  async fork(options: ForkSessionOptions): Promise<SessionMeta> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const controller = await this.controllerForSession(options.sourceSessionId);
        if (controller === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return controller.fork(options);
      },
    );
  }

  async createChild(options: CreateChildSessionOptions): Promise<SessionMeta> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const controller = await this.controllerForSession(options.sourceSessionId);
        if (controller === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return controller.createChild(options);
      },
    );
  }

  dispose(): void {
    for (const { controller, subscriptions } of [...this.controllerEntries].toReversed()) {
      subscriptions.dispose();
      controller.dispose();
    }
    this.controllerEntries.clear();
    this.controllers.clear();
    this.sessions.clear();
    this.owners.clear();
    this.willCreateEmitter.dispose();
    this.didCreateEmitter.dispose();
    this.willCloseEmitter.dispose();
    this.didCloseEmitter.dispose();
    this.willDeleteEmitter.dispose();
    this.didArchiveEmitter.dispose();
    this.didForkEmitter.dispose();
  }

  private controllerForWorkspace(workspaceId: string, environmentId: string = LOCAL_ENVIRONMENT_ID, cwd?: string): SessionLifecycleService {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error(`workspace ${workspaceId} is not materialized`);
    const key = `${workspaceId}\0${environmentBindingId(environmentId, cwd)}`;
    const generation = workspace.program.sessionControllerGenerationFor(environmentId, cwd);
    const existing = this.controllers.get(key);
    if (existing?.generation === generation) return existing.controller;
    const controller = workspace.program.createSessionController(environmentId, cwd);
    const subscriptions = new DisposableStore();
    const entry: SessionControllerEntry = { generation, controller, subscriptions, sessionCount: 0 };
    subscriptions.add(controller.onWillCreateSession((event) => this.willCreateEmitter.fire(event)));
    subscriptions.add(controller.onDidCreateSession((event) => {
      entry.sessionCount += 1;
      this.sessions.set(event.sessionId, event.handle);
      this.owners.set(event.sessionId, controller);
      this.didCreateEmitter.fire(event);
    }));
    subscriptions.add(controller.onWillCloseSession((event) => this.willCloseEmitter.fire(event)));
    subscriptions.add(controller.onDidCloseSession((event) => {
      entry.sessionCount -= 1;
      this.sessions.delete(event.sessionId);
      this.owners.delete(event.sessionId);
      this.didCloseEmitter.fire(event);
      this.retireEntryIfIdle(key, entry);
    }));
    subscriptions.add(controller.onDidArchiveSession((event) => {
      entry.sessionCount -= 1;
      this.sessions.delete(event.sessionId);
      this.owners.delete(event.sessionId);
      this.didArchiveEmitter.fire(event);
      this.retireEntryIfIdle(key, entry);
    }));
    subscriptions.add(controller.onDidForkSession((event) => this.didForkEmitter.fire(event)));
    this.controllerEntries.add(entry);
    this.controllers.set(key, entry);
    if (existing !== undefined) this.retireEntryIfIdle(key, existing);
    return controller;
  }

  private retireEntryIfIdle(key: string, entry: SessionControllerEntry): void {
    if (entry.sessionCount !== 0 || !this.controllerEntries.has(entry)) return;
    this.controllerEntries.delete(entry);
    if (this.controllers.get(key) === entry) this.controllers.delete(key);
    entry.subscriptions.dispose();
    entry.controller.dispose();
  }

  private async controllerForSession(sessionId: string): Promise<SessionLifecycleService | undefined> {
    return this.locateSession(sessionId);
  }

  private async locateSession(sessionId: string, options?: { readonly connect?: boolean }): Promise<SessionLifecycleService | undefined> {
    const live = this.owners.get(sessionId);
    if (live !== undefined) return live;
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    await this.environments.ready;
    const workspace = await this.workspaces.getOrCreate({ workspaceId: summary.workspaceId, root: summary.cwd });
    if (options?.connect !== true) return this.controllerForWorkspace(workspace.id);
    const persistedBinding = await this.readPersistedBinding(workspace.id, sessionId);
    const boundEnvironmentId = persistedBinding?.environmentId ?? LOCAL_ENVIRONMENT_ID;
    if (boundEnvironmentId === LOCAL_ENVIRONMENT_ID) return this.controllerForWorkspace(workspace.id);
    try {
      await this.connectBoundEnvironment(boundEnvironmentId);
    } catch (error) {
      if (!(error instanceof EnvironmentError)) throw error;
      this.log.warn(
        `resume could not connect environment ${boundEnvironmentId}; session ${sessionId} cannot be loaded until the environment is available`,
        { error },
      );
      throw error;
    }
    return this.controllerForWorkspace(workspace.id, boundEnvironmentId, persistedBinding?.cwd);
  }

  private async readPersistedBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined> {
    const scope = sessionScopeOf(
      workspacePersistenceScope(this.bootstrap.scope('sessions'), workspaceId),
      sessionId,
    );
    const meta = await this.docs.get<SessionMeta>(scope, 'state.json');
    if (meta?.environmentId === undefined) return undefined;
    return { environmentId: meta.environmentId, cwd: meta.environmentCwd };
  }
}

registerScopedService(LifecycleScope.App, ISessionManager, SessionManager, ScopeActivation.OnScopeCreated, 'sessionManager');
