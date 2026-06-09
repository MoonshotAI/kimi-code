import { IconLoader2 } from "@tabler/icons-react";
import type { DisplayCompactionPart } from "@moonshot-ai/kimi-code-vscode-display-model";

interface CompactionCardProps {
  part: DisplayCompactionPart;
}

function formatTokenCount(count?: number): string | null {
  return typeof count === "number" ? count.toLocaleString("en-US") : null;
}

export function CompactionCard({ part }: CompactionCardProps) {
  const isCompacting = part.status === "running";
  const tokensBefore = formatTokenCount(part.tokensBefore);
  const tokensAfter = formatTokenCount(part.tokensAfter);
  const detail = part.message ?? part.summary ?? part.instruction;
  const tokenDetail = tokensBefore && tokensAfter ? `${tokensBefore} → ${tokensAfter} tokens` : null;

  return (
    <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2.5">
        {isCompacting ? (
          <IconLoader2 className="size-4 text-blue-500 animate-spin" />
        ) : (
          <div className="size-4 flex items-center justify-center">
            <div className="size-2 rounded-full bg-emerald-500" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground">{isCompacting ? "Compacting context..." : "Context compacted"}</div>
          {detail && <div className="mt-0.5 text-[11px] text-muted-foreground whitespace-pre-wrap wrap-break-word">{detail}</div>}
          {tokenDetail && <div className="mt-0.5 text-[11px] text-muted-foreground">{tokenDetail}</div>}
        </div>
      </div>
    </div>
  );
}
