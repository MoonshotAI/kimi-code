import type { ProjectedMessage } from '../../types';

interface ClearRibbonProps {
  message: ProjectedMessage;
}

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
