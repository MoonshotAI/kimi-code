import type { SessionSummary } from '@moonshot-ai/agent-core-v2';

export type SessionSort = 'meta.updated_at_desc' | 'meta.updated_at_asc' | 'meta.created_at_desc';
export interface SessionPosition { key: number; id: string }

export function sessionKey(sort: SessionSort, summary: Pick<SessionSummary, 'createdAt' | 'updatedAt'>): number {
  return sort === 'meta.created_at_desc' ? summary.createdAt : summary.updatedAt;
}

export function compareSessionGroups(sort: SessionSort, a: SessionPosition, b: SessionPosition): number {
  return a.key === b.key ? a.id.localeCompare(b.id) : sort === 'meta.updated_at_asc' ? a.key - b.key : b.key - a.key;
}

export function compareSessionPositions(sort: SessionSort, a: SessionPosition, b: SessionPosition): number {
  return sort === 'meta.updated_at_asc'
    ? compareSessionGroups(sort, a, b)
    : compareSessionGroups(sort, a, { key: b.key, id: a.id }) || compareSessionGroups(sort, b, { key: a.key, id: b.id });
}

export function sessionPositionOf(groups: boolean, sort: SessionSort, entry: Record<string, unknown>): SessionPosition {
  const session = groups ? (entry['sessions'] as Record<string, unknown>[])[0]! : entry;
  const meta = session['meta'] as Record<string, number>;
  const id = groups ? (entry['workspace'] as { id: string }).id : (entry['id'] as string);
  return { key: meta[sort === 'meta.created_at_desc' ? 'created_at' : 'updated_at']!, id };
}
