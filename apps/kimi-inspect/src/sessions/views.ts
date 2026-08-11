/**
 * Preset table views for the session panel. Each view is a named combination
 * of the `/api/v2/sessions` query conditions (status filter / archived mode /
 * git opt-in) plus a client-side presentation tweak (workspace grouping).
 * Views are fixed in code — there is no user-defined view editor.
 */

import type { V2ActivityStatus } from './api';

export interface SessionView {
  readonly id: string;
  readonly label: string;
  /** Maps to repeated `activity.status` params; omitted = no status filter. */
  readonly statuses?: readonly V2ActivityStatus[];
  /** Maps to `meta.archived`; default server-side is 'false'. */
  readonly archived?: 'true' | 'false' | 'all';
  /** Adds `include=git` (branch / pull_request columns). */
  readonly includeGit?: boolean;
  /** Group the loaded rows under per-workspace headers client-side. */
  readonly groupByWorkspace?: boolean;
}

export const SESSION_VIEWS: readonly SessionView[] = [
  { id: 'all', label: 'All' },
  // "Opened" = every live (materialized) session: the four non-idle statuses.
  // Cold sessions only ever report `idle`, so this filter is exactly the set
  // of sessions currently alive on the server.
  {
    id: 'opened',
    label: 'Opened',
    statuses: ['running', 'approval', 'question', 'failed'],
  },
  { id: 'archived', label: 'Archived', archived: 'true' },
  { id: 'workspace', label: 'By workspace', groupByWorkspace: true },
  { id: 'git', label: 'Git', includeGit: true },
];

export function sessionViewById(id: string | undefined): SessionView {
  return SESSION_VIEWS.find((view) => view.id === id) ?? SESSION_VIEWS[0]!;
}
