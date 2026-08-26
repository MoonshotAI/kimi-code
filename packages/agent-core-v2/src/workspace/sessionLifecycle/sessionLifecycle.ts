import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import { type Event, type IWaitUntil } from '#/_base/event';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { McpServerConfig } from '#/mcpCore/config-schema';

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit' | 'archive';

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mainAgentBinding?: BindAgentInput;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
  readonly turnIndex?: number;
}

export interface ResumeSessionOptions {
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly source: SessionCreateSource;
}

export interface SessionClosedEvent {
  readonly sessionId: string;
}

export interface SessionWillCloseEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly reason: SessionCloseReason;
}

export interface SessionArchivedEvent {
  readonly sessionId: string;
}

export interface SessionForkedEvent {
  readonly sourceSessionId: string;
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
}

export interface SessionWillCreateEvent {
  readonly sessionId: string;
  readSeed<T>(id: ServiceIdentifier<T>): T;
  contributeSeed<T>(id: ServiceIdentifier<T>, value: T): void;
  onSessionDispose(dispose: () => void): void;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onWillCreateSession: Event<SessionWillCreateEvent>;
  readonly onDidCreateSession: Event<SessionCreatedEvent & IWaitUntil>;
  readonly onWillCloseSession: Event<SessionWillCloseEvent & IWaitUntil>;
  readonly onDidCloseSession: Event<SessionClosedEvent>;
  readonly onDidArchiveSession: Event<SessionArchivedEvent>;
  readonly onDidForkSession: Event<SessionForkedEvent>;
  create(opts: CreateSessionOptions): Promise<ISessionScopeHandle>;
  get(sessionId: string): ISessionScopeHandle | undefined;
  list(): readonly ISessionScopeHandle[];
  resume(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string, opts?: ResumeSessionOptions): Promise<ISessionScopeHandle | undefined>;
  delete(sessionId: string): Promise<void>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
