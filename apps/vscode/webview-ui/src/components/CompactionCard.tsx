import { IconLoader2 } from "@tabler/icons-react";
import { useChatStore } from "@/stores";

export function CompactionCard() {
  const { isCompacting } = useChatStore();

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
        </div>
      </div>
    </div>
  );
}
