/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { Workspace } from './workspace';

export interface WorkspaceCreatedPayload {
  readonly workspace: Workspace;
}

export class WorkspaceCreated extends Event2<{ readonly payload: WorkspaceCreatedPayload }> {
  static override readonly type = 'event.workspace.created';
}
export interface WorkspaceCreated {
  readonly payload: WorkspaceCreatedPayload;
}

export interface WorkspaceUpdatedPayload {
  readonly workspace: Workspace;
}

export class WorkspaceUpdated extends Event2<{ readonly payload: WorkspaceUpdatedPayload }> {
  static override readonly type = 'event.workspace.updated';
}
export interface WorkspaceUpdated {
  readonly payload: WorkspaceUpdatedPayload;
}

export interface WorkspaceDeletedPayload {
  readonly workspaceId: string;
  readonly root: string;
}

export class WorkspaceDeleted extends Event2<{ readonly payload: WorkspaceDeletedPayload }> {
  static override readonly type = 'event.workspace.deleted';
}
export interface WorkspaceDeleted {
  readonly payload: WorkspaceDeletedPayload;
}
