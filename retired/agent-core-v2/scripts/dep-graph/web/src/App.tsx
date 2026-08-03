import { useCallback, useEffect, useMemo, useState } from 'react';
import graph from 'virtual:dep-graph';

import type { EdgeKind, ServiceScope } from '../../analyzer/types';
import { Filters, type FilterState } from './Filters';
import { GraphView } from './GraphView';
import { readQueryParams } from './query-params';
import { EDGE_KINDS } from './style';
import { collectTagCounts, loadTags, saveTags, tagsEqual, type TagMap } from './tags';

const ALL_SCOPES: ServiceScope[] = ['App', 'Session', 'Agent'];

export function App(): JSX.Element {
  const queryParams = useMemo(() => readQueryParams(window.location.search), []);

  const domains = useMemo(
    () => [...new Set(graph.services.map((s) => s.domain))].sort((a, b) => a.localeCompare(b)),
    [],
  );

  const [filters, setFilters] = useState<FilterState>(() => {
    const visibleDomains = queryParams.domains ? new Set(queryParams.domains) : undefined;
    return {
      scopes: queryParams.scopes
        ? new Set<ServiceScope>(queryParams.scopes)
        : new Set<ServiceScope>(ALL_SCOPES),
      kinds: queryParams.kinds
        ? new Set<EdgeKind>(queryParams.kinds)
        : new Set<EdgeKind>(EDGE_KINDS),
      hiddenDomains: visibleDomains
        ? new Set<string>(domains.filter((d) => !visibleDomains.has(d)))
        : new Set<string>(),
      search: queryParams.search ?? '',
      hideOrphans: queryParams.hideOrphans ?? false,
      groupByScope: queryParams.groupByScope ?? false,
      activeTags: new Set<string>(),
    };
  });

  const [selectedId, setSelectedId] = useState<string | undefined>(() =>
    queryParams.focus && graph.services.some((s) => s.id === queryParams.focus)
      ? queryParams.focus
      : undefined,
  );

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
