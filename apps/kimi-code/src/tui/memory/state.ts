/**
 * UI state for the `/memory` browser. Kept separate from the
 * `MemoryBrowserApp` component so the controller can own the source of
 * truth and the component stays a pure renderer + input router.
 */

import type { MemoryFactSummary, MemoryScope } from '@moonshot-ai/kimi-code-sdk';

export type MemoryScopeFilter = 'all' | 'user' | 'project';

export interface MemoryFactView {
  readonly scope: MemoryScope;
  readonly slug: string;
  readonly type: 'user' | 'feedback' | 'project' | 'reference';
  readonly description: string;
  readonly body: string;
  readonly shadowed: boolean;
  readonly path: string;
}

export interface MemoryBrowserState {
  /** Facts merged across scopes, project-then-user order. */
  readonly facts: readonly MemoryFactView[];
  readonly scopeFilter: MemoryScopeFilter;
  readonly selectedScope: MemoryScope | undefined;
  readonly selectedSlug: string | undefined;
  readonly detailOpen: boolean;
  readonly confirmingDelete: boolean;
  readonly flashMessage: string | undefined;
}

export function factsFromSummaries(
  summaries: readonly MemoryFactSummary[],
): readonly MemoryFactView[] {
  return summaries.map((summary) => ({
    scope: summary.scope,
    slug: summary.slug,
    type: summary.type,
    description: summary.description,
    body: summary.body,
    shadowed: summary.shadowed,
    path: summary.path,
  }));
}

export function nextScopeFilter(filter: MemoryScopeFilter): MemoryScopeFilter {
  switch (filter) {
    case 'all':
      return 'project';
    case 'project':
      return 'user';
    case 'user':
      return 'all';
  }
}

export function visibleFacts(
  facts: readonly MemoryFactView[],
  filter: MemoryScopeFilter,
): readonly MemoryFactView[] {
  if (filter === 'all') return facts;
  return facts.filter((fact) => fact.scope === filter);
}

export function pickInitialSelection(
  facts: readonly MemoryFactView[],
): { scope: MemoryScope; slug: string } | undefined {
  const first = facts[0];
  if (first === undefined) return undefined;
  return { scope: first.scope, slug: first.slug };
}

export function findIndex(
  facts: readonly MemoryFactView[],
  scope: MemoryScope | undefined,
  slug: string | undefined,
): number {
  if (scope === undefined || slug === undefined) return -1;
  return facts.findIndex((fact) => fact.scope === scope && fact.slug === slug);
}
