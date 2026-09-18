
import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { EnvironmentSetBinding } from '#/agent/environmentBinding/environmentBindingOps';
import { LOCAL_ENVIRONMENT_ID, type EnvironmentBinding } from '#/environment/environment';
import { resolveWorkspaceEnvironmentDeclarations } from '#/environment/environmentDeclarations';
import type { EnvironmentDeclarationSet } from '#/environment/remoteEnvironmentDeclaration';
import { EnvironmentError, environmentStatusAllows } from '#/environment/environmentRegistry';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import type { SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import {
  agentScopeOf,
  sessionScopeOf,
  workspacePersistenceScope,
} from '#/workspace/sessionLifecycle/internal/addressing';
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
import type { WorkspaceInstance } from '#/workspace/workspaceInstance/workspaceInstance';
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

interface LocatedSession {
  readonly controller: SessionLifecycleService;
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
    @IConfigService private readonly config: IConfigService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @IAppendLogStore private readonly appendLogStore: IAppendLogStore,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {}

  async create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle> {
    const workspace = await this.workspaces.getOrCreate(
      options.workspaceId === undefined
        ? { root: options.workDir }
        : { workspaceId: options.workspaceId, root: options.workDir },
    );
    const declarations = await this.workspaceEnvironmentDeclarations(workspace);
    const declared =
      options.environmentId === undefined || options.environmentId === LOCAL_ENVIRONMENT_ID
        ? undefined
        : declarations?.entries.find((entry) => entry.id === options.environmentId);
    if (options.environmentId !== undefined && options.environmentId !== LOCAL_ENVIRONMENT_ID && declarations !== undefined) {
      if (declared === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `environment "${options.environmentId}" is not declared in [environments]`,
        );
      }
      if (options.environmentCwd === undefined && declared.entry.defaultCwd === undefined) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `environment "${options.environmentId}" does not set defaultCwd in [environments]`,
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
    const create = async () => {
      if (environmentId !== undefined) await this.connectForCreate(workspace, environmentId, environmentCwd);
      const controllerEnvironmentId = this.selectControllerEnvironmentId(workspace, environmentId ?? LOCAL_ENVIRONMENT_ID);
      const controllerCwd = controllerEnvironmentId === LOCAL_ENVIRONMENT_ID ? undefined : environmentCwd ?? options.workDir;
      return this.controllerForWorkspace(workspace.id, controllerEnvironmentId, controllerCwd).create(effective);
    };
    if (options.sessionId === undefined) return create();
    return this.serializeLifecycle(options.sessionId, create);
  }

  private async connectForCreate(workspace: WorkspaceInstance, environmentId: string, environmentCwd?: string): Promise<void> {
    if (environmentId === LOCAL_ENVIRONMENT_ID) return;
    let environment = workspace.environments.current(environmentId);
    if (environment === undefined) return;
    if (!environmentStatusAllows(environment, ['fs', 'process'])) {
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
    }
    if (environmentCwd === undefined) return;
    environment = workspace.environments.current(environmentId);
    if (environment === undefined) return;
    const lease = workspace.environments.acquire({ workspaceId: workspace.id, environmentId }, ['fs']);
    try {
      const stat = await lease.environment.fs!.stat(environmentCwd).catch((error: unknown) => {
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

  private async workspaceEnvironmentDeclarations(workspace: WorkspaceInstance): Promise<EnvironmentDeclarationSet | undefined> {
    try {
      const declarations = await resolveWorkspaceEnvironmentDeclarations({
        config: this.config,
        fs: this.fs,
        docs: this.docs,
        root: workspace.root,
      });
      if (declarations.projectError !== undefined) {
        this.log.warn('project remote environment declarations failed to load', { error: declarations.projectError });
      }
      return declarations;
    } catch (error) {
      this.log.warn('remote environment declaration resolution failed', { error });
      return undefined;
    }
  }

  private selectControllerEnvironmentId(workspace: WorkspaceInstance, environmentId: string): string {
    if (environmentId === LOCAL_ENVIRONMENT_ID) return LOCAL_ENVIRONMENT_ID;
    const environment = workspace.environments.current(environmentId);
    if (environment === undefined || !environmentStatusAllows(environment, ['fs', 'process'])) return LOCAL_ENVIRONMENT_ID;
    return environmentId;
  }

  async resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    const inflight = this.pendingResumes.get(sessionId);
    if (inflight !== undefined) return inflight;
    this.resumeFailures.delete(sessionId);
    const promise = this.serializeLifecycle(sessionId, async () => {
      const located = await this.locateSession(sessionId, { connect: true });
      if (located === undefined) return undefined;
      return located.controller.resume(sessionId, options);
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
    const located = await this.locateSession(sessionId, { connect: true });
    if (located === undefined) return undefined;
    return located.controller.restore(sessionId, options);
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
    const key = `${workspaceId}\0${environmentId}\0${cwd ?? ''}`;
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
    return (await this.locateSession(sessionId))?.controller;
  }

  private async locateSession(sessionId: string, options?: { readonly connect?: boolean }): Promise<LocatedSession | undefined> {
    const live = this.owners.get(sessionId);
    if (live !== undefined) return { controller: live };
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace = await this.workspaces.getOrCreate({ workspaceId: summary.workspaceId, root: summary.cwd });
    const persistedBinding = await this.peekPersistedBinding(workspace.id, sessionId);
    const boundEnvironmentId = persistedBinding?.environmentId ?? LOCAL_ENVIRONMENT_ID;
    if (options?.connect === true && boundEnvironmentId !== LOCAL_ENVIRONMENT_ID) {
      await this.connectForCreate(workspace, boundEnvironmentId);
    }
    const controllerEnvironmentId = this.selectControllerEnvironmentId(workspace, boundEnvironmentId);
    return {
      controller: this.controllerForWorkspace(
        workspace.id,
        controllerEnvironmentId,
        controllerEnvironmentId === LOCAL_ENVIRONMENT_ID ? undefined : persistedBinding?.cwd,
      ),
    };
  }

  private async peekPersistedBinding(workspaceId: string, sessionId: string): Promise<EnvironmentBinding | undefined> {
    try {
      const scope = agentScopeOf(
        sessionScopeOf(workspacePersistenceScope(this.bootstrap.scope('sessions'), workspaceId), sessionId),
        MAIN_AGENT_ID,
      );
      let binding: EnvironmentBinding | undefined;
      for await (const record of this.appendLogStore.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        if (record.type === EnvironmentSetBinding.type && typeof record['environmentId'] === 'string') {
          binding = {
            workspaceId,
            environmentId: record['environmentId'],
            cwd: typeof record['cwd'] === 'string' ? record['cwd'] : undefined,
          };
        }
      }
      return binding;
    } catch {
      return undefined;
    }
  }
}

registerScopedService(LifecycleScope.App, ISessionManager, SessionManager, ScopeActivation.OnScopeCreated, 'sessionManager');
