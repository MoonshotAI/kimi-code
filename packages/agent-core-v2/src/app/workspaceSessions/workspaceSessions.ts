import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface IWorkspaceSessions {
  readonly _serviceBrand: undefined;

  listRecent(workspaceId: string): Promise<readonly SessionSummary[]>;
  count(workspaceId: string): Promise<number>;
}

export const IWorkspaceSessions: ServiceIdentifier<IWorkspaceSessions> =
  createDecorator<IWorkspaceSessions>('workspaceSessions');
