import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event, IWaitUntil } from '#/_base/event';
import type {
  CreateChildSessionOptions,
  CreateSessionOptions,
  ForkSessionOptions,
  ResumeSessionOptions,
  SessionArchivedEvent,
  SessionClosedEvent,
  SessionCreatedEvent,
  SessionForkedEvent,
  SessionWillCloseEvent,
  SessionWillCreateEvent,
} from '#/workspace/sessionLifecycle/sessionLifecycle';

export interface CreateManagedSessionOptions extends CreateSessionOptions {
  readonly workspaceId?: string;
}

export interface ISessionManager {
  readonly _serviceBrand: undefined;
  readonly onWillCreateSession?: Event<SessionWillCreateEvent>;
  readonly onDidCreateSession?: Event<SessionCreatedEvent & IWaitUntil>;
  readonly onWillCloseSession?: Event<SessionWillCloseEvent & IWaitUntil>;
  readonly onDidCloseSession?: Event<SessionClosedEvent>;
  readonly onDidArchiveSession?: Event<SessionArchivedEvent>;
  readonly onDidForkSession?: Event<SessionForkedEvent>;
  create(options: CreateManagedSessionOptions): Promise<ISessionScopeHandle>;
  resume(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string, options?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  delete(sessionId: string): Promise<void>;
  fork(options: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(options: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionManager: ServiceIdentifier<ISessionManager> = createDecorator<ISessionManager>('sessionManager');
