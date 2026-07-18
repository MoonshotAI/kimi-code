/**
 * Colors + labels for edge kinds. Central so the legend and the React Flow
 * edges stay in sync.
 */
import type { EdgeKind, ServiceScope } from '../../analyzer/types';

export const EDGE_STYLE: Record<
  EdgeKind,
  { color: string; label: string; dashed: boolean }
> = {
  ctor: { color: '#7d8590', label: 'ctor', dashed: false },
  accessor: { color: '#d29922', label: 'accessor', dashed: false },
  publish: { color: '#39c5cf', label: 'publish', dashed: true },
  subscribe: { color: '#79c0ff', label: 'subscribe', dashed: true },
  emit: { color: '#f778ba', label: 'emit', dashed: true },
  on: { color: '#c297f5', label: 'on', dashed: true },
};

export const SCOPE_STYLE: Record<ServiceScope, { color: string; badge: string }> = {
  App: { color: '#2f5fa8', badge: 'App' },
  Session: { color: '#7f4bb5', badge: 'Ses' },
  Agent: { color: '#2f8a4d', badge: 'Agt' },
};

export const SCOPE_MISMATCH_COLOR = '#f0883e';
export const UNRESOLVED_COLOR = '#f85149';

export const EDGE_KINDS: EdgeKind[] = ['ctor', 'accessor', 'publish', 'subscribe', 'emit', 'on'];
