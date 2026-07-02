import { useCallback, useEffect, useMemo, useState } from 'react';
import graph from 'virtual:dep-graph';

import type { EdgeKind, ServiceScope } from '../../analyzer/types';
import { Filters, type FilterState } from './Filters';
import { GraphView } from './GraphView';
import { EDGE_KINDS } from './style';
import { collectTagCounts, loadTags, saveTags, tagsEqual, type TagMap } from './tags';

const ALL_SCOPES: ServiceScope[] = ['App', 'Session', 'Agent'];

export function App(): JSX.Element {
  const domains = useMemo(
    () => [...new Set(graph.services.map((s) => s.domain))].sort(),
    [],
  );

  const [filters, setFilters] = useState<FilterState>({
    scopes: new Set<ServiceScope>(ALL_SCOPES),
    kinds: new Set<EdgeKind>(EDGE_KINDS),
    hiddenDomains: new Set<string>(),
    search: '',
    hideOrphans: false,
    groupByScope: false,
    activeTags: new Set<string>(),
  });

  const [selectedId, setSelectedId] = useState<string | undefined>();

  // User-authored node tags, keyed by `ServiceNode.id`. Loaded once from
  // localStorage and re-persisted on every change.
  const [tags, setTags] = useState<TagMap>(() => loadTags());
  useEffect(() => {
    saveTags(tags);
  }, [tags]);

  const tagCounts = useMemo(() => collectTagCounts(tags), [tags]);

  const handleEditTags = useCallback((nodeId: string, next: string[]) => {
    setTags((prev) => {
      if (tagsEqual(prev, nodeId, next)) return prev;
      const updated = { ...prev };
      if (next.length === 0) delete updated[nodeId];
      else updated[nodeId] = next;
      return updated;
    });
  }, []);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Filters
        graph={graph}
        domains={domains}
        tagCounts={tagCounts}
        state={filters}
        onChange={setFilters}
      />
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <GraphView
          graph={graph}
          filters={filters}
          selectedId={selectedId}
          onSelect={setSelectedId}
          tags={tags}
          onEditTags={handleEditTags}
        />
      </div>
    </div>
  );
}
