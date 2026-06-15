import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import { useShallow } from "zustand/react/shallow";

export function ChatStatus() {
  const { status } = useChatStore(
    useShallow((state) => ({
      status: state.displayState.status,
    })),
  );

  const contextTokens = status?.contextTokens ?? null;
  const maxContextTokens = status?.maxContextTokens ?? null;
  const derivedContextUsage = contextTokens !== null && maxContextTokens && maxContextTokens > 0 ? contextTokens / maxContextTokens : undefined;
  const contextUsage = status?.contextUsage ?? derivedContextUsage;

  // See docs/context-usage-snapshot-fix.md: without an ACP usage snapshot,
  // missing context data would render as a misleading default "0%".
  if (contextUsage === undefined || contextUsage === null) {
    return null;
  }

  const safeContextUsage = Number.isFinite(contextUsage) ? contextUsage : 0;
  const contextPercent = Math.round(safeContextUsage * 1000) / 10;
  const contextTitle =
    contextTokens !== null || maxContextTokens !== null
      ? `Context Window Usage (${contextTokens?.toLocaleString() ?? "--"} / ${maxContextTokens?.toLocaleString() ?? "--"} tokens)`
      : "Context Window Usage";

  return (
    <div
      className="flex h-6 shrink-0 items-center px-1 text-[11px] text-muted-foreground select-none"
      title={contextTitle}
    >
      <span className={cn(contextPercent > 80 && "text-amber-500", contextPercent > 95 && "text-destructive")}>{contextPercent}%</span>
    </div>
  );
}
