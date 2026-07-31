/**
 * `sessionLifecycle` domain (L6) — per-handler session lifecycle contract.
 *
 * Defines the public contract of one workspace handler: the
 * `CreateSessionOptions`, `ForkSessionOptions`, `CreateChildSessionOptions`,
 * `ResumeSessionOptions`, and the `ISessionLifecycleService` used to create
 * sessions (`create`), look up the live ones (`get` / `list`), close them
 * (`close`), archive/restore them, fork them (`fork`), and fork-then-tag
 * them as direct children (`createChild`) — always as child scopes of THIS
 * handler's Workspace scope, so a handler owns exactly the sessions of one
 * workspace and fork never crosses handlers. Announces lifecycle transitions
 * through `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession`
 * / `onDidForkSession`; the ordered hook slots are per-session seeds
 * (`sessionLifecycleHooks`). Workspace-scoped — one instance per
 * materialized handler. Persisted sessions (open or closed) are the
 * `sessionIndex` read model; per-session behaviour lives in the
 * Session-scoped domains.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { BindAgentInput } from '#/agent/profile/profile';
import type {
  SessionCloseReason,
  SessionCreateSource,
} from '#/session/sessionLifecycleHooks/sessionLifecycleHooks';

export type { SessionCloseReason, SessionCreateSource };

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  /**
   * Caller-provided additional workspace directories, resolved against
   * `workDir` and unioned into the handler's SHARED in-memory set (every
   * session of this workspace sees them; never persisted).
   */
  readonly additionalDirs?: readonly string[];
  readonly mainAgentBinding?: BindAgentInput;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ResumeSessionOptions {
  /**
   * Caller-provided additional workspace directories, re-resolved against the
   * session workDir and unioned into the handler's shared in-memory set (same
   * semantics as `CreateSessionOptions.additionalDirs`).
   */
  readonly additionalDirs?: readonly string[];
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

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

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
  restore(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
