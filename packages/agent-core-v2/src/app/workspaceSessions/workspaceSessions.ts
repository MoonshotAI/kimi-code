import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';
import type { Page } from '#/persistence/interface/queryStore';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface WorkdirSessionQuery {
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
}

export interface IWorkspaceSessions {
  readonly _serviceBrand: undefined;

  listRecent(workspaceId: string): Promise<readonly SessionSummary[]>;
  count(workspaceId: string): Promise<number>;
  listForWorkdir(dir: string, query?: WorkdirSessionQuery): Promise<Page<SessionSummary>>;
}

export const IWorkspaceSessions: ServiceIdentifier<IWorkspaceSessions> =
  createDecorator<IWorkspaceSessions>('workspaceSessions');
