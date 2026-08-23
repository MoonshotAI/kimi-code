import type { SessionSummary } from './sessionIndex';

export const SESSION_INDEX_MANIFEST = 'sessionIndex';

export const PARENT_INDEX_NAME = 'byParent';

export interface SessionWorkspaceCounts {
  readonly active: number;
  readonly archived: number;
}

export function sessionCollection(generation: number): string {
  return `session:g${generation}`;
}

export function sessionCountersCollection(generation: number): string {
  return `sessionCounters:g${generation}`;
}

/**
 * The ordered recency column for a generation. Column names are store-wide,
 * so the column is namespaced per generation: two coexisting generations
 * (one published, one being projected) then walk disjoint ordered
 * structures and can never interleave into each other's pages. The stored
 * record carries the same-named field — the engine orders by the column and
 * its cross-shard merge compares by the value field of that name — and the
 * index strips it again on every read.
 */
export function recencyColumn(generation: number): string {
  return `g${generation}:updatedAt`;
}

/** Attach the generation's recency field to a summary for storage. */
export function withRecencyField(generation: number, summary: SessionSummary): SessionSummary {
  return { ...summary, [recencyColumn(generation)]: summary.updatedAt };
}

/** Remove the generation's recency field from a stored record. */
export function stripRecencyField(generation: number, record: SessionSummary): SessionSummary {
  const key = recencyColumn(generation);
  if (!(key in record)) return record;
  const rest: Record<string, unknown> = { ...record };
  delete rest[key];
  return rest as unknown as SessionSummary;
}
