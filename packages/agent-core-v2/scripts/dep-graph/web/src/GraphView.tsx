import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  type Edge as RFEdge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useMemo } from 'react';

import type { Edge, Graph, ServiceNode } from '../../analyzer/types';
import type { FilterState } from './Filters';
import { layoutDagre } from './layout-dagre';
import { EDGE_STYLE, SCOPE_STYLE } from './style';

interface GraphViewProps {
  graph: Graph;
  filters: FilterState;
  /** Selected `ServiceNode.id`. */
  selectedId?: string;
  onSelect: (id?: string) => void;
}

interface ServiceNodeData extends Record<string, unknown> {
  service: ServiceNode;
  selected: boolean;
  dim: boolean;
}

function ServiceNodeView({ data }: NodeProps<Node<ServiceNodeData>>): JSX.Element {
  const { service, selected, dim } = data;
  const bg = SCOPE_STYLE[service.scope].color;
  return (
    <div
      style={{
        background: bg,
        color: 'white',
        padding: '6px 10px',
        borderRadius: 6,
        border: selected ? '2px solid #ffdf5d' : '1px solid rgba(0,0,0,0.4)',
        boxShadow: selected ? '0 0 0 3px rgba(255,223,93,0.25)' : 'none',
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        opacity: dim ? 0.18 : 1,
        minWidth: 200,
        maxWidth: 240,
      }}
    >
      <Handle type="target" position={Position.Right} style={{ background: '#555' }} />
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span
          style={{
            fontSize: 9,
            padding: '1px 5px',
            background: 'rgba(0,0,0,0.35)',
            borderRadius: 3,
          }}
        >
          {SCOPE_STYLE[service.scope].badge}
        </span>
        {/* Impl is the primary label — that's the actual class the container
            constructs; the token is a secondary identity shown below. */}
        <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {service.impl}
        </span>
      </div>
      <div style={{ fontSize: 10, opacity: 0.65, marginTop: 2, fontStyle: 'italic' }}>
        {service.token}
      </div>
      <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{service.domain}</div>
      <Handle type="source" position={Position.Left} style={{ background: '#555' }} />
    </div>
  );
}

function BandLabelView({ data }: NodeProps<Node<{ scope: string; width: number }>>): JSX.Element {
  const { scope, width } = data;
  return (
    <div
      style={{
        width,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#a5b0bc',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        borderBottom: '1px dashed #30363d',
        pointerEvents: 'none',
        fontFamily: 'ui-monospace, monospace',
      }}
    >
      {scope}
    </div>
  );
}

const nodeTypes = { service: ServiceNodeView, band: BandLabelView };

function passesFilter(
  service: ServiceNode,
  filters: FilterState,
  connected: Set<string>,
): boolean {
  if (!filters.scopes.has(service.scope)) return false;
  if (filters.hiddenDomains.has(service.domain)) return false;
  if (filters.search) {
    const q = filters.search.toLowerCase();
    const hay = `${service.token} ${service.impl} ${service.domain}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filters.hideOrphans && !connected.has(service.id)) return false;
  return true;
}

export function GraphView({
  graph,
  filters,
  selectedId,
  onSelect,
}: GraphViewProps): JSX.Element {
  const { nodes, edges, selectedService, selectedEdges } = useMemo(() => {
    // Which edges survive the edge-kind filter?
    const survivingEdges: Edge[] = graph.edges
      .filter((e) => filters.kinds.has(e.kind))
      // Drop unresolved edges — their `to` points at a pseudo id that isn't
      // in the node set. The lint reports them separately; showing them
      // here would just clutter the graph with dangling arrows.
      .filter((e) => !e.unresolved);

    // Node ids that appear on either end of any surviving edge — for the
    // orphan filter.
    const connected = new Set<string>();
    for (const e of survivingEdges) {
      connected.add(e.from);
      connected.add(e.to);
    }

    const visibleServices = graph.services.filter((s) =>
      passesFilter(s, filters, connected),
    );
    const visibleIds = new Set(visibleServices.map((s) => s.id));

    // Also drop edges whose endpoint is not in the visible set.
    const finalEdges = survivingEdges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );

    // Neighbours of the selected node — used to dim non-related ones.
    const highlighted = new Set<string>();
    if (selectedId) {
      highlighted.add(selectedId);
      for (const e of finalEdges) {
        if (e.from === selectedId) highlighted.add(e.to);
        if (e.to === selectedId) highlighted.add(e.from);
      }
    }

    const layout = layoutDagre(visibleServices, finalEdges, {
      groupByScope: filters.groupByScope,
    });
    const pos = layout.positions;

    const rfNodes: Node[] = visibleServices.map(
      (service): Node<ServiceNodeData> => ({
        id: service.id,
        type: 'service',
        position: pos.get(service.id) ?? { x: 0, y: 0 },
        data: {
          service,
          selected: service.id === selectedId,
          dim: selectedId !== undefined && !highlighted.has(service.id),
        },
      }),
    );

    // If grouped, add one non-interactive label node above each band so the
    // three columns are self-labeling.
    if (layout.bands) {
      const ys = [...pos.values()].map((p) => p.y);
      const minY = ys.length > 0 ? Math.min(...ys) : 0;
      for (const band of layout.bands) {
        rfNodes.push({
          id: `band::${band.scope}`,
          type: 'band',
          position: { x: band.x, y: minY - 40 },
          data: { scope: band.scope, width: Math.max(band.width, 120) },
          draggable: false,
          selectable: false,
          focusable: false,
        });
      }
    }

    const rfEdges: RFEdge[] = finalEdges.map((e) => {
      const style = EDGE_STYLE[e.kind];
      const isHighlighted =
        selectedId !== undefined && (e.from === selectedId || e.to === selectedId);
      return {
        id: `${e.from}::${e.kind}::${e.to}`,
        source: e.from,
        target: e.to,
        label: undefined,
        style: {
          stroke: style.color,
          strokeWidth: isHighlighted ? 2.2 : 1.2,
          strokeDasharray: style.dashed ? '4 3' : undefined,
          opacity: selectedId !== undefined ? (isHighlighted ? 1 : 0.1) : 0.75,
        },
        animated: false,
      };
    });

    const selectedService = selectedId
      ? graph.services.find((s) => s.id === selectedId)
      : undefined;
    const selectedEdges = selectedId
      ? finalEdges.filter((e) => e.from === selectedId || e.to === selectedId)
      : [];

    return { nodes: rfNodes, edges: rfEdges, selectedService, selectedEdges };
  }, [graph, filters, selectedId]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.1}
        maxZoom={1.6}
        onNodeClick={(_, node) => {
          if (node.id.startsWith('band::')) return;
          onSelect(node.id);
        }}
        onPaneClick={() => onSelect(undefined)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} color="#30363d" />
        <MiniMap
          pannable
          zoomable
          style={{ background: '#151b23' }}
          nodeColor={(n) => {
            if (n.id.startsWith('band::')) return 'transparent';
            const service = (n.data as ServiceNodeData | undefined)?.service;
            return service ? SCOPE_STYLE[service.scope].color : '#7d8590';
          }}
        />
        <Controls showInteractive={false} style={{ background: '#151b23' }} />
      </ReactFlow>
      {selectedService && (
        <ServicePanel
          service={selectedService}
          graph={graph}
          edges={selectedEdges}
          onClose={() => onSelect(undefined)}
        />
      )}
    </>
  );
}

interface ServicePanelProps {
  service: ServiceNode;
  graph: Graph;
  edges: Edge[];
  onClose: () => void;
}

function ServicePanel({ service, graph, edges, onClose }: ServicePanelProps): JSX.Element {
  const outgoing = edges.filter((e) => e.from === service.id);
  const incoming = edges.filter((e) => e.to === service.id && e.from !== service.id);
  const byId = new Map(graph.services.map((s) => [s.id, s]));
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 360,
        maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto',
        background: 'rgba(21,27,35,0.96)',
        border: '1px solid #30363d',
        borderRadius: 8,
        padding: 14,
        fontSize: 12,
        boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{service.impl}</div>
          <div style={{ color: '#a5b0bc', fontSize: 11 }}>{service.token}</div>
          <div style={{ color: '#7d8590', fontSize: 11 }}>
            <b>{service.scope}</b> · {service.domain}
          </div>
          <div style={{ color: '#7d8590', fontSize: 10, marginTop: 4, wordBreak: 'break-all' }}>
            {service.file}:{service.line}
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#7d8590',
            cursor: 'pointer',
            fontSize: 16,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      <EdgeList
        title={`out (${outgoing.length})`}
        edges={outgoing}
        direction="out"
        byId={byId}
      />
      <EdgeList
        title={`in (${incoming.length})`}
        edges={incoming}
        direction="in"
        byId={byId}
      />
    </div>
  );
}

interface EdgeListProps {
  title: string;
  edges: Edge[];
  direction: 'in' | 'out';
  byId: Map<string, ServiceNode>;
}

function EdgeList({ title, edges, direction, byId }: EdgeListProps): JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 600,
          textTransform: 'uppercase',
          color: '#7d8590',
          marginBottom: 4,
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {edges.length === 0 && <div style={{ color: '#7d8590', fontSize: 11 }}>—</div>}
      {edges.map((e) => {
        const peerId = direction === 'out' ? e.to : e.from;
        const peer = byId.get(peerId);
        const label = peer ? `${peer.impl} (${peer.token})` : peerId;
        return (
          <div
            key={`${e.from}::${e.kind}::${e.to}`}
            style={{ padding: '3px 0', display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 10,
                height: 3,
                borderTop: `${EDGE_STYLE[e.kind].dashed ? '2px dashed' : '2px solid'} ${
                  EDGE_STYLE[e.kind].color
                }`,
              }}
            />
            <span style={{ color: '#7d8590', fontSize: 10, minWidth: 62 }}>{e.kind}</span>
            <span
              style={{
                fontFamily: 'ui-monospace, monospace',
                fontSize: 11,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                flex: 1,
              }}
            >
              {label}
            </span>
            <span style={{ color: '#7d8590', fontSize: 10 }}>×{e.refs.length}</span>
          </div>
        );
      })}
    </div>
  );
}
