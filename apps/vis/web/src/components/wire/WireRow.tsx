import { memo } from 'react';

import type { WireEntry } from '../../types';
import { formatWallClock } from '../../util/time';
import { TypeBadge } from './TypeBadge';
import { renderHeadline } from './WireHeadline';
import { WireRowDetail } from './WireRowDetail';

interface WireRowProps {
  entry: WireEntry;
  expanded: boolean;
  onToggle: () => void;
  /** Scroll to a line and expand it — wired by the Wire tab via the virtualizer. */
  onJumpTo?: (lineNo: number) => void;
}

export const WireRow = memo(function WireRow({
  entry,
  expanded,
  onToggle,
  onJumpTo,
}: WireRowProps) {
  const record = entry.data;
  const h = renderHeadline(record);
  const timeTitle = formatTimeTitle(record.time);

  return (
    <div
      className={[
        'flex items-stretch border-b border-border',
        expanded ? 'bg-surface-1' : 'bg-surface-0 hover:bg-surface-1',
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
