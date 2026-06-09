import { useState, useRef, useLayoutEffect, useMemo, useEffect } from "react";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { useChatStore } from "@/stores";
import { DisplayBlocks } from "./DisplayBlocks";
import { cn } from "@/lib/utils";
import { displayBlocksToLegacy } from "@/lib/display-block-adapter";
import type { DisplayApprovalOption } from "@moonshot-ai/kimi-code-vscode-display-model";
import type { ApprovalResponse } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";

type DialogOption =
  | { type: "legacy"; key: ApprovalResponse; label: string; index: number }
  | { type: "dynamic"; option: DisplayApprovalOption; index: number };

function ApprovalDialogContent() {
  const { pending, respondApproval } = useChatStore(
    useShallow((state) => ({
      pending: state.displayState.pendingApprovals,
      respondApproval: state.respondApproval,
    })),
  );
  const [selectedIndex, setSelectedIndex] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedRect, setCollapsedRect] = useState<{
    height: number;
    bottom: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (!expanded && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setCollapsedRect({
        height: rect.height,
        bottom: window.innerHeight - rect.bottom,
      });
    }
  }, [expanded, pending]);

  const req = pending[0];
  const hasDisplay = req.displayBlocks && req.displayBlocks.length > 0;

  const handleLegacyResponse = async (response: ApprovalResponse) => {
    await respondApproval(req.requestId, response);
    setSelectedIndex(1);
    setExpanded(false);
  };

  const handleDynamicResponse = async (optionId: string) => {
    await respondApproval(req.requestId, { optionId });
    setSelectedIndex(1);
    setExpanded(false);
  };

  const options: DialogOption[] = useMemo(() => {
    if (req.options && req.options.length > 0) {
      return req.options.map((option, idx) => ({ type: "dynamic", option, index: idx + 1 }));
    }
    return [
      { type: "legacy", key: "approve", label: "Allow once", index: 1 },
      { type: "legacy", key: "approve_for_session", label: "Allow always", index: 2 },
      { type: "legacy", key: "reject", label: "Reject", index: 3 },
    ];
  }, [req.options]);

  const selectOption = (opt: DialogOption) => (opt.type === "dynamic" ? handleDynamicResponse(opt.option.optionId) : handleLegacyResponse(opt.key));

  // Keyboard interaction: number keys jump straight to an option (mirrors the
  // CLI), arrows move the highlight, Enter confirms it. Ignore keys typed into
  // the message input so composing a queued message never triggers approval.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
        return;
      }

      if (e.key >= "1" && e.key <= "9") {
        const opt = options[Number(e.key) - 1];
        if (opt) {
          e.preventDefault();
          void selectOption(opt);
        }
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(i + 1, options.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(i - 1, 1));
      } else if (e.key === "Enter") {
        const opt = options[selectedIndex - 1];
        if (opt) {
          e.preventDefault();
          void selectOption(opt);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // selectOption closes over req/options; re-bind when the pending request changes.
  }, [options, selectedIndex, req.requestId]);

  const title = req.options && req.options.length > 0 ? "Review this request?" : `Allow this ${req.action.toLowerCase()}?`;

  const content = (
    <div className="p-2 space-y-2 flex-1 min-h-0 overflow-hidden flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        {hasDisplay && (
          <button onClick={() => setExpanded(!expanded)} className="p-1 hover:bg-muted rounded transition-colors">
            {expanded ? <IconChevronDown className="size-4 text-muted-foreground" /> : <IconChevronUp className="size-4 text-muted-foreground" />}
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-2">
        <div className="text-xs text-foreground/90 break-all leading-relaxed bg-muted/30 py-2 px-2 rounded">{req.description}</div>

        {hasDisplay && <DisplayBlocks blocks={displayBlocksToLegacy(req.displayBlocks)} maxHeight={expanded ? "max-h-none" : "max-h-24"} />}

        <div className="text-xs text-muted-foreground">{req.sender}</div>
      </div>

      <div className="space-y-2 pt-1 shrink-0">
        {options.map((opt) => {
          const key = opt.type === "dynamic" ? opt.option.optionId : opt.key;
          const label = opt.type === "dynamic" ? opt.option.name : opt.label;
          return (
            <button
              key={key}
              onClick={() => selectOption(opt)}
              onMouseEnter={() => setSelectedIndex(opt.index)}
              className={cn(
                "w-full text-left px-2 py-1 rounded-md text-xs transition-colors",
                "border border-border cursor-pointer",
                selectedIndex === opt.index ? "bg-blue-500 text-white border-blue-500" : "bg-background hover:bg-muted/50",
              )}
            >
              <span className={cn("mr-2", selectedIndex === opt.index ? "text-blue-200" : "text-muted-foreground")}>{opt.index}</span>
              <span className="font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  if (expanded && collapsedRect) {
    return (
      <>
        <div style={{ height: collapsedRect.height }} className="mx-2 mb-1 shrink-0" />
        <div
          style={{ bottom: collapsedRect.bottom }}
          className="fixed left-2 right-2 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col z-50 max-h-[70vh]"
        >
          {content}
        </div>
      </>
    );
  }

  return (
    <div ref={containerRef} className="mx-2 mb-0.5 border border-blue-200 dark:border-blue-800 rounded-lg overflow-hidden bg-background flex flex-col shrink-0 max-h-80">
      {content}
    </div>
  );
}

export function ApprovalDialog() {
  const hasPending = useChatStore((state) => state.displayState.pendingApprovals.length > 0);
  if (!hasPending) return null;
  return <ApprovalDialogContent />;
}
