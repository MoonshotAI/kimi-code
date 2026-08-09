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
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Fragment, useMemo, useState } from 'react';

import type { Edge, EdgeKind, EdgeRef, Graph, ServiceNode } from '../../analyzer/types';
import type { FilterState } from './Filters';
import { layoutDagre } from './layout-dagre';
import {
  EDGE_STYLE,
  SCOPE_MISMATCH_COLOR,
  SCOPE_STYLE,
  UNRESOLVED_COLOR,
} from './style';
import { tagColor, type TagMap } from './tags';

const NODE_WIDTH = 300;
const HEADER_HEIGHT = 68;
const PORT_ROW_HEIGHT = 18;
const PORTS_PAD_TOP = 4;
const TAGS_ROW_HEIGHT = 20;

interface ServicePortsInfo {
  inPorts: string[];
  outPorts: string[];
  connectedIn: Set<string>;
}

interface GraphViewProps {
  graph: Graph;
  filters: FilterState;
  selectedId?: string;
  onSelect: (id?: string) => void;
  tags: TagMap;
  onEditTags: (nodeId: string, tags: string[]) => void;
}

interface ServiceNodeData extends Record<string, unknown> {
  service: ServiceNode;
  selected: boolean;
  matched: boolean;
  dim: boolean;
  ports: ServicePortsInfo;
  tags: string[];
}

const EVENT_KINDS: Set<EdgeKind> = new Set(['publish', 'subscribe', 'emit', 'on']);

function effectiveToMethod(kind: EdgeKind, refTo: string | undefined): string | undefined {
  if (refTo !== undefined) return refTo;
  if (EVENT_KINDS.has(kind)) return kind;
  return undefined;
}

function computeServicePorts(
  services: ServiceNode[],
  edges: Edge[],
): Map<string, ServicePortsInfo> {
  const acc = new Map<
    string,
    { in: Set<string>; out: Set<string>; connectedIn: Set<string> }
  >();
  for (const s of services) {
    const bucket = {
      in: new Set<string>(),
      out: new Set<string>(),
      connectedIn: new Set<string>(),
    };
    if (s.publicMembers) {
      for (const name of s.publicMembers) bucket.in.add(name);
    }
    acc.set(s.id, bucket);
  }
  for (const e of edges) {
    const src = acc.get(e.from);
    const dst = acc.get(e.to);
    for (const ref of e.refs) {
      const toMethod = effectiveToMethod(e.kind, ref.toMethod);
      if (ref.fromMethod !== undefined && src) src.out.add(ref.fromMethod);
      if (toMethod !== undefined && dst) {
        dst.in.add(toMethod);
        dst.connectedIn.add(toMethod);
      }
    }
  }
  const result = new Map<string, ServicePortsInfo>();
  for (const [id, sets] of acc) {
    result.set(id, {
      inPorts: [...sets.in].sort(),
      outPorts: [...sets.out].sort(),
      connectedIn: sets.connectedIn,
    });
  }
  return result;
}

function nodeHeight(ports: ServicePortsInfo, hasTags: boolean): number {
  const rows = Math.max(ports.inPorts.length, ports.outPorts.length);
  const base = rows === 0 ? HEADER_HEIGHT : HEADER_HEIGHT + PORTS_PAD_TOP + rows * PORT_ROW_HEIGHT + PORTS_PAD_TOP;
  return hasTags ? base + TAGS_ROW_HEIGHT : base;
}

function ServiceNodeView({ data }: NodeProps<Node<ServiceNodeData>>): JSX.Element {
  const { service, selected, matched, dim, ports, tags } = data;
  const bg = SCOPE_STYLE[service.scope].color;
  const rowCount = Math.max(ports.inPorts.length, ports.outPorts.length);
  const isUnresolved = service.unresolved === true;
  const isScopeMismatch = service.scopeMismatch === true;
  const specialBorder = isUnresolved || isScopeMismatch;
  const borderColor = selected
    ? '#ffdf5d'
    : matched
      ? '#79c0ff'
      : isUnresolved
        ? UNRESOLVED_COLOR
        : isScopeMismatch
          ? SCOPE_MISMATCH_COLOR
          : 'rgba(0,0,0,0.4)';
  const borderWidth = selected || matched || specialBorder ? 2 : 1;
  const borderStyle = specialBorder && !selected && !matched ? 'dashed' : 'solid';
  const glow = selected
    ? '0 0 0 3px rgba(255,223,93,0.25)'
    : matched
      ? '0 0 0 3px rgba(121,192,255,0.25)'
      : 'none';
  return (
    <div
      style={{
        background: bg,
        color: 'white',
        borderRadius: 6,
        border: `${borderWidth}px ${borderStyle} ${borderColor}`,
        boxShadow: glow,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        opacity: dim ? 0.18 : 1,
        width: NODE_WIDTH,
        position: 'relative',
      }}
    >
      <Handle
        id="default-target"
        type="target"
        position={Position.Right}
        style={{ background: '#555', top: HEADER_HEIGHT / 2 }}
      />
      <Handle
        id="default-source"
        type="source"
        position={Position.Left}
        style={{ background: '#555', top: HEADER_HEIGHT / 2 }}
      />

      <div style={{ padding: '6px 10px' }}>
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
          <span
            style={{
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {service.impl}
          </span>
        </div>
        <div style={{ fontSize: 10, opacity: 0.65, marginTop: 2, fontStyle: 'italic' }}>
          {isUnresolved
            ? 'no implementation registered'
            : isScopeMismatch
              ? `registered at ${service.scope} · cross-scope ref`
              : service.token}
        </div>
        <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{service.domain}</div>
      </div>

      {tags.length > 0 && <TagChips tags={tags} />}

      {rowCount > 0 && (
        <div
          style={{
            borderTop: '1px solid rgba(0,0,0,0.25)',
            background: 'rgba(0,0,0,0.15)',
            padding: `${PORTS_PAD_TOP}px 0`,
          }}
        >
          {Array.from({ length: rowCount }, (_, i) => {
            const out = ports.outPorts[i];
            const inn = ports.inPorts[i];
            return (
              <div
                key={i}
                style={{
                  position: 'relative',
                  height: PORT_ROW_HEIGHT,
                }}
              >
                {out !== undefined && (
                  <Handle
                    id={`out:${out}`}
                    type="source"
                    position={Position.Left}
                    style={{ background: '#f6c896' }}
                  />
                )}
                {inn !== undefined && (
                  <Handle
                    id={`in:${inn}`}
                    type="target"
                    position={Position.Right}
                    style={{
                      background: ports.connectedIn.has(inn) ? '#a8c8f6' : '#3d444d',
                    }}
                  />
                )}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    height: '100%',
                    padding: '0 10px',
                    fontSize: 10,
                  }}
                >
                  <span
                    style={{
                      flex: 1,
                      textAlign: 'left',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: '#fbe4c8',
                    }}
                  >
                    {out ?? ''}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      textAlign: 'right',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color:
                        inn !== undefined && !ports.connectedIn.has(inn)
                          ? '#6e7681'
                          : '#c8e0fb',
                    }}
                  >
                    {inn ?? ''}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
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

function TagChips({ tags }: { tags: string[] }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 3,
        padding: '0 8px 5px',
      }}
    >
      {tags.map((tag) => (
        <TagChip key={tag} tag={tag} />
      ))}
    </div>
  );
}

interface TagChipProps {
  tag: string;
  onRemove?: () => void;
}

function TagChip({ tag, onRemove }: TagChipProps): JSX.Element {
  const { color, bg } = tagColor(tag);
  return (
    <span
      title={tag}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        maxWidth: onRemove ? 150 : 120,
        padding: '1px 5px',
        fontSize: 9,
        lineHeight: '14px',
        color,
        background: bg,
        border: `1px solid ${color}`,
        borderRadius: 8,
        overflow: 'hidden',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {tag}
      </span>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label={`remove tag ${tag}`}
          style={{
            background: 'transparent',
            border: 'none',
            color,
            cursor: 'pointer',
            padding: 0,
            fontSize: 11,
            lineHeight: 1,
            opacity: 0.8,
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

interface TagEditorProps {
  tags: string[];
  allTags: string[];
  onChange: (next: string[]) => void;
}

function TagEditor({ tags, allTags, onChange }: TagEditorProps): JSX.Element {
  const [draft, setDraft] = useState('');
  const listId = 'tag-suggestions';

  function commit(raw: string): void {
    const tag = raw.trim();
    if (!tag || tags.includes(tag)) {
      setDraft('');
      return;
    }
    onChange([...tags, tag]);
    setDraft('');
  }

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
        tags
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
        {tags.length === 0 ? (
          <span style={{ color: '#6e7681', fontSize: 11 }}>no tags</span>
        ) : (
          tags.map((tag) => (
            <TagChip
              key={tag}
              tag={tag}
              onRemove={() => onChange(tags.filter((t) => t !== tag))}
            />
          ))
        )}
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          value={draft}
          list={listId}
          placeholder="add tag…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit(draft);
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            padding: '4px 7px',
            background: '#0e1116',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 4,
            fontSize: 11,
          }}
        />
        <button
          onClick={() => commit(draft)}
          style={{
            padding: '4px 10px',
            background: '#21262d',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 11,
          }}
        >
          add
        </button>
        <datalist id={listId}>
          {allTags
            .filter((t) => !tags.includes(t))
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
      </div>
    </div>
  );
}

const VIEWPORT_STORAGE_KEY = 'agent-core-v2:dep-graph:viewport';

function loadViewport(): Viewport | undefined {
  try {
    const raw = sessionStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<Viewport> | null;
    if (
      parsed === null ||
      typeof parsed.x !== 'number' ||
      typeof parsed.y !== 'number' ||
      typeof parsed.zoom !== 'number'
    ) {
      return undefined;
    }
    return { x: parsed.x, y: parsed.y, zoom: parsed.zoom };
  } catch {
    return undefined;
  }
}

function saveViewport(v: Viewport): void {
  try {
    sessionStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(v));
  } catch {
  }
}

function passesFilter(
  service: ServiceNode,
  filters: FilterState,
  connected: Set<string>,
): boolean {
  if (!filters.scopes.has(service.scope)) return false;
  if (filters.hiddenDomains.has(service.domain)) return false;
  if (filters.hideOrphans && !connected.has(service.id)) return false;
  return true;
}

function matchesSearch(service: ServiceNode, query: string): boolean {
  const members = service.publicMembers ? ` ${service.publicMembers.join(' ')}` : '';
  const hay = `${service.token} ${service.impl} ${service.domain}${members}`.toLowerCase();
  return hay.includes(query);
}

export function GraphView({
  graph,
  filters,
  selectedId,
  onSelect,
  tags,
  onEditTags,
}: GraphViewProps): JSX.Element {
  const initialViewport = useMemo(() => loadViewport(), []);

  const { nodes, edges, selectedService, selectedEdges } = useMemo(() => {
    const survivingEdges: Edge[] = graph.edges.filter((e) => filters.kinds.has(e.kind));

    const connected = new Set<string>();
    for (const e of survivingEdges) {
      connected.add(e.from);
      connected.add(e.to);
    }

    const visibleServices = graph.services.filter((s) =>
      passesFilter(s, filters, connected),
    );
    const visibleIds = new Set(visibleServices.map((s) => s.id));

    const finalEdges = survivingEdges.filter(
      (e) => visibleIds.has(e.from) && visibleIds.has(e.to),
    );

    const ports = computeServicePorts(visibleServices, finalEdges);

    const searchQuery = filters.search.trim().toLowerCase();
    const matched = new Set<string>();
    if (searchQuery) {
      for (const s of visibleServices) {
        if (matchesSearch(s, searchQuery)) matched.add(s.id);
      }
    }

    const tagMatched = new Set<string>();
    if (filters.activeTags.size > 0) {
      for (const s of visibleServices) {
        const st = tags[s.id];
        if (st && st.some((t) => filters.activeTags.has(t))) tagMatched.add(s.id);
      }
    }

    const focused = new Set<string>();
    const seedFocus = (id: string): void => {
      focused.add(id);
      for (const e of finalEdges) {
        if (e.from === id) focused.add(e.to);
        if (e.to === id) focused.add(e.from);
      }
    };
    if (selectedId !== undefined) seedFocus(selectedId);
    for (const id of matched) seedFocus(id);
    for (const id of tagMatched) seedFocus(id);

    const focusActive =
      selectedId !== undefined || matched.size > 0 || tagMatched.size > 0;

    const layout = layoutDagre(visibleServices, finalEdges, {
      groupByScope: filters.groupByScope,
      nodeSize: (id) => {
        const p = ports.get(id) ?? {
          inPorts: [],
          outPorts: [],
          connectedIn: new Set<string>(),
        };
        const hasTags = (tags[id]?.length ?? 0) > 0;
        return { width: NODE_WIDTH, height: nodeHeight(p, hasTags) };
      },
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
          matched: matched.has(service.id),
          dim: focusActive && !focused.has(service.id),
          ports: ports.get(service.id) ?? {
            inPorts: [],
            outPorts: [],
            connectedIn: new Set<string>(),
          },
          tags: tags[service.id] ?? [],
        },
      }),
    );

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

    const rfEdges: RFEdge[] = [];
    for (const e of finalEdges) {
      const style = EDGE_STYLE[e.kind];
      const isHighlighted = focusActive && focused.has(e.from) && focused.has(e.to);
      const pairs = new Map<
        string,
        { fromMethod: string | undefined; toMethod: string | undefined }
      >();
      for (const ref of e.refs) {
        const toMethod = effectiveToMethod(e.kind, ref.toMethod);
        const key = `${ref.fromMethod ?? ''}|${toMethod ?? ''}`;
        if (!pairs.has(key)) pairs.set(key, { fromMethod: ref.fromMethod, toMethod });
      }
      for (const [key, pair] of pairs) {
        const sourceHandle = pair.fromMethod ? `out:${pair.fromMethod}` : 'default-source';
        const targetHandle = pair.toMethod ? `in:${pair.toMethod}` : 'default-target';
        rfEdges.push({
          id: `${e.from}::${e.kind}::${e.to}::${key}`,
          source: e.from,
          target: e.to,
          sourceHandle,
          targetHandle,
          style: {
            stroke: style.color,
            strokeWidth: isHighlighted ? 2.2 : 1.2,
            strokeDasharray: style.dashed ? '4 3' : undefined,
            opacity: focusActive ? (isHighlighted ? 1 : 0.1) : 0.75,
          },
          animated: false,
        });
      }
    }

    const selectedService = selectedId
      ? graph.services.find((s) => s.id === selectedId)
      : undefined;
    const selectedEdges = selectedId
      ? finalEdges.filter((e) => e.from === selectedId || e.to === selectedId)
      : [];

    return { nodes: rfNodes, edges: rfEdges, selectedService, selectedEdges };
  }, [graph, filters, selectedId, tags]);

  return (
    <>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        {...(initialViewport
          ? { defaultViewport: initialViewport }
          : { fitView: true })}
        onMoveEnd={(_, viewport) => saveViewport(viewport)}
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
            if (!service) return '#7d8590';
            return service.unresolved
              ? UNRESOLVED_COLOR
              : service.scopeMismatch
                ? SCOPE_MISMATCH_COLOR
                : SCOPE_STYLE[service.scope].color;
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
          tags={tags}
          onEditTags={onEditTags}
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
  tags: TagMap;
  onEditTags: (nodeId: string, tags: string[]) => void;
}

function ServicePanel({
  service,
  graph,
  edges,
  onClose,
  tags,
  onEditTags,
}: ServicePanelProps): JSX.Element {
  const outgoing = edges.filter((e) => e.from === service.id);
  const incoming = edges.filter((e) => e.to === service.id && e.from !== service.id);
  const byId = new Map(graph.services.map((s) => [s.id, s]));
  const nodeTags = tags[service.id] ?? [];
  const allTags = useMemo(
    () => [...new Set(Object.values(tags).flat())].sort(),
    [tags],
  );
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        width: 420,
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
          {service.unresolved ? (
            <div style={{ color: UNRESOLVED_COLOR, fontSize: 11, marginTop: 2 }}>
              No implementation registered
            </div>
          ) : service.scopeMismatch ? (
            <div style={{ color: SCOPE_MISMATCH_COLOR, fontSize: 11, marginTop: 2 }}>
              Registered at {service.scope} — not visible from the caller&apos;s scope
            </div>
          ) : (
            <div style={{ color: '#a5b0bc', fontSize: 11 }}>{service.token}</div>
          )}
          <div style={{ color: '#7d8590', fontSize: 11 }}>
            <b>{service.scope}</b> · {service.domain}
          </div>
          {!service.unresolved && !service.scopeMismatch && (
            <div style={{ color: '#7d8590', fontSize: 10, marginTop: 4, wordBreak: 'break-all' }}>
              {service.file}:{service.line}
            </div>
          )}
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

      <TagEditor
        tags={nodeTags}
        allTags={allTags}
        onChange={(next) => {
          onEditTags(service.id, next);
        }}
      />

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

interface EdgeGroup {
  edge: Edge;
  peerLabel: string;
  peerToken?: string;
  methodRefs: EdgeRef[];
  unattributedCount: number;
}

function buildEdgeGroups(
  edges: Edge[],
  direction: 'in' | 'out',
  byId: Map<string, ServiceNode>,
): EdgeGroup[] {
  return edges.map((e) => {
    const peerId = direction === 'out' ? e.to : e.from;
    const peer = byId.get(peerId);
    const peerLabel = peer ? peer.impl : peerId;
    const peerToken = peer?.token;
    const methodRefs = e.refs.filter(
      (r) => r.toMethod !== undefined || r.fromMethod !== undefined,
    );
    const unattributedCount = e.refs.length - methodRefs.length;
    return { edge: e, peerLabel, peerToken, methodRefs, unattributedCount };
  });
}

function EdgeList({ title, edges, direction, byId }: EdgeListProps): JSX.Element {
  const groups = buildEdgeGroups(edges, direction, byId);
  const selfIsFrom = direction === 'out';
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
      {groups.length === 0 ? (
        <div style={{ color: '#7d8590', fontSize: 11 }}>—</div>
      ) : (
        <table style={tableStyle}>
          <colgroup>
            <col style={{ width: 72 }} />
            <col style={{ width: 128 }} />
            <col />
            <col style={{ width: 40 }} />
          </colgroup>
          <thead>
            <tr>
              <th style={thStyle}>kind</th>
              <th style={thStyle}>peer</th>
              <th style={thStyle}>from → to</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>line</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => {
              const kindStyle = EDGE_STYLE[g.edge.kind];
              const kindCell = (
                <div style={cellClipStyle}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 10,
                      height: 3,
                      borderTop: `${kindStyle.dashed ? '2px dashed' : '2px solid'} ${kindStyle.color}`,
                      marginRight: 4,
                      verticalAlign: 'middle',
                    }}
                  />
                  <span style={{ color: '#a5b0bc' }}>{g.edge.kind}</span>
                </div>
              );
              const peerCell = (
                <div style={cellClipStyle} title={g.peerToken}>
                  {g.peerLabel}
                </div>
              );
              const groupKey = `${g.edge.from}::${g.edge.kind}::${g.edge.to}`;
              if (g.methodRefs.length === 0) {
                return (
                  <tr key={groupKey} style={groupBorderStyle}>
                    <td style={tdStyle}>{kindCell}</td>
                    <td style={tdStyle}>{peerCell}</td>
                    <td
                      colSpan={2}
                      style={{
                        ...tdStyle,
                        color: '#6e7681',
                        fontStyle: 'italic',
                      }}
                    >
                      — ×{g.edge.refs.length}
                    </td>
                  </tr>
                );
              }
              return (
                <Fragment key={groupKey}>
                  {g.methodRefs.map((r, i) => {
                    const isFirst = i === 0;
                    return (
                      <tr
                        key={`${groupKey}::${r.file}:${r.line}:${i}`}
                        style={isFirst ? groupBorderStyle : undefined}
                      >
                        {isFirst && (
                          <>
                            <td rowSpan={g.methodRefs.length} style={tdStyle}>
                              {kindCell}
                            </td>
                            <td rowSpan={g.methodRefs.length} style={tdStyle}>
                              {peerCell}
                            </td>
                          </>
                        )}
                        <td style={tdCallStyle} title={`${r.fromMethod ?? '?'} → ${r.toMethod ?? '?'}`}>
                          <span
                            style={{
                              fontWeight: selfIsFrom ? 600 : 400,
                              color: selfIsFrom ? '#e6edf3' : '#a5b0bc',
                            }}
                          >
                            {r.fromMethod ?? '?'}
                          </span>
                          <span style={{ color: '#6e7681', margin: '0 4px' }}>→</span>
                          <span
                            style={{
                              fontWeight: !selfIsFrom ? 600 : 400,
                              color: !selfIsFrom ? '#e6edf3' : '#a5b0bc',
                            }}
                          >
                            {r.toMethod ?? '?'}
                          </span>
                        </td>
                        <td style={tdLineStyle}>:{r.line}</td>
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  fontSize: 10.5,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  fontWeight: 600,
  color: '#7d8590',
  fontSize: 9,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  padding: '3px 6px',
  borderBottom: '1px solid #30363d',
};

const tdStyle: React.CSSProperties = {
  padding: '3px 6px',
  verticalAlign: 'top',
};

const tdCallStyle: React.CSSProperties = {
  ...tdStyle,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const tdLineStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  color: '#6e7681',
  whiteSpace: 'nowrap',
};

const cellClipStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const groupBorderStyle: React.CSSProperties = {
  borderTop: '1px solid #21262d',
};
