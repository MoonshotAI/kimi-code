import type { V2ActivityStatus } from './api';

export interface SessionView {
  readonly id: string;
  readonly label: string;
  readonly statuses?: readonly V2ActivityStatus[];
  readonly archived?: 'true' | 'false' | 'all';
  readonly includeGit?: boolean;
}

export const SESSION_VIEWS: readonly SessionView[] = [
  { id: 'all', label: 'All' },
  {
    id: 'opened',
    label: 'Opened',
    statuses: ['running', 'approval', 'question', 'failed'],
  },
  { id: 'archived', label: 'Archived', archived: 'true' },
  { id: 'git', label: 'Git', includeGit: true },
];

export function sessionViewById(id: string | undefined): SessionView {
  return SESSION_VIEWS.find((view) => view.id === id) ?? SESSION_VIEWS[0]!;
}
