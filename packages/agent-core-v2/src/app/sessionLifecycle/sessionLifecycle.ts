/**
 * `sessionLifecycle` domain (L6) — creates and tracks sessions at the process root.
 *
 * Defines the public contract of session lifecycle: the `CreateSessionOptions`,
 * `ForkSessionOptions`, `CreateChildSessionOptions`, and the
 * `ISessionLifecycleService` used to create sessions (`create`), look up the
 * live ones (`get` / `list`), close them (`close`), archive/restore them,
 * fork them (`fork`), and fork-then-tag them as direct children (`createChild`). Announces
 * lifecycle transitions through ordered hook slots plus
 * `onDidCreateSession` / `onDidCloseSession` / `onDidArchiveSession` /
 * `onDidForkSession`. App-scoped — a single
 * process-wide instance owns the live session scope tree. Persisted
 * sessions (open or closed) are the `sessionIndex` read model; per-session
 * behaviour lives in the Session-scoped domains.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ISessionScopeHandle } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { Hooks } from '#/hooks';

export interface CreateSessionOptions {
  /**
   * Caller-supplied session id. When omitted, the lifecycle mints one in the
   * canonical `session_<lowercase-uuid>` form (matches v1's `createSessionId`).
   * Pass an explicit id only to resume/recreate a session under a known id.
   */
  readonly sessionId?: string;
  readonly workDir: string;
  /** Extra workspace roots for this session; relative paths resolve against workDir. */
  readonly additionalDirs?: readonly string[];
  /**
   * Caller-supplied MCP servers for this session (v1's
   * `CreateSessionPayload.mcpServers`): merged over the file config and under
   * plugin servers when the session's MCP connections are established. Only
   * `create` carries them; resumes and forks connect from the file config alone.
   */
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  /** Title for the forked session. Defaults to `Fork: <source title or id>`. */
  readonly title?: string;
  /** Custom metadata merged (minus reserved `goal`) into the forked session. */
  readonly metadata?: Record<string, unknown>;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  /** Title for the child session. Defaults to `Child: <source title or id>`. */
  readonly title?: string;
  /**
   * Custom metadata merged into the child session. The `parent_session_id` and
   * `child_session_kind` markers are added automatically (and win over any
   * caller-supplied values) so the child is discoverable via the session index.
   */
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

export type SessionCreateSource = 'startup' | 'resume' | 'fork';

export type SessionCloseReason = 'exit';

export interface SessionWillCloseEvent {
  readonly sessionId: string;
  readonly handle: ISessionScopeHandle;
  readonly reason: SessionCloseReason;
}

export type SessionLifecycleHooks = {
  readonly onDidCreateSession: SessionCreatedEvent;
  readonly onWillCloseSession: SessionWillCloseEvent;
};

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
  readonly hooks: Hooks<SessionLifecycleHooks>;
  create(opts: CreateSessionOptions): Promise<ISessionScopeHandle>;
  /**
   * Return the live handle for `sessionId`, or `undefined` when it is not open.
   * A session whose cold {@link resume} is still in flight is intentionally NOT
   * returned — its main agent has not finished restore + replay, so the handle
   * is half-initialized. Callers that must obtain the handle should
   * `await resume(sessionId)` instead. This invisibility is a service
   * invariant, not caller discipline: every read path (`get` / {@link list} /
   * {@link resume}) agrees a resuming session is not yet observable.
   */
  get(sessionId: string): ISessionScopeHandle | undefined;
  /**
   * Snapshot of every fully-initialized live session. Excludes sessions still
   * mid-{@link resume} for the same reason as {@link get}.
   */
  list(): readonly ISessionScopeHandle[];
  /**
   * Load a persisted session into the live scope tree and restore its main
   * agent from the persisted wire log. Returns the existing handle when the
   * session is already live (a no-op in that case — live agents are never
   * re-restored). Returns `undefined` when the session is unknown to the index
   * or neither the persisted session summary nor the workspace registry can
   * provide a workdir (mirrors the cold-source limitation of `fork`).
   *
   * Lets the read edges (snapshot / messages) serve cold sessions — created by
   * a previous process or by v1 — without requiring a prior `create` in this
   * process. Restores only the main agent; sub-agents are materialized lazily.
   */
  resume(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  close(sessionId: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  restore(sessionId: string): Promise<ISessionScopeHandle | undefined>;
  fork(opts: ForkSessionOptions): Promise<ISessionScopeHandle>;
  /**
   * Fork a session and tag it as a direct child of its source (writes the
   * `parent_session_id` / `child_session_kind` markers into `custom`). The
   * default title is `Child: <source title or id>`. Throws `session.not_found`
   * when the source is unknown (delegates to {@link fork}).
   */
  createChild(opts: CreateChildSessionOptions): Promise<ISessionScopeHandle>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');
