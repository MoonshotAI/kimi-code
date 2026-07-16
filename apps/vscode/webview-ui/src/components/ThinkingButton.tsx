import { IconBulb, IconCheck } from "@tabler/icons-react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { ThinkingMode } from "shared/legacy-sdk";

interface ThinkingButtonProps {
  mode: ThinkingMode;
  effort: string;
  efforts?: string[];
  alwaysOn?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onSelectEffort: (effort: string) => void;
}

function label(effort: string): string {
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

export function ThinkingButton({ mode, effort, efforts = [], alwaysOn = false, disabled, onToggle, onSelectEffort }: ThinkingButtonProps) {
  if (mode === "none") return null;

  const active = effort !== "off" || alwaysOn;
  const button = (
    <button
      type="button"
      onClick={mode === "switch" && !disabled ? onToggle : undefined}
      disabled={disabled || mode === "always"}
      className={cn(
        "flex items-center gap-0.5 justify-center h-6 min-w-6 px-1 rounded-md transition-all",
        active ? "bg-blue-500/15 text-blue-500" : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
        !disabled && mode !== "always" && "cursor-pointer hover:bg-blue-500/25",
        (disabled || mode === "always") && "cursor-default",
      )}
    >
      <IconBulb className="size-4" />
      {mode === "effort" && <span className="text-[9px] font-medium leading-none">{label(effort)}</span>}
    </button>
  );

  if (mode === "effort") {
    const options = alwaysOn ? efforts : ["off", ...efforts];
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild disabled={disabled}>{button}</DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>Thinking effort: {label(effort)}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="start">
          {options.map((option) => (
            <DropdownMenuItem key={option} onClick={() => onSelectEffort(option)} className="text-xs gap-2">
              <IconCheck className={cn("size-3", option !== effort && "opacity-0")} />
              {label(option)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const tooltip = mode === "always" ? "Thinking is always enabled for this model" : active ? "Thinking enabled" : "Enable thinking";
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
