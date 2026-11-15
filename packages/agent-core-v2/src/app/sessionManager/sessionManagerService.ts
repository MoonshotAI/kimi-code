
import { IEnvironmentService } from '#/app/environment/environment';
import { DisposableStore } from '#/_base/di/lifecycle';
import { IEnvironmentDeclarationService } from '#/app/environmentDeclaration/environmentDeclaration';
import { normalizeRemoteCwd } from '#/environment/environmentDefaults';
import { LOCAL_ENVIRONMENT_ID } from '#/environment/environment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes, isError2, SessionErrors, unwrapErrorCause } from '#/errors';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IAgentCronService } from '#/features/cron/cronService';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionLockService, type SessionLockLease } from '#/persistence/interface/sessionLock';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionActivityView } from '#/session/sessionActivity/sessionActivity';
import {
  type CreateChildSessionOptions,
  type ForkSessionOptions,
  type ResumeSessionOptions,
  type SessionArchivedEvent,
  type SessionClosedEvent,
  type SessionCreatedEvent,
  type SessionForkedEvent,
  type SessionWillCloseEvent,
  type SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import { IWorkspaceInstanceManager, type WorkspaceInstanceLease, type WorkspaceInstanceRef } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import {
  ISessionManager,
  type CreateManagedSessionOptions,
  type UnguardedSessionLifecycle,
} from './sessionManager';

interface SessionControllerEntry {
  readonly workspaceId: string;
  readonly workspaceLease: WorkspaceInstanceLease;
  readonly generation: string;
  readonly controller: SessionLifecycleService;
  readonly subscriptions: DisposableStore;
  sessionCount: number;
  operationCount: number;
}

export class SessionManager implements ISessionManager {
  declare readonly _serviceBrand: undefined;
  private readonly sessions = new Map<string, ISessionScopeHandle>();
  private readonly owners = new Map<string, SessionControllerEntry>();
  private readonly pendingResumes = new Map<string, Promise<ISessionScopeHandle | undefined>>();
  private readonly resumeFailures = new Map<string, Error>();
  private readonly reclaimed = new Set<string>();
  private readonly lifecycleChains = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, SessionControllerEntry>();
  private readonly controllerEntries = new Set<SessionControllerEntry>();
  private disposed = false;
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
    @IEnvironmentService private readonly environments: IEnvironmentService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @ISessionLockService private readonly sessionLocks: ISessionLockService,
  ) {}

  async resolveCreationEnvironment(options: CreateManagedSessionOptions) {
    const opened = await this.openCreation(options);
    opened.lease.dispose();
    return {
      workspaceId: opened.workspaceId,
      environmentId: opened.environmentId,
      environmentCwd: opened.environmentCwd,
    };
  }

  async create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle> {
    const opened = await this.openCreation(options);
    try {
      const effective = opened.environmentId === undefined && opened.environmentCwd === undefined
        ? options
        : { ...options, environmentId: opened.environmentId, environmentCwd: opened.environmentCwd };
      const create = async () => {
        const entry = await this.controllerForWorkspace({
          workspaceId: opened.workspaceId,
          root: options.workDir,
        });
        return this.runControllerOperation(entry, (controller) => controller.create(effective));
      };
      if (options.sessionId === undefined) return await create();
      return await this.serializeLifecycle(options.sessionId, create);
    } finally {
      opened.lease.dispose();
    }
  }

  private async openCreation(options: CreateManagedSessionOptions) {
    await this.environments.ready;
    const declarations = options.environmentId === LOCAL_ENVIRONMENT_ID
      ? undefined
      : await this.environmentDeclarations.declarations();
    const environmentId = options.environmentId ?? declarations?.defaultId;
    const remote = environmentId !== undefined && environmentId !== LOCAL_ENVIRONMENT_ID;
    if (options.workDir !== undefined && !remote) await this.assertUsableWorkDir(options.workDir);
    const lease = await this.workspaces.acquire(
      options.workspaceId === undefined
        ? { root: options.workDir }
        : { workspaceId: options.workspaceId, root: options.workDir },
    );
    try {
      if (!remote) {
        return {
          workspaceId: lease.instance.id,
          environmentId,
          environmentCwd: options.environmentCwd,
          lease,
        };
      }
      const registrationError = this.environmentDeclarations.registrationError(environmentId);
      if (registrationError !== undefined) throw registrationError;
      const declared = declarations?.entries.find((entry) => entry.id === environmentId);
      if (declared === undefined && this.environments.current(environmentId) === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `environment "${environmentId}" is not declared in [environments]`,
        );
      }
      const cwd = options.environmentCwd ?? declared?.entry.defaultCwd;
      if (cwd === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          declared === undefined
            ? `environment "${environmentId}" requires a cwd`
            : `environment "${environmentId}" does not set defaultCwd in [environments]`,
        );
      }
      return {
        workspaceId: lease.instance.id,
        environmentId,
        environmentCwd: declared === undefined ? cwd : normalizeRemoteCwd(cwd),
        lease,
      };
    } catch (error) {
      lease.dispose();
      throw error;
    }
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

  async resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.pendingResumes.get(sessionId);
    if (inflight !== undefined) return inflight;
    this.resumeFailures.delete(sessionId);
    const promise = this.serializeLifecycle(sessionId, async () => {
      const entry = await this.controllerForSession(sessionId);
      if (entry === undefined) return undefined;
      return this.runControllerOperation(entry, (controller) => controller.resume(
        sessionId,
        options,
        this.reclaimed.has(sessionId) ? 'reclaimed' : 'resume',
      ));
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
    await this.owners.get(sessionId)?.controller.whenResumeSettled(sessionId);
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
    await this.serializeLifecycle(sessionId, async () => {
      const entry = this.owners.get(sessionId);
      if (entry === undefined) return;
      await this.runControllerOperation(
        this.retainController(entry),
        (controller) => controller.close(sessionId),
      );
    });
  }

  async closeIfIdle(sessionId: string, idleTimeoutMs: number): Promise<boolean> {
    return this.serializeLifecycle(sessionId, async () => {
      const handle = this.sessions.get(sessionId);
      const entry = this.owners.get(sessionId);
      if (handle === undefined || entry === undefined) return false;
      return this.runControllerOperation(this.retainController(entry), async (controller) => {
        if (Date.now() - handle.accessor.get(ISessionActivityView).lastActiveAt() < idleTimeoutMs) return false;
        let lease: SessionLockLease;
        try {
          lease = this.sessionLocks.lease(sessionId);
        } catch (error) {
          if (isError2(error) && error.code === SessionErrors.codes.SESSION_OCCUPIED) return false;
          throw error;
        }
        try {
          if (await this.retained(handle)) return false;
          await controller.close(sessionId, 'reclaim');
          this.reclaimed.add(sessionId);
          return true;
        } finally {
          lease.release();
        }
      });
    });
  }

  private async retained(handle: ISessionScopeHandle): Promise<boolean> {
    const agents = handle.accessor.get(IAgentLifecycleService);
    const hasCron = agents
      .list()
      .some((agent) => (agents.handleOf(agent.agentId)?.accessor.get(IAgentCronService).list().length ?? 0) > 0);
    if (hasCron) return true;
    const activity = handle.accessor.get(ISessionActivityView).state();
    return activity.busy || activity.pendingInteraction !== 'none';
  }

  private async archiveInner(sessionId: string): Promise<void> {
    const entry = await this.controllerForSession(sessionId);
    if (entry !== undefined) {
      await this.runControllerOperation(entry, (controller) => controller.archive(sessionId));
    }
    this.reclaimed.delete(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, () => this.archiveInner(sessionId));
  }

  private async restoreInner(
    sessionId: string,
    options?: ResumeSessionOptions,
  ): Promise<ISessionScopeHandle | undefined> {
    const entry = await this.controllerForSession(sessionId);
    if (entry === undefined) return undefined;
    return this.runControllerOperation(entry, (controller) => controller.restore(sessionId, options));
  }

  async restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    return this.serializeLifecycle(sessionId, () => this.restoreInner(sessionId, options));
  }

  async delete(sessionId: string): Promise<void> {
    await this.serializeLifecycle(sessionId, async () => {
      const entry = await this.controllerForSession(sessionId);
      if (entry === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
      }
      await this.runControllerOperation(entry, async (controller) => {
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
        this.reclaimed.delete(sessionId);
      });
    });
  }

  async fork(options: ForkSessionOptions): Promise<SessionMeta> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const entry = await this.controllerForSession(options.sourceSessionId);
        if (entry === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return this.runControllerOperation(entry, (controller) => controller.fork(options));
      },
    );
  }

  async createChild(options: CreateChildSessionOptions): Promise<SessionMeta> {
    return this.serializeLifecycleForKeys(
      this.lifecycleKeys(options.sourceSessionId, options.newSessionId),
      async () => {
        const entry = await this.controllerForSession(options.sourceSessionId);
        if (entry === undefined) {
          throw new Error2(
            ErrorCodes.SESSION_NOT_FOUND,
            `session ${options.sourceSessionId} does not exist`,
          );
        }
        return this.runControllerOperation(entry, (controller) => controller.createChild(options));
      },
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.controllerEntries].toReversed()) this.disposeEntry(entry);
    this.controllerEntries.clear();
    this.controllers.clear();
    this.sessions.clear();
    this.owners.clear();
    this.reclaimed.clear();
    this.willCreateEmitter.dispose();
    this.didCreateEmitter.dispose();
    this.willCloseEmitter.dispose();
    this.didCloseEmitter.dispose();
    this.willDeleteEmitter.dispose();
    this.didArchiveEmitter.dispose();
    this.didForkEmitter.dispose();
  }

  private async controllerForWorkspace(ref: WorkspaceInstanceRef): Promise<SessionControllerEntry> {
    const workspaceLease = await this.workspaces.acquire(ref);
    try {
      if (this.disposed) throw new Error('session manager is disposed');
      const workspace = workspaceLease.instance;
      const workspaceId = workspace.id;
      const generation = workspace.program.sessionControllerGeneration;
      const existing = this.controllers.get(workspaceId);
      if (existing?.generation === generation) {
        existing.operationCount += 1;
        workspaceLease.dispose();
        return existing;
      }
      const controller = workspace.program.createSessionController();
      const subscriptions = new DisposableStore();
      const entry: SessionControllerEntry = {
        workspaceId,
        workspaceLease,
        generation,
        controller,
        subscriptions,
        sessionCount: 0,
        operationCount: 1,
      };
      subscriptions.add(controller.onWillCreateSession((event) => this.willCreateEmitter.fire(event)));
      subscriptions.add(controller.onDidCreateSession((event) => {
        entry.sessionCount += 1;
        this.reclaimed.delete(event.sessionId);
        this.sessions.set(event.sessionId, event.handle);
        this.owners.set(event.sessionId, entry);
        this.didCreateEmitter.fire(event);
      }));
      subscriptions.add(controller.onWillCloseSession((event) => this.willCloseEmitter.fire(event)));
      subscriptions.add(controller.onDidCloseSession((event) => {
        entry.sessionCount -= 1;
        this.sessions.delete(event.sessionId);
        this.owners.delete(event.sessionId);
        this.didCloseEmitter.fire(event);
        this.retireEntryIfIdle(entry);
      }));
      subscriptions.add(controller.onDidArchiveSession((event) => {
        entry.sessionCount -= 1;
        this.sessions.delete(event.sessionId);
        this.owners.delete(event.sessionId);
        this.didArchiveEmitter.fire(event);
        this.retireEntryIfIdle(entry);
      }));
      subscriptions.add(controller.onDidForkSession((event) => this.didForkEmitter.fire(event)));
      this.controllerEntries.add(entry);
      this.controllers.set(workspaceId, entry);
      if (existing !== undefined) this.retireEntryIfIdle(existing);
      return entry;
    } catch (error) {
      workspaceLease.dispose();
      throw error;
    }
  }

  private retainController(entry: SessionControllerEntry): SessionControllerEntry {
    entry.operationCount += 1;
    return entry;
  }

  private async runControllerOperation<T>(
    entry: SessionControllerEntry,
    work: (controller: SessionLifecycleService) => Promise<T>,
  ): Promise<T> {
    try {
      return await work(entry.controller);
    } finally {
      entry.operationCount -= 1;
      this.retireEntryIfIdle(entry);
    }
  }

  private retireEntryIfIdle(entry: SessionControllerEntry): void {
    if (entry.sessionCount !== 0 || entry.operationCount !== 0 || !this.controllerEntries.has(entry)) return;
    this.controllerEntries.delete(entry);
    if (this.controllers.get(entry.workspaceId) === entry) this.controllers.delete(entry.workspaceId);
    this.disposeEntry(entry);
  }

  private disposeEntry(entry: SessionControllerEntry): void {
    try {
      entry.subscriptions.dispose();
    } finally {
      try {
        entry.controller.dispose();
      } finally {
        entry.workspaceLease.dispose();
      }
    }
  }

  private async controllerForSession(sessionId: string): Promise<SessionControllerEntry | undefined> {
    const live = this.owners.get(sessionId);
    if (live !== undefined) return this.retainController(live);
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    await this.environments.ready;
    return this.controllerForWorkspace({ workspaceId: summary.workspaceId, root: summary.cwd });
  }
}

registerScopedService(LifecycleScope.App, ISessionManager, SessionManager, ScopeActivation.OnScopeCreated, 'sessionManager');
