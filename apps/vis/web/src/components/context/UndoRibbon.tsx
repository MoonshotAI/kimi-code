import type { ProjectedMessage } from '../../types';

interface UndoRibbonProps {
  /** The synthetic undo-marker message emitted by the projector
   *  (`source === 'undo'`). */
  message: ProjectedMessage;
}

/**
 * Horizontal ribbon that marks where a `context.undo` record spliced earlier
 * prompts out of the conversation. Receives the `ProjectedMessage` whose
 * `source === 'undo'` so we can show how many prompts / messages were removed.
 */
export function UndoRibbon({ message }: UndoRibbonProps) {
  const count = message.undo?.count ?? 0;
  const removed = message.undo?.removedMessageCount ?? 0;
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--color-sev-warning)] opacity-50" />
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-sev-warning)]">
        undid {count} prompt{count === 1 ? '' : 's'} · {removed} message{removed === 1 ? '' : 's'} removed · line {message.lineNo}
      </span>
      <span className="h-px flex-1 bg-[var(--color-sev-warning)] opacity-50" />
    </div>
  );
}
