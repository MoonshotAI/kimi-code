/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Event2 } from '#/app/event/event2';

import type { Project } from './project';

export interface ProjectCreatedPayload {
  readonly workspace: Project;
}

export class ProjectCreated extends Event2<{ readonly payload: ProjectCreatedPayload }> {
  static override readonly type = 'event.workspace.created';
}
export interface ProjectCreated {
  readonly payload: ProjectCreatedPayload;
}

export interface ProjectUpdatedPayload {
  readonly workspace: Project;
}

export class ProjectUpdated extends Event2<{ readonly payload: ProjectUpdatedPayload }> {
  static override readonly type = 'event.workspace.updated';
}
export interface ProjectUpdated {
  readonly payload: ProjectUpdatedPayload;
}

export interface ProjectDeletedPayload {
  readonly workspaceId: string;
  readonly root: string;
  readonly workspace?: Project;
}

export class ProjectDeleted extends Event2<{ readonly payload: ProjectDeletedPayload }> {
  static override readonly type = 'event.workspace.deleted';
}
export interface ProjectDeleted {
  readonly payload: ProjectDeletedPayload;
}
