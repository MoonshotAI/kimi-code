import type { ProjectedMessage } from '../../types';

interface ClearRibbonProps {
  /** The synthetic clear-marker message emitted by the projector in
   *  full-history mode (`source === 'clear'`). */
  message: ProjectedMessage;
}

/**
 * Horizontal ribbon that marks where a `context.clear` record wiped the
 * conversation. Only appears in full-history mode — in the model view the
 * messages before the clear are simply gone. Styled to match
 * `CompactionRibbon` / `UndoRibbon` (flanking `h-px` rules + a centered mono
 * uppercase label), using the warning tone.
 */
export function ClearRibbon({ message }: ClearRibbonProps) {
  return (
    <div className="my-3 flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--color-sev-warning)] opacity-50" />
      <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-sev-warning)]">
        context cleared · line {message.lineNo}
      </span>
      <span className="h-px flex-1 bg-[var(--color-sev-warning)] opacity-50" />
    </div>
  );
}
