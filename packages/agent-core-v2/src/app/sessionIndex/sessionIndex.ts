import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Page } from '#/persistence/interface/queryStore';

export const PARENT_SESSION_ID_KEY = 'parent_session_id';

export const CHILD_SESSION_KIND_KEY = 'child_session_kind';

export const CHILD_SESSION_KIND = 'child';

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly archivedAt?: number;
  readonly custom?: Record<string, unknown>;
  readonly lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}

export interface SessionListQuery {
  readonly workspaceIds?: readonly string[];
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly childOf?: string;
  readonly before?: string;
  readonly after?: string;
}

export interface SessionCountQuery {
  readonly workspaceIds?: readonly string[];
  readonly includeArchived?: boolean;
}

export type SessionIndexState = 'uninitialized' | 'preparing' | 'ready' | 'degraded';

export interface SessionIndexStatus {
  readonly state: SessionIndexState;
  readonly generation?: number;
  readonly reason?: string;
  readonly degradedCount: number;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  prepare(options?: { deadlineMs?: number }): Promise<SessionIndexStatus>;
  status(): SessionIndexStatus;
  get(id: string): Promise<SessionSummary | undefined>;
  listRecent(query: SessionListQuery): Promise<Page<SessionSummary>>;
  count(query: SessionCountQuery): Promise<number>;
  remove(id: string): Promise<void>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');

export interface ISessionIndexMirror {
  readonly _serviceBrand: undefined;

  record(summary: SessionSummary): void;
  pending(): readonly SessionSummary[];
  evict(id: string): Promise<void>;
  drain(): Promise<void>;
}

export const ISessionIndexMirror: ServiceIdentifier<ISessionIndexMirror> =
  createDecorator<ISessionIndexMirror>('sessionIndexMirror');
