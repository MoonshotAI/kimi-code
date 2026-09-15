/**
 * DI Deps panel — the persistent dependency DAG (`IDebugGraphService.graph`)
 * as Finder-style Miller columns with path-scoped relation markers. Edges
 * point consumer → dependency, so "X depends on Y" ⟺ an edge
 * `from: X → to: Y`:
 *
 *   - column 0 lists the roots: services that never appear as an edge's `to`
 *     (nothing consumes them, isolated nodes included), token-sorted,
 *     constrained by the scope filter; each root row carries the level-0
 *     color bar;
 *   - clicking a row in column N truncates the expansion path there and
 *     opens column N+1 with that service's direct dependencies (along `to`,
 *     unfiltered — cross-scope rows get a scopePath subtitle);
 *   - relation bars are path-scoped: a row's left edge carries one 3px bar
 *     per path ancestor that depends on it DIRECTLY (edge ancestor → node),
 *     ordered by ancestor depth — the direct parent always contributes one,
 *     and a grandparent with a skip-level edge adds another. Every color is
 *     the fixed per-LEVEL identity color (`levelColor(depth)`), so a bar
 *     reads directly as "depended on by the service N levels up", identical
 *     in every path; column headers carry the parent level's color chip so
 *     bars map back to ancestors;
 *   - path highlight: rows covered by the closure (reachable along `to`) of
 *     the path's root get a faint background in the level-0 color;
 *   - rows without dependencies are dimmed and carry no chevron; a row
 *     already in the current path is marked ↩ (cycle guard — columns only
 *     ever open on click, so there is no auto-recursion).
 *
 * Pure React + Tailwind, no graph or layout library.
 */
import type { UnitState } from '@moonshot-ai/agent-core-v2/_base/di/cascadeEngine';
import type { DebugGraph, DebugGraphNode } from '@moonshot-ai/agent-core-v2/debug/debugGraph';
import { useEffect, useMemo, useRef, useState } from 'react';

const STATE_COLORS: Record<UnitState | 'none', string> = {
  Pending: '#a3a3a3',
  Activating: '#38bdf8',
  Active: '#34d399',
  Unloading: '#fbbf24',
  Failed: '#f87171',
  none: '#525252',
};

/**
 * Fixed identity color per path depth (level): `levelColor(d)` is the same
 * for every service at depth d in every path, so a row's color bars read
 * directly as "depended on by the service at level 0 / 1 / 2 …".
 */
const LEVEL_PALETTE = [
  '#f87171',
  '#fb923c',
  '#fbbf24',
  '#a3e635',
  '#34d399',
  '#22d3ee',
  '#38bdf8',
  '#818cf8',
  '#c084fc',
  '#f472b6',
];

function levelColor(depth: number): string {
  return LEVEL_PALETTE[depth % LEVEL_PALETTE.length] ?? '#525252';
}

function scopeDepth(path: string): number {
  return path.split('/').length;
}

function compareScopePaths(a: string, b: string): number {
  return scopeDepth(a) - scopeDepth(b) || a.localeCompare(b);
}

function byToken(a: DebugGraphNode, b: DebugGraphNode): number {
  return a.token.localeCompare(b.token);
}

function fallbackNode(id: string): DebugGraphNode {
  return { id, token: id, scopePath: '' };
}

interface DepsColumn {
  readonly title: string;
  /**
   * The scope the column's rows belong to by default ('' = unfiltered root
   * column): rows from any other scope get a scopePath subtitle, as do all
   * rows when the column spans more than one scope.
   */
  readonly homeScope: string;
  readonly items: readonly DebugGraphNode[];
}

export function DiGraphPanel({ graph }: { graph: DebugGraph }) {
  const [scopeFilter, setScopeFilter] = useState('');
  /** Selected row id per column — path[i] is the row expanded into column i+1. */
  const [path, setPath] = useState<readonly string[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const allScopes = useMemo(
    () => [...new Set(graph.nodes.map((n) => n.scopePath))].toSorted(compareScopePaths),
    [graph],
  );

  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  /** Direct dependencies per consumer id (edge `to` endpoints), deduped. */
  const depsOf = useMemo(() => {
    const acc = new Map<string, Set<string>>();
    for (const e of graph.edges) {
      const set = acc.get(e.from) ?? new Set<string>();
      set.add(e.to);
      acc.set(e.from, set);
    }
    return acc;
  }, [graph]);

  /** Services nothing consumes (never an edge's `to`), scope-filtered. */
  const roots = useMemo(() => {
    const consumed = new Set(graph.edges.map((e) => e.to));
    const pool =
      scopeFilter === '' ? graph.nodes : graph.nodes.filter((n) => n.scopePath === scopeFilter);
    return pool.filter((n) => !consumed.has(n.id)).toSorted(byToken);
  }, [graph, scopeFilter]);

  // Walk the path, truncating it at the first entry that is no longer
  // selectable (scope filter change or data refresh), so rendering and
  // follow-up clicks always work from a valid prefix.
  const { columns, usedPath } = useMemo(() => {
    const columns: DepsColumn[] = [];
    const usedPath: string[] = [];
    columns.push({
      title: `roots · ${scopeFilter === '' ? 'all scopes' : scopeFilter}`,
      homeScope: scopeFilter,
      items: roots,
    });
    let items = roots;
    for (const id of path) {
      if (!items.some((n) => n.id === id)) break;
      usedPath.push(id);
      const deps = [...(depsOf.get(id) ?? [])]
        .map((depId) => nodesById.get(depId) ?? fallbackNode(depId))
        .toSorted(byToken);
      if (deps.length === 0) break;
      const parent = nodesById.get(id);
      columns.push({
        title: parent?.token ?? id,
        homeScope: parent?.scopePath ?? '',
        items: deps,
      });
      items = deps;
    }
    return { columns, usedPath };
  }, [scopeFilter, path, roots, depsOf, nodesById]);

  // Keep the deepest column in view as the path grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollLeft = el.scrollWidth;
  }, [columns.length]);

  const select = (columnIndex: number, id: string) => {
    setPath([...usedPath.slice(0, columnIndex), id]);
  };

  // Path context: the root the current path starts at (column 0 only holds
  // roots, so this is always one — guarded anyway).
  const pathRootId = usedPath[0];

  // Path-highlight: nodes reachable (along `to`) from the path's root,
  // tinted in the fixed level-0 color. Only the path root's closure is
  // needed — computed lazily per selection.
  const pathTint = pathRootId === undefined ? undefined : `${levelColor(0)}1a`;
  const pathClosure = useMemo(() => {
    if (pathRootId === undefined) return undefined;
    const seen = new Set<string>();
    const stack = [pathRootId];
    while (stack.length > 0) {
      const id = stack.pop() ?? '';
      if (seen.has(id)) continue;
      seen.add(id);
      for (const dep of depsOf.get(id) ?? []) stack.push(dep);
    }
    return seen;
  }, [pathRootId, depsOf]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <select
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-sky-600"
          value={scopeFilter}
          onChange={(e) => {
            setScopeFilter(e.target.value);
          }}
        >
          <option value="">all scopes</option>
          {allScopes.map((scopePath) => (
            <option key={scopePath} value={scopePath}>
              {scopePath}
            </option>
          ))}
        </select>
        <span className="flex items-center gap-2 text-[10px] text-neutral-500">
          {(Object.keys(STATE_COLORS) as (UnitState | 'none')[]).map((state) => (
            <span key={state} className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: STATE_COLORS[state] }}
              />
              {state === 'none' ? 'unseen' : state}
            </span>
          ))}
        </span>
      </div>
      {graph.nodes.length === 0 ? (
        <div className="text-[11px] text-neutral-600 italic">no nodes</div>
      ) : (
        <div
          ref={scrollRef}
          className="flex h-[calc(100vh-150px)] min-h-[320px] overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950"
        >
          {columns.map((column, columnIndex) => (
            <DepsColumnView
              key={columnIndex}
              column={column}
              columnIndex={columnIndex}
              usedPath={usedPath}
              depsOf={depsOf}
              nodesById={nodesById}
              pathTint={pathTint}
              pathClosure={pathClosure}
              onSelect={select}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function DepsColumnView({
  column,
  columnIndex,
  usedPath,
  depsOf,
  nodesById,
  pathTint,
  pathClosure,
  onSelect,
}: {
  column: DepsColumn;
  columnIndex: number;
  usedPath: readonly string[];
  depsOf: ReadonlyMap<string, ReadonlySet<string>>;
  nodesById: ReadonlyMap<string, DebugGraphNode>;
  pathTint?: string;
  pathClosure?: ReadonlySet<string>;
  onSelect: (columnIndex: number, id: string) => void;
}) {
  const mixedScopes = new Set(column.items.map((n) => n.scopePath)).size > 1;
  const selectedId = usedPath[columnIndex];
  return (
    <div className="w-[230px] shrink-0 overflow-y-auto border-r border-neutral-800 last:border-r-0">
      <div className="sticky top-0 flex items-baseline gap-2 border-b border-neutral-800 bg-neutral-950 px-2 py-1">
        {columnIndex > 0 ? (
          <span
            className="h-2.5 w-2.5 shrink-0 self-center rounded-sm"
            style={{ background: levelColor(columnIndex - 1) }}
            title={`dependencies of ${column.title}`}
          />
        ) : null}
        <span className="min-w-0 truncate font-mono text-[10px] font-semibold text-neutral-400">
          {column.title}
        </span>
        <span className="ml-auto shrink-0 text-[9px] text-neutral-600">{column.items.length}</span>
      </div>
      <div className="p-1">
        {column.items.length === 0 ? (
          <div className="px-2 py-1 text-[10px] text-neutral-600 italic">
            {columnIndex === 0 ? 'no roots' : 'no nodes'}
          </div>
        ) : (
          column.items.map((node) => {
            const hasDeps = (depsOf.get(node.id)?.size ?? 0) > 0;
            const selected = node.id === selectedId;
            const inPath = usedPath.slice(0, columnIndex).includes(node.id);
            const showScope =
              mixedScopes || (column.homeScope !== '' && node.scopePath !== column.homeScope);
            // Path-scoped relation bars: column 0 rows carry the level-0
            // color; expanded columns carry one bar per path ancestor with a
            // DIRECT edge to this node, each in that ancestor's level color.
            const bars: { color: string; label: string }[] = [];
            if (columnIndex === 0) {
              bars.push({ color: levelColor(0), label: node.token });
            } else {
              usedPath.slice(0, columnIndex).forEach((ancestorId, depth) => {
                if (depsOf.get(ancestorId)?.has(node.id) === true) {
                  bars.push({
                    color: levelColor(depth),
                    label: nodesById.get(ancestorId)?.token ?? ancestorId,
                  });
                }
              });
            }
            const inPathTree = !selected && pathClosure?.has(node.id) === true;
            const details = [
              `state: ${node.state ?? 'unseen'}`,
              node.uid !== undefined ? `#${node.uid}` : undefined,
              inPath ? 'already in path' : undefined,
              columnIndex > 0 && bars.length > 0
                ? `direct dependency of: ${bars.map((b) => b.label).join(', ')}`
                : undefined,
            ]
              .filter((s) => s !== undefined)
              .join('\n');
            return (
              <button
                key={node.id}
                type="button"
                title={`${node.id}\n${details}`}
                onClick={() => {
                  onSelect(columnIndex, node.id);
                }}
                style={{
                  backgroundColor: inPathTree ? pathTint : undefined,
                }}
                className={`mb-0.5 flex w-full items-stretch gap-1.5 rounded px-1.5 py-0.5 text-left font-mono text-[11px] ${
                  selected
                    ? 'bg-neutral-800 text-sky-400'
                    : hasDeps
                      ? 'text-neutral-300 hover:bg-neutral-800/60'
                      : 'text-neutral-500 hover:bg-neutral-800/60'
                }`}
              >
                <span className="flex shrink-0 gap-[2px] self-stretch">
                  {bars.map((bar, i) => (
                    <span
                      key={i}
                      className="w-[3px] rounded-sm"
                      style={{ background: bar.color }}
                      title={bar.label}
                    />
                  ))}
                </span>
                <span
                  className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: STATE_COLORS[node.state ?? 'none'] }}
                />
                <span className="min-w-0 flex-1 self-center">
                  <span className="block truncate">{node.token}</span>
                  {showScope ? (
                    <span className="block truncate text-[9px] text-neutral-600">
                      {node.scopePath}
                    </span>
                  ) : null}
                </span>
                {inPath ? (
                  <span
                    className="shrink-0 self-center text-[10px] text-amber-400"
                    title="already in path"
                  >
                    ↩
                  </span>
                ) : null}
                <span className="w-3 shrink-0 self-center text-right text-neutral-600">
                  {hasDeps ? '›' : ''}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
