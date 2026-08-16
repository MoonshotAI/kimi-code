import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter, type Event, type IWaitUntil } from '#/_base/event';
import { ScopeActivation, registerScopedService, type ISessionScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { Error2, ErrorCodes } from '#/errors';
import { ISessionIndex } from '#/app/sessionIndex/sessionIndex';
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
import { IWorkspaceInstanceManager } from '#/workspace/workspaceInstance/workspaceInstanceManager';

import { ISessionManager, type CreateManagedSessionOptions } from './sessionManager';

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
  private readonly didArchiveEmitter = new Emitter<SessionArchivedEvent>();
  readonly onDidArchiveSession = this.didArchiveEmitter.event;
  private readonly didForkEmitter = new Emitter<SessionForkedEvent>();
  readonly onDidForkSession = this.didForkEmitter.event;

  constructor(
    @IWorkspaceInstanceManager private readonly workspaces: IWorkspaceInstanceManager,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle> {
    const workspace = await this.workspaces.getOrCreate(
      options.workspaceId === undefined
        ? { root: options.workDir }
        : { workspaceId: options.workspaceId, root: options.workDir },
    );
    return this.controllerForWorkspace(workspace.id).create(options);
  }

  async resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    return (await this.controllerForSession(sessionId))?.resume(sessionId, options);
  }

  get(sessionId: string): ISessionScopeHandle | undefined {
    return this.sessions.get(sessionId);
  }

  list(): readonly ISessionScopeHandle[] {
    return [...this.sessions.values()];
  }

  async close(sessionId: string): Promise<void> {
    await this.owners.get(sessionId)?.close(sessionId);
  }

  async archive(sessionId: string): Promise<void> {
    await (await this.controllerForSession(sessionId))?.archive(sessionId);
  }

  async restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined> {
    return (await this.controllerForSession(sessionId))?.restore(sessionId, options);
  }

  async delete(sessionId: string): Promise<void> {
    const controller = await this.controllerForSession(sessionId);
    if (controller === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    await controller.delete(sessionId);
  }

  async fork(options: ForkSessionOptions): Promise<ISessionScopeHandle> {
    const controller = await this.controllerForSession(options.sourceSessionId);
    if (controller === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session ${options.sourceSessionId} does not exist`,
      );
    }
    return controller.fork(options);
  }

  async createChild(options: CreateChildSessionOptions): Promise<ISessionScopeHandle> {
    const controller = await this.controllerForSession(options.sourceSessionId);
    if (controller === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session ${options.sourceSessionId} does not exist`,
      );
    }
    return controller.createChild(options);
  }

  dispose(): void {
    for (const { controller, subscriptions } of [...this.controllerEntries].reverse()) {
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
    this.didArchiveEmitter.dispose();
    this.didForkEmitter.dispose();
  }

  private controllerForWorkspace(workspaceId: string): SessionLifecycleService {
    const workspace = this.workspaces.get(workspaceId);
    if (workspace === undefined) throw new Error(`workspace ${workspaceId} is not materialized`);
    const generation = workspace.program.sessionControllerGeneration;
    const existing = this.controllers.get(workspaceId);
    if (existing?.generation === generation) return existing.controller;
    const controller = workspace.program.createSessionController();
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
      this.retireEntryIfIdle(workspaceId, entry);
    }));
    subscriptions.add(controller.onDidArchiveSession((event) => {
      entry.sessionCount -= 1;
      this.sessions.delete(event.sessionId);
      this.owners.delete(event.sessionId);
      this.didArchiveEmitter.fire(event);
      this.retireEntryIfIdle(workspaceId, entry);
    }));
    subscriptions.add(controller.onDidForkSession((event) => this.didForkEmitter.fire(event)));
    this.controllerEntries.add(entry);
    this.controllers.set(workspaceId, entry);
    if (existing !== undefined) this.retireEntryIfIdle(workspaceId, existing);
    return controller;
  }

  private retireEntryIfIdle(workspaceId: string, entry: SessionControllerEntry): void {
    if (entry.sessionCount !== 0 || !this.controllerEntries.has(entry)) return;
    this.controllerEntries.delete(entry);
    if (this.controllers.get(workspaceId) === entry) this.controllers.delete(workspaceId);
    entry.subscriptions.dispose();
    entry.controller.dispose();
  }

  private async controllerForSession(sessionId: string): Promise<SessionLifecycleService | undefined> {
    const live = this.owners.get(sessionId);
    if (live !== undefined) return live;
    const summary = await this.index.get(sessionId);
    if (summary === undefined) return undefined;
    const workspace = await this.workspaces.getOrCreate({ workspaceId: summary.workspaceId, root: summary.cwd });
    return this.controllerForWorkspace(workspace.id);
  }
}

registerScopedService(LifecycleScope.App, ISessionManager, SessionManager, ScopeActivation.OnScopeCreated, 'sessionManager');
