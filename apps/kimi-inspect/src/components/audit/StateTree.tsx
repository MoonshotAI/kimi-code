/**
 * Diff-aware state tree for the audit panel.
 *
 * Renders a serialized `AgentState` (see `audit/serialize.ts`) as a
 * collapsible tree, colored by the structural diff against the previous
 * trail entry: added = green, removed = red + strikethrough, modified =
 * amber (`old → new` on leaves). Every field is rendered — long strings
 * are tail-truncated (`tailTrunc`) but no key is ever dropped, and a string
 * containing newlines collapses into one compact button (first-line preview
 * + line count) whose hover pops a `fixed` full-text panel at the button's
 * right edge.
 *
 * The tree is driven entirely by a `DiffNode` root: diff mode passes
 * `diffValue(prev, next)`, plain state mode passes `plainNode(value)`.
 * Diff nodes that carry an object/array but no children (whole-subtree
 * added/removed, or reference-equal unchanged subtrees collapsed by the
 * diff fast path) are expanded into same-status blocks at render time
 * (`blockNode`) — they show as collapsible `{ …N }` rows instead of an
 * unreadable one-line JSON dump.
 */

import { useEffect, useRef, useState } from 'react';

import { elementId, type DiffNode, type DiffStatus } from '../../audit/diff';
import { tailTrunc } from '../../audit/truncate';

/** Build an all-`unchanged` tree over a plain value (plain state mode). */
export function plainNode(value: unknown): DiffNode {
  return blockNode(value, 'unchanged');
}

function blockNode(value: unknown, status: DiffStatus): DiffNode {
  const current = status === 'removed' ? undefined : value;
  const prev = status === 'removed' ? value : undefined;
  if (typeof value === 'object' && value !== null) {
    const children = new Map<string, DiffNode>();
    const entries: Array<readonly [string, unknown]> = Array.isArray(value)
      ? value.map((item, index) => [elementId(item) ?? `#${index}`, item] as const)
      : Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    for (const [key, item] of entries) children.set(key, blockNode(item, status));
    return { status, value: current, prev, children };
  }
  return { status, value: current, prev };
}

function subtreeHasChanges(node: DiffNode): boolean {
  if (node.status !== 'unchanged') return true;
  if (node.children === undefined) return false;
  for (const child of node.children.values()) {
    if (subtreeHasChanges(child)) return true;
  }
  return false;
}

const ROW_TONE: Record<DiffStatus, string> = {
  unchanged: 'border-transparent',
  added: 'border-green-800 bg-green-950/40',
  removed: 'border-red-800 bg-red-950/40',
  modified: 'border-amber-700 bg-amber-950/30',
};

const TEXT_TONE: Record<DiffStatus, string> = {
  unchanged: 'text-neutral-400',
  added: 'text-green-400',
  removed: 'text-red-400 line-through',
  modified: 'text-amber-300',
};

function Leaf({ value, tone }: { value: unknown; tone: DiffStatus }) {
  const className = TEXT_TONE[tone];
  if (value === null) return <span className={className}>null</span>;
  if (value === undefined) return <span className={className}>undefined</span>;
  if (typeof value === 'string') {
    if (value.includes('\n')) return <MultilineString value={value} tone={tone} />;
    return <span className={`${className} whitespace-pre-wrap break-all`}>"{tailTrunc(value)}"</span>;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className={className}>{String(value)}</span>;
  }
  return <span className={className}>{JSON.stringify(value) ?? 'unknown'}</span>;
}

/**
 * Multiline string leaf: rendered as one compact button (first-line preview
 * + line count) so a prompt or tool output never stretches the tree. Hovering
 * the button pops a `fixed` panel at its right edge with the full text —
 * `fixed` because the tree sits inside an `overflow-y-auto` column that
 * would clip an absolutely-positioned popup. A 150 ms close delay lets the
 * pointer travel from the button into the panel (to scroll or select).
 * `popupStyle` keeps the whole panel inside the viewport: the total height
 * is capped by the space left below the clamped top edge, and the panel
 * flips to the button's left side when the remaining right space is cramped.
 */
function popupStyle(rect: DOMRect): React.CSSProperties {
  const margin = 8;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const maxHeight = Math.max(160, Math.floor(vh * 0.7));
  const top = Math.max(margin, Math.min(rect.top, vh - maxHeight - margin));
  const rightSpace = vw - rect.right - margin * 2;
  if (rightSpace >= 320) {
    return { left: rect.right + margin, top, maxHeight, width: Math.min(560, rightSpace) };
  }
  const leftSpace = rect.left - margin * 2;
  return {
    right: vw - rect.left + margin,
    top,
    maxHeight,
    width: Math.min(560, Math.max(280, leftSpace)),
  };
}

function MultilineString({ value, tone }: { value: string; tone: DiffStatus }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const lines = value.split('\n');
  const firstLine = lines[0] ?? '';
  const preview = firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;

  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    clearTimeout(closeTimer.current);
    setRect(e.currentTarget.getBoundingClientRect());
  };
  const scheduleClose = () => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setRect(null), 150);
  };

  return (
    <>
      <button
        type="button"
        className={`${TEXT_TONE[tone]} cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-1 hover:border-sky-600`}
        onMouseEnter={open}
        onMouseLeave={scheduleClose}
      >
        {`"${preview}" ⏎ ${lines.length}`}
      </button>
      {rect !== null ? (
        <div
          className="fixed z-50 flex flex-col rounded border border-neutral-700 bg-neutral-950 shadow-xl"
          style={popupStyle(rect)}
          onMouseEnter={() => clearTimeout(closeTimer.current)}
          onMouseLeave={scheduleClose}
        >
          <div className="shrink-0 border-b border-neutral-800 px-3 py-1 text-[10px] text-neutral-500">
            {lines.length} lines · {value.length} chars
          </div>
          <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all text-neutral-200">
            {tailTrunc(value, 5000)}
          </pre>
        </div>
      ) : null}
    </>
  );
}

function Node({
  name,
  node,
  depth,
  defaultDepth,
}: {
  name: string;
  node: DiffNode;
  depth: number;
  defaultDepth: number;
}) {
  // Childless object/array nodes (whole-subtree added/removed, or
  // reference-equal unchanged subtrees) are expanded into same-status
  // blocks so every field stays visible — never a one-line JSON dump.
  const raw = node.status === 'removed' ? node.prev : node.value;
  const effective =
    node.children === undefined && typeof raw === 'object' && raw !== null
      ? blockNode(raw, node.status)
      : node;

  const [open, setOpen] = useState(() => subtreeHasChanges(effective) || depth < defaultDepth);
  const label = <span className={TEXT_TONE[effective.status]}>{name}: </span>;

  if (effective.children === undefined) {
    return (
      <div
        className={`border-l-2 px-1 font-mono text-[11px] leading-[1.7] ${ROW_TONE[effective.status]}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {label}
        {effective.status === 'modified' ? (
          <>
            <Leaf value={effective.prev} tone="removed" />
            <span className="text-neutral-600"> → </span>
            <Leaf value={effective.value} tone="added" />
          </>
        ) : (
          <Leaf value={raw} tone={effective.status} />
        )}
      </div>
    );
  }

  const isArray = Array.isArray(raw);
  const [openBrace, closeBrace] = isArray ? ['[', ']'] : ['{', '}'];
  return (
    <div>
      <div
        className={`cursor-pointer select-none border-l-2 px-1 font-mono text-[11px] leading-[1.7] hover:bg-neutral-800/70 ${ROW_TONE[effective.status]}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="text-neutral-600">{open ? '▾ ' : '▸ '}</span>
        {label}
        <span className="text-neutral-600">
          {open ? openBrace : `${openBrace} …${effective.children.size} ${closeBrace}`}
        </span>
      </div>
      {open ? (
        <>
          {[...effective.children.entries()].map(([key, child]) => (
            <Node key={key} name={key} node={child} depth={depth + 1} defaultDepth={defaultDepth} />
          ))}
          <div
            className={`border-l-2 px-1 font-mono text-[11px] leading-[1.7] ${ROW_TONE[effective.status]}`}
            style={{ paddingLeft: `${depth * 14 + 4}px` }}
          >
            <span className="text-neutral-600">{closeBrace}</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function StateTree({
  root,
  defaultDepth = 0,
}: {
  root: DiffNode;
  /** Unchanged levels opened by default (diff mode 0 = only changes auto-open). */
  defaultDepth?: number;
}) {
  if (root.children === undefined) {
    return (
      <div className="py-1">
        <Node name="state" node={root} depth={0} defaultDepth={defaultDepth} />
      </div>
    );
  }
  return (
    <div className="py-1">
      {[...root.children.entries()].map(([key, child]) => (
        <Node key={key} name={key} node={child} depth={0} defaultDepth={defaultDepth} />
      ))}
    </div>
  );
}
