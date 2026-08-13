/**
 * `sessionLifecycle` domain — per-handler session lifecycle contract.
 *
 * Defines the public contract of one workspace handler: the
 * `CreateSessionOptions`, `ForkSessionOptions`, `CreateChildSessionOptions`,
 * `ResumeSessionOptions`, and the `ISessionLifecycleService` used to create
 * sessions (`create`), look up the live ones (`get` / `list`), close them
 * (`close`), archive/restore them, delete them (`delete` — closes a live
 * session first, then removes its persisted data and its index entries;
 * unknown ids raise `session.not_found`), fork them (`fork`), and
 * fork-then-tag
 * them as direct children (`createChild`) — always as child scopes of THIS
 * handler's Workspace scope, so a handler owns exactly the sessions of one
 * workspace and fork never crosses handlers. Announces lifecycle transitions
 * through `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession`
 * / `onDidForkSession`; the ordered hook slots are per-session seeds.
 * Workspace-scope services that must participate in a session's creation
 * (read its seeded facts, contribute a session seed, attach teardown to its
 * lifetime) subscribe to `onWillCreateSession` — the participation surface
 * speaks the session domain's own vocabulary, so the lifecycle depends on
 * neither its participants nor the DI kernel's assembly mechanics.
 * Workspace-scoped — one instance per materialized handler.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { McpServerConfig } from '#/mcpCore/config-schema';
import type {
  SessionCloseReason,
  SessionCreateSource,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';

export type { SessionCloseReason, SessionCreateSource };

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mainAgentBinding?: BindAgentInput;
  /**
   * Ephemeral per-session MCP servers: connected only for this session,
   * visible only to this session (an entry shadows a workspace server of the
   * same name), never persisted to any MCP config file, and released when
   * the session closes. Not carried over by fork or resume.
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResumeSessionOptions {
  readonly additionalDirs?: readonly string[];
  /**
   * Ephemeral per-session MCP servers — the same semantics as
   * `CreateSessionOptions.mcpServers`: a session-owned overlay connected for
   * this session only, never persisted, released when the session closes.
   * Ignored when the session is already live (resume passes through).
   */
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

/**
 * Participation surface of `onWillCreateSession` — the business-lifecycle
 * moment "a session is being created", fired synchronously before the new
 * session's services activate (the `will` half of `onDidCreateSession`;
 * resume and fork are creations too). Workspace-scope participants step
 * into the creation through the session domain's own vocabulary — read the
 * session's seeded facts (`readSeed`), contribute or replace a session seed
 * (`contributeSeed`; a seed already projected by the workspace seed
 * adapters is replaced), and attach teardown work to the session's lifetime
 * (`onSessionDispose` — runs with the session's teardown on every path:
 * close, archive, delete, a failed create, workspace teardown). The event
 * carries only facts the lifecycle itself owns; anything a participant
 * needs beyond them travels as a session-domain seed.
 */
export interface SessionWillCreateEvent {
  readonly sessionId: string;
  readSeed<T>(id: ServiceIdentifier<T>): T;
  contributeSeed<T>(id: ServiceIdentifier<T>, value: T): void;
  onSessionDispose(dispose: () => void): void;
}

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  readonly onWillCreateSession: Event<SessionWillCreateEvent>;
  readonly onDidCreateSession: Event<SessionCreatedEvent>;
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
