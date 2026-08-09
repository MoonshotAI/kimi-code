import type { EdgeKind, Graph, ServiceScope } from '../../analyzer/types';
import { EDGE_KINDS, EDGE_STYLE, SCOPE_STYLE } from './style';
import { tagColor, type TagCount } from './tags';

export interface FilterState {
  scopes: Set<ServiceScope>;
  kinds: Set<EdgeKind>;
  hiddenDomains: Set<string>;
  search: string;
  hideOrphans: boolean;
  groupByScope: boolean;
  activeTags: Set<string>;
}

interface FiltersProps {
  graph: Graph;
  domains: string[];
  tagCounts: TagCount[];
  state: FilterState;
  onChange: (next: FilterState) => void;
}

const SCOPES: ServiceScope[] = ['App', 'Session', 'Agent'];

export function Filters({
  graph,
  domains,
  tagCounts,
  state,
  onChange,
}: FiltersProps): JSX.Element {
  function toggle<T>(set: Set<T>, key: T): Set<T> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  const edgeCounts = countByKind(graph);
  const scopeCounts = countByScope(graph);
  const domainCounts = countByDomain(graph);

  return (
    <aside
      style={{
        width: 260,
        minWidth: 260,
        background: '#151b23',
        borderRight: '1px solid #30363d',
        padding: 16,
        overflowY: 'auto',
        fontSize: 13,
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          agent-core-v2 · dep graph
        </div>
        <div style={{ color: '#7d8590', fontSize: 11 }}>
          {graph.services.length} services · {graph.edges.length} edges
        </div>
        <div style={{ color: '#7d8590', fontSize: 11, marginTop: 4 }}>
          @ <code>{graph.generatedAt.slice(0, 10)}</code>
        </div>
      </div>

      <input
        placeholder="search service, interface, method…"
        value={state.search}
        onChange={(e) => onChange({ ...state, search: e.target.value })}
        title="Substring match across impl class, token interface, domain, and public members"
        style={{
          width: '100%',
          padding: '6px 8px',
          background: '#0e1116',
          color: '#e6edf3',
          border: '1px solid #30363d',
          borderRadius: 4,
          marginBottom: 16,
          boxSizing: 'border-box',
        }}
      />

      <Section title="Scope">
        {SCOPES.map((s) => (
          <CheckRow
            key={s}
            label={s}
            count={scopeCounts[s] ?? 0}
            checked={state.scopes.has(s)}
            color={SCOPE_STYLE[s].color}
            onToggle={() => onChange({ ...state, scopes: toggle(state.scopes, s) })}
          />
        ))}
      </Section>

      <Section title="Edge kind">
        {EDGE_KINDS.map((k) => (
          <CheckRow
            key={k}
            label={EDGE_STYLE[k].label}
            count={edgeCounts[k] ?? 0}
            checked={state.kinds.has(k)}
            color={EDGE_STYLE[k].color}
            dashed={EDGE_STYLE[k].dashed}
            onToggle={() => onChange({ ...state, kinds: toggle(state.kinds, k) })}
          />
        ))}
      </Section>

      <Section title="View">
        <CheckRow
          label="hide orphans"
          checked={state.hideOrphans}
          onToggle={() => onChange({ ...state, hideOrphans: !state.hideOrphans })}
        />
        <CheckRow
          label="group by scope"
          checked={state.groupByScope}
          onToggle={() => onChange({ ...state, groupByScope: !state.groupByScope })}
        />
      </Section>

      <Section title={`Tags (${tagCounts.length})`}>
        {tagCounts.length === 0 ? (
          <div style={{ color: '#7d8590', fontSize: 11 }}>
            none yet — click a node to add tags
          </div>
        ) : (
          <>
            <div style={{ marginBottom: 6, display: 'flex', gap: 6 }}>
              <button
                style={btnStyle}
                onClick={() =>
                  onChange({
                    ...state,
                    activeTags: new Set(tagCounts.map((t) => t.tag)),
                  })
                }
              >
                all
              </button>
              <button
                style={btnStyle}
                onClick={() => onChange({ ...state, activeTags: new Set() })}
              >
                none
              </button>
            </div>
            {tagCounts.map(({ tag, count }) => (
              <CheckRow
                key={tag}
                label={tag}
                count={count}
                checked={state.activeTags.has(tag)}
                color={tagColor(tag).color}
                onToggle={() =>
                  onChange({ ...state, activeTags: toggle(state.activeTags, tag) })
                }
              />
            ))}
          </>
        )}
      </Section>

      <Section title={`Domain (${domains.length})`}>
        <div style={{ marginBottom: 6, display: 'flex', gap: 6 }}>
          <button
            style={btnStyle}
            onClick={() => onChange({ ...state, hiddenDomains: new Set() })}
          >
            all
          </button>
          <button
            style={btnStyle}
            onClick={() => onChange({ ...state, hiddenDomains: new Set(domains) })}
          >
            none
          </button>
        </div>
        {domains.map((d) => (
          <CheckRow
            key={d}
            label={d}
            count={domainCounts[d] ?? 0}
            checked={!state.hiddenDomains.has(d)}
            onToggle={() =>
              onChange({ ...state, hiddenDomains: toggle(state.hiddenDomains, d) })
            }
          />
        ))}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: 'uppercase',
          color: '#7d8590',
          marginBottom: 6,
          letterSpacing: 0.5,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

interface CheckRowProps {
  label: string;
  count?: number;
  checked: boolean;
  color?: string;
  dashed?: boolean;
  onToggle: () => void;
}

function CheckRow({ label, count, checked, color, dashed, onToggle }: CheckRowProps): JSX.Element {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 0',
        cursor: 'pointer',
        opacity: checked ? 1 : 0.5,
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ margin: 0, accentColor: color ?? '#79c0ff' }}
      />
      {color !== undefined && (
        <span
          style={{
            display: 'inline-block',
            width: 14,
            height: 3,
            borderTop: `${dashed ? '2px dashed' : '2px solid'} ${color}`,
            marginRight: 2,
          }}
        />
      )}
      <span style={{ flex: 1 }}>{label}</span>
      {count !== undefined && (
        <span style={{ color: '#7d8590', fontSize: 11 }}>{count}</span>
      )}
    </label>
  );
}

const btnStyle: React.CSSProperties = {
  flex: 1,
  padding: '3px 8px',
  background: '#21262d',
  color: '#e6edf3',
  border: '1px solid #30363d',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 11,
};

function countByKind(graph: Graph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of graph.edges) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

function countByScope(graph: Graph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of graph.services) out[s.scope] = (out[s.scope] ?? 0) + 1;
  return out;
}

function countByDomain(graph: Graph): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of graph.services) out[s.domain] = (out[s.domain] ?? 0) + 1;
  return out;
}
