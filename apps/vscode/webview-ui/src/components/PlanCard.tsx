import { type ReactNode, useState } from "react";
import { IconClipboardList, IconChevronDown } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface PlanCardProps {
  children: ReactNode;
}

export function PlanCard({ children }: PlanCardProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="my-2 rounded-lg border border-amber-300/50 dark:border-amber-700/50 bg-amber-50/30 dark:bg-amber-950/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1.5 w-full px-3 py-1.5 bg-amber-100/50 dark:bg-amber-900/30 border-b border-amber-300/50 dark:border-amber-700/50 cursor-pointer hover:bg-amber-100/80 dark:hover:bg-amber-900/50 transition-colors"
      >
        <IconClipboardList className="size-3.5 text-amber-600 dark:text-amber-400" />
        <span className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 flex-1 text-left">Plan Mode</span>
        <IconChevronDown className={cn("size-3.5 text-amber-600 dark:text-amber-400 transition-transform", collapsed && "-rotate-90")} />
      </button>
      {!collapsed && (
        <div className="px-1 py-1 [&>*:not(:last-child)]:mb-3">
          {children}
        </div>
      )}
    </div>
  );
}
