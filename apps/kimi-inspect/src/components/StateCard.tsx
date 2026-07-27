/**
 * State card — one scope's registered state as a live diff tree, shared by
 * the session `State` tab (`SessionPane`) and the agent `State` tab
 * (`RightPanel`). Same view as the audit panel's "Diff vs prev" (`StateTree`
 * over a `DiffNode` root), so every key is an interactive, collapsible row.
 * Auto-loads on mount and polls once a second: the first snapshot (and any
 * owner switch) renders as a plain tree, each later snapshot folds in as a
 * structural diff against the previous one (added = green, removed = red,
 * modified = amber). Changed subtrees auto-open; rows the user expanded stay
 * expanded across polls.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { diffValue, type DiffNode } from '../audit/diff';
import { ActionButton, Badge, ErrorLine } from '../ui';
import { StateTree, plainNode } from './audit/StateTree';

export function StateCard({
  id,
  queryKey,
  title,
  label,
  badge,
  fetchSnapshot,
}: {
  /** Identity of the state owner (`sessionId`, or `sessionId/agentId`); a
   * change resets the diff baseline so a fresh owner renders as a plain tree
   * instead of an all-green diff against the previous owner. */
  id: string;
  queryKey: readonly unknown[];
  /** Card title, e.g. `Session state` / `Agent state`. */
  title: string;
  /** Mono caption next to the title: the state service's channel name. */
  label: string;
  badge?: ReactNode;
  fetchSnapshot: () => Promise<Record<string, unknown>>;
}) {
  const query = useQuery({
    queryKey,
    queryFn: async () => ({ id, snapshot: await fetchSnapshot() }),
    refetchInterval: 1000,
    placeholderData: (previous) => previous,
  });

  // Fold each poll into a diff against the previous snapshot. `plainNode`
  // on first load / owner switch — diffing a freshly loaded tree against
  // nothing (or against the previous owner) would paint it all-green. While
  // the new owner's fetch is in flight the query still carries the previous
  // owner's placeholder data (`data.id !== id`); ignore it so a stale tree
  // never renders under the new owner's badge.
  const [tree, setTree] = useState<{ id: string; node: DiffNode } | null>(null);
  useEffect(() => {
    const data = query.data;
    if (data === undefined || data.id !== id) return;
    setTree((prev) =>
      prev === null || prev.id !== data.id
        ? { id: data.id, node: plainNode(data.snapshot) }
        : { id: data.id, node: diffValue(prev.node.value, data.snapshot) },
    );
  }, [query.data, id]);

  // The tree is only shown when it belongs to the current owner — after an
  // owner switch the old tree is suppressed until the new snapshot arrives.
  const visibleTree = tree !== null && tree.id === id ? tree : null;

  // One-click expand/collapse: bumping `nonce` remounts the tree, and the
  // fresh `defaultDepth` decides how deep nodes open (Infinity = expand all,
  // 0 = collapse all — diff-changed subtrees still auto-open, as in the
  // audit panel). Polls afterwards keep the local open state untouched.
  const [expand, setExpand] = useState({ nonce: 0, depth: 1 });

  return (
    <div className="mb-3 rounded-lg border border-neutral-800 bg-neutral-900/60">
      <div className="flex items-center justify-between border-b border-neutral-800/60 px-3 py-2">
        <div>
          <span className="text-[12px] font-medium text-neutral-200">{title}</span>
          <span className="ml-2 font-mono text-[10px] text-neutral-600">{label}</span>
          {badge}
          {visibleTree !== null ? (
            <Badge tone="neutral">
              {Object.keys(visibleTree.node.value as Record<string, unknown>).length} keys
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <ActionButton
            onClick={() =>
              setExpand((s) => ({ nonce: s.nonce + 1, depth: Number.POSITIVE_INFINITY }))
            }
          >
            Expand
          </ActionButton>
          <ActionButton onClick={() => setExpand((s) => ({ nonce: s.nonce + 1, depth: 0 }))}>
            Collapse
          </ActionButton>
          <span className="text-[10px] text-neutral-600">live · 1s</span>
        </div>
      </div>
      <div className="px-3 py-2">
        {query.isError ? (
          <div className="mb-2">
            <ErrorLine error={query.error} />
          </div>
        ) : null}
        {visibleTree === null ? (
          <div className="text-[11px] text-neutral-600 italic">
            {query.isPending || tree !== null ? 'Loading state…' : 'no state registered'}
          </div>
        ) : (
          <StateTree key={expand.nonce} root={visibleTree.node} defaultDepth={expand.depth} />
        )}
      </div>
    </div>
  );
}
