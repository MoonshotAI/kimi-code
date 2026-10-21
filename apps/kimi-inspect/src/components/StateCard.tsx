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
  id: string;
  queryKey: readonly unknown[];
  title: string;
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

  const visibleTree = tree !== null && tree.id === id ? tree : null;

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
