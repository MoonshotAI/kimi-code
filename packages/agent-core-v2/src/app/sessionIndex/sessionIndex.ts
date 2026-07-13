/**
 * `sessionIndex` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: a backend-neutral
 * query facade over the set of persisted sessions (open or closed). It
 * enumerates sessions and derives session identity (`workspaceId`), returning
 * data (`SessionSummary`) or counts — never filesystem paths or live handles.
 * Writes (create / archive) live in `sessionLifecycle` / `session`; the index
 * is a read model. Backends are deployment-specific (local filesystem today;
 * database / query store on a server).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Page } from '#/persistence/interface/queryStore';

/**
 * v1 `custom` metadata key linking a forked session back to its parent
 * (`packages/agent-core/.../sessionService.ts`). Written by
 * `ISessionLifecycleService.createChild`; read here to answer child queries.
 */
export const PARENT_SESSION_ID_KEY = 'parent_session_id';

/**
 * v1 `custom` metadata key tagging a fork as a direct "child" (as opposed to a
 * plain fork). Only sessions carrying both {@link PARENT_SESSION_ID_KEY} and
 * `child_session_kind === CHILD_SESSION_KIND` count as children.
 */
export const CHILD_SESSION_KIND_KEY = 'child_session_kind';

/** The `child_session_kind` value that marks a direct child session. */
export const CHILD_SESSION_KIND = 'child';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  /**
   * Absolute working directory frozen at session creation (wire
   * `metadata.cwd`). Sourced from the session's own metadata document so it is
   * independent of the workspace registry — sessions whose workspace was
   * unregistered still surface their original cwd (closes gap G3; matches v1's
   * `summary.workDir`). Optional only for sessions written before `cwd` was
   * persisted; the edge falls back to the workspace registry for those.
   */
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  /**
   * Free-form custom metadata read from the session's `state.json` (wire
   * `Session.metadata` minus reserved keys such as `goal`). Surfaced so the v1
   * edge can project it into `Session.metadata` and filter child sessions by
   * the `parent_session_id` / `child_session_kind` markers without a per-session
   * document read.
   */
  readonly custom?: Record<string, unknown>;
}

export interface SessionListQuery {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  /**
   * Restrict to direct child sessions of this parent id: summaries whose
   * `custom` carries both `parent_session_id === childOf` and
   * `child_session_kind === 'child'` (the v1 child markers). A plain fork
   * (no `child_session_kind`) is excluded.
   */
  readonly childOf?: string;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  /** List persisted sessions, optionally filtered by workspace. */
  list(query: SessionListQuery): Promise<Page<SessionSummary>>;
  /** Fetch a single persisted session by id. */
  get(id: string): Promise<SessionSummary | undefined>;
  /** Count non-archived sessions for a workspace id. */
  countActive(workspaceId: string): Promise<number>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');
