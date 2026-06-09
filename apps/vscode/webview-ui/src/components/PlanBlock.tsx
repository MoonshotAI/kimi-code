import { IconCircleCheck, IconCircleDashed, IconLoader3 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { PlanEntry } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";

interface PlanBlockProps {
  entries: PlanEntry[];
}

export function PlanBlock({ entries }: PlanBlockProps) {
  if (!entries || entries.length === 0) {
    return null;
  }

  return (
    <div className="text-xs border border-border rounded-md overflow-hidden bg-muted/20">
      {entries.map((entry, idx) => {
        const completed = entry.status === "completed";
        const active = entry.status === "in_progress";

        return (
          <div key={idx} className={cn("px-2 py-1.5 flex items-start gap-2", idx !== entries.length - 1 && "border-b border-border/50")}>
            {completed ? (
              <IconCircleCheck className="size-3.5 mt-0.5 shrink-0 text-emerald-500" />
            ) : active ? (
              <IconLoader3 className="size-3.5 mt-0.5 shrink-0 text-blue-500 animate-spin" />
            ) : (
              <IconCircleDashed className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
            )}
            <span className={cn("flex-1 min-w-0 break-words", completed && "text-muted-foreground line-through")}>{entry.content}</span>
            {entry.priority && <span className="shrink-0 text-[10px] uppercase text-muted-foreground">{entry.priority}</span>}
          </div>
        );
      })}
    </div>
  );
}
