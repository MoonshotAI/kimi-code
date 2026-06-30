/**
 * `session-index` domain (L2) — session index contract.
 *
 * `ISessionIndex` is a domain-specific persistence Store: a backend-neutral
 * query facade over the set of persisted sessions (open or closed). It
 * enumerates sessions and derives session identity (`workspaceId`), returning
 * data (`SessionSummary`) or counts — never filesystem paths or live handles.
 * Writes (create / archive) live in `session-lifecycle` / `session`; the index
 * is a read model. Backends are deployment-specific (local filesystem today;
 * database / query store on a server).
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Page } from '#/storage';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
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
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
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
