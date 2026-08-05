/**
 * `sessionIndex` domain (L2) — read-model layout shared by the index, the
 * mirror, and the projector.
 *
 * The derived read model is versioned by *generation*: every projection
 * writes a fresh `session:g<N>` collection (summaries, keyed by session id,
 * with the generation's recency column declared) plus a
 * `sessionCounters:g<N>` collection (per-workspace materialized
 * active/archived counts), then publishes `N` with one atomic checkpoint
 * write. Readers only ever read the published generation, so a projection
 * that dies midway leaves the previous generation fully intact; orphaned
 * halves of crashed generations are dropped before reuse and the previous
 * generation is dropped after a successful publish. The collections are
 * plain `IQueryStore` collections — no backend-specific type escapes into
 * the domain.
 */

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
