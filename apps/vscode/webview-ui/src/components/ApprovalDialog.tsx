import { useState, useEffect } from "react";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useApprovalStore } from "@/stores";
import { DisplayBlocks } from "./DisplayBlocks";
import { cn } from "@/lib/utils";
import type { ApprovalResponse } from "shared/legacy-sdk";

export function ApprovalDialog() {
  const { pending, respondToRequest } = useApprovalStore();
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [expanded, setExpanded] = useState(false);

  const req = pending[0];

  // Auto-expand if there's a diff block (code change)
  useEffect(() => {
    if (req) {
      const hasDiff = req.display?.some((b) => b.type === "diff") ?? false;
      setExpanded(hasDiff);
    }
  }, [req?.id]);

  if (!req) return null;
  const hasDisplay = req.display && req.display.length > 0;

  const handleResponse = async (response: ApprovalResponse) => {
    await respondToRequest(req.id, response);
    setSelectedIndex(1);
    setExpanded(false);
  };

  const options = [
    { key: "approve", label: "Yes", index: 1 },
    { key: "approve_for_session", label: "Yes, for this session", index: 2 },
    { key: "reject", label: "No", index: 3 },
  ] as const;

  return (
    <div className={cn("mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink")}>
      <div className="p-2 space-y-2 flex-1 min-h-0 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between shrink-0">
          <div className="text-xs font-semibold text-foreground">Allow this {req.action.toLowerCase()}?</div>
          {hasDisplay && (
            <button onClick={() => setExpanded(!expanded)} className="p-1 hover:bg-muted rounded transition-colors">
              {expanded ? <IconChevronDown className="size-4 text-muted-foreground" /> : <IconChevronUp className="size-4 text-muted-foreground" />}
            </button>
          )}
        </div>

        <div className="text-xs text-foreground/90 break-all leading-relaxed bg-muted/30 py-2 px-2 rounded shrink-0 max-h-20 overflow-y-auto font-mono">{req.description}</div>

        {hasDisplay && (
          <div className={cn("overflow-y-auto", expanded ? "flex-1 min-h-0" : "max-h-24")}>
            <DisplayBlocks blocks={req.display} maxHeight={expanded ? "max-h-none" : "max-h-20"} />
          </div>
        )}

        <div className="text-xs text-muted-foreground shrink-0">{req.sender}</div>

        <div className="space-y-1.5 pt-1 shrink-0">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => {
                void handleResponse(opt.key);
              }}
              onMouseEnter={() => setSelectedIndex(opt.index)}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border border-border cursor-pointer",
                selectedIndex === opt.index ? "bg-blue-500 text-white border-blue-500" : "bg-background hover:bg-muted/50",
              )}
            >
              <span className={cn("mr-2", selectedIndex === opt.index ? "text-blue-200" : "text-muted-foreground")}>{opt.index}</span>
              <span className="font-medium">{opt.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
