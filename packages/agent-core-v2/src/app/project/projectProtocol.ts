export interface Project {
  id: string;
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
  session_count: number;
}

export interface ProjectCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Project;
}

export interface ProjectUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Project;
}

export interface ProjectDeletedEvent {
  readonly type: 'event.workspace.deleted';
  readonly workspace_id: string;
  readonly root: string;
}
