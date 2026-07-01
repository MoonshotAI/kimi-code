import { useMemo, useState } from 'react';
import graph from 'virtual:dep-graph';

import type { EdgeKind, ServiceScope } from '../../analyzer/types';
import { Filters, type FilterState } from './Filters';
import { GraphView } from './GraphView';
import { EDGE_KINDS } from './style';

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
  });

  const [selectedId, setSelectedId] = useState<string | undefined>();

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
      <Filters
        graph={graph}
        domains={domains}
        state={filters}
        onChange={setFilters}
      />
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <GraphView
          graph={graph}
          filters={filters}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>
    </div>
  );
}
