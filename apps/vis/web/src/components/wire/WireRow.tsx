import { memo, useCallback } from 'react';

import type { WireEntry } from '../../types';
import { formatWallClock } from '../../util/time';
import { TypeBadge } from './TypeBadge';
import { renderHeadline } from './WireHeadline';
import { WireRowDetail } from './WireRowDetail';

/** Pairing hint for a `tool.call` ↔ `tool.result` row. Computed by the
 *  parent (WireTab) from the full record list and threaded down here so
 *  the row can render an inline cross-reference and participate in the
 *  hover-highlight protocol. */
export interface PairHint {
  toolCallId: string;
  kind: 'call' | 'result';
  callLineNo: number | null;
  resultLineNo: number | null;
}

interface WireRowProps {
  entry: WireEntry;
  expanded: boolean;
  onToggle: () => void;
  /** Scroll to a line and expand it — wired by the Wire tab via the virtualizer. */
  onJumpTo?: (lineNo: number) => void;
  /** Set when this entry is a tool.call/tool.result; carries the matching counterpart's line. */
  pair?: PairHint;
  /** True when another row from this pair is currently hovered. */
  highlighted: boolean;
  /** Notify the parent that this row's pair group is being hovered. */
  onHoverPair?: (toolCallId: string | null) => void;
}

export const WireRow = memo(function WireRow({
  entry,
  expanded,
  onToggle,
  onJumpTo,
  pair,
  highlighted,
  onHoverPair,
}: WireRowProps) {
  const record = entry.data;
  const h = renderHeadline(record);
  const timeTitle = formatTimeTitle(record.time);

  const handleEnter = useCallback(() => {
    if (pair !== undefined && onHoverPair !== undefined) {
      onHoverPair(pair.toolCallId);
    }
  }, [pair, onHoverPair]);
  const handleLeave = useCallback(() => {
    if (pair !== undefined && onHoverPair !== undefined) {
      onHoverPair(null);
    }
  }, [pair, onHoverPair]);

  return (
    <div
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      className={[
        'flex items-stretch border-b border-border',
        highlighted
          ? 'bg-[color-mix(in_oklab,var(--color-cat-tools)_18%,transparent)]'
          : expanded
            ? 'bg-surface-1'
            : 'bg-surface-0 hover:bg-surface-1',
      ].join(' ')}
    >
      <div className="min-w-0 flex-1">
        <button
          onClick={onToggle}
          className="flex w-full items-center gap-3 px-2 py-[5px] text-left min-h-[28px]"
        >
          <span className="font-mono text-[11px] text-fg-3 tabular w-[52px] shrink-0 text-right">
            {entry.lineNo}
          </span>
          <span
            className="font-mono text-[11px] text-fg-3 tabular w-[68px] shrink-0"
            title={timeTitle}
          >
            {record.time !== undefined ? formatWallClock(record.time) : '--:--:--'}
          </span>
          <span className="shrink-0">
            <TypeBadge type={record.type} />
          </span>
          <span className="flex-1 min-w-0 flex items-center gap-2">{h.main}</span>
          <span className="flex items-center gap-2 shrink-0">
            {h.right}
            {pair !== undefined ? <PairIndicator pair={pair} onJumpTo={onJumpTo} /> : null}
            <Chevron open={expanded} />
          </span>
        </button>
        {expanded ? (
          <div className="border-t border-border bg-surface-1 px-2 pb-2 pt-1">
            <WireRowDetail entry={entry} onJumpTo={onJumpTo} />
          </div>
        ) : null}
      </div>
    </div>
  );
});

function PairIndicator({
  pair,
  onJumpTo,
}: {
  pair: PairHint;
  onJumpTo?: (lineNo: number) => void;
}) {
  const isCall = pair.kind === 'call';
  const target = isCall ? pair.resultLineNo : pair.callLineNo;
  const arrow = isCall ? '→' : '←';
  const orphan = target === null;
  const label = orphan ? `${arrow} ?` : `${arrow} #${target}`;
  const title = orphan
    ? isCall
      ? 'no matching tool.result yet'
      : 'no preceding tool.call seen'
    : isCall
      ? `jump to tool.result on line ${target}`
      : `jump to tool.call on line ${target}`;

  const className = `font-mono text-[10px] tabular ${
    orphan ? 'text-[var(--color-sev-error)]' : 'text-[var(--color-cat-tools)] hover:text-fg-0'
  }`;

  if (orphan || target === null || onJumpTo === undefined) {
    return (
      <span className={className} title={title}>
        {label}
      </span>
    );
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className={`${className} cursor-pointer`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onJumpTo(target);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.stopPropagation();
          onJumpTo(target);
        }
      }}
    >
      {label}
    </span>
  );
}

function formatTimeTitle(epochMs: number | undefined): string {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return 'missing time';
  const date = new Date(epochMs);
  if (!Number.isFinite(date.getTime())) return 'invalid time';
  return date.toISOString();
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      className={`text-fg-3 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="M3 2 L7 5 L3 8" stroke="currentColor" strokeWidth="1" fill="none" />
    </svg>
  );
}
