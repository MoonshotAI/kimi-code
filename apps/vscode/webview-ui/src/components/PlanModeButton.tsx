import { IconClipboardList } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface PlanModeButtonProps {
  active: boolean;
  onToggle: () => void;
}

export function PlanModeButton({ active, onToggle }: PlanModeButtonProps) {
  const tooltipText = active ? "Plan mode active (click to exit)" : "Enter plan mode";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          className={cn(
            "flex items-center justify-center size-6 rounded-md transition-all cursor-pointer",
            active
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400 hover:bg-amber-500/25"
              : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <IconClipboardList className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
