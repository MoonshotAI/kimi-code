import { IconBulb } from "@tabler/icons-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ThinkingMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

interface ThinkingButtonProps {
  mode: ThinkingMode;
  enabled: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function ThinkingButton({ mode, enabled, disabled, onToggle }: ThinkingButtonProps) {
  // Don't render if model doesn't support thinking
  if (mode === "none") {
    return null;
  }

  const isAlwaysOn = mode === "always";
  const isActive = enabled || isAlwaysOn;
  const canClick = mode === "switch" && !disabled;

  const tooltipText = isAlwaysOn ? "Thinking is always enabled for this model" : enabled ? "Thinking enabled" : "Enable thinking";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={canClick ? onToggle : undefined}
          disabled={!canClick}
          className={cn(
            "flex items-center justify-center size-6 rounded-md transition-all",
            isActive ? "bg-blue-500/15 text-blue-500" : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
            !canClick && "cursor-default",
            canClick && "cursor-pointer hover:bg-blue-500/25",
          )}
        >
          <IconBulb className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltipText}</TooltipContent>
    </Tooltip>
  );
}
