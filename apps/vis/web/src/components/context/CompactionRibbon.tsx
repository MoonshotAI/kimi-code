import type { ProjectedMessage } from '../../types';

interface CompactionRibbonProps {
  /** The synthetic compaction-summary message emitted by the projector. */
  message: ProjectedMessage;
}

/**
 * Horizontal ribbon that marks where a `context.apply_compaction` record
 * collapsed earlier messages into a single summary. Receives the
 * `ProjectedMessage` whose `source === 'compaction_summary'` so we can
 * render the summary text inline.
 */
export function CompactionRibbon({ message }: CompactionRibbonProps) {
  const summary = extractSummary(message);
  const stats = message.compaction;
  return (
    <div className="my-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-[var(--color-compaction)] opacity-50" />
        <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-compaction)]">
          prior context compacted · line {message.lineNo}
        </span>
        <span className="h-px flex-1 bg-[var(--color-compaction)] opacity-50" />
      </div>
      {stats ? (
        <div className="text-center font-mono text-[10.5px] text-fg-3">
          {stats.compactedCount} msgs · {stats.tokensBefore.toLocaleString()}→
          {stats.tokensAfter.toLocaleString()} tok
        </div>
      ) : null}
      {summary.length > 0 ? (
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-fg-2">
          {summary}
        </pre>
      ) : null}
    </div>
  );
}

function extractSummary(message: ProjectedMessage): string {
  for (const part of message.message.content) {
    if (part.type === 'text') return part.text;
  }
  return '';
}
