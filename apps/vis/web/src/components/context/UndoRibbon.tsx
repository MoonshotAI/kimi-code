import type { ProjectedMessage } from '../../types';

interface UndoRibbonProps {
  message: ProjectedMessage;
}

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
