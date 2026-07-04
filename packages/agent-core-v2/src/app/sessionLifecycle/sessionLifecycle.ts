/**
 * `sessionLifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`,
 * `ForkSessionOptions`, and the `ISessionLifecycleService` used to create
 * sessions (`create`), look up the live ones (`get` / `list`), close them
 * (`close`), archive them (`archive`), and fork them (`fork`). Announces
 * lifecycle transitions through `onDidCreateSession` / `onDidCloseSession` /
 * `onDidArchiveSession` / `onDidForkSession`. App-scoped — a single
 * process-wide instance owns the live session scope tree. Persisted
 * sessions (open or closed) are the `sessionIndex` read model; per-session
 * behaviour lives in the Session-scoped domains.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';

export interface CreateSessionOptions {
  readonly sessionId: string;
  readonly workDir: string;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  /** Title for the forked session. Defaults to `Fork: <source title or id>`. */
  readonly title?: string;
  /** Custom metadata merged (minus reserved `goal`) into the forked session. */
  readonly metadata?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
}

export interface SessionClosedEvent {
  readonly sessionId: string;
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
  /**
   * Load a persisted session into the live scope tree and restore its main
   * agent from the persisted wire log. Returns the existing handle when the
   * session is already live (a no-op in that case — live agents are never
   * re-restored). Returns `undefined` when the session is unknown to the index
   * or its workspace is no longer registered (mirrors the cold-source
   * limitation of `fork`).
   *
   * Lets the read edges (snapshot / messages) serve cold sessions — created by
   * a previous process or by v1 — without requiring a prior `create` in this
   * process. Restores only the main agent; sub-agents are materialized lazily.
   */
  resume(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
