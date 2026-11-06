import * as React from "react";
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconLoader3,
  IconMessageQuestion,
} from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./accordion";

export type ActivityDisclosureStatus = "working" | "complete" | "input_needed" | "stopped";

interface ActivityDisclosureProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ActivityDisclosureStatus;
  stepCount: number;
  triggerRef?: React.Ref<HTMLButtonElement>;
  contentRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
  className?: string;
}

function Status({ status }: { status: ActivityDisclosureStatus }) {
  if (status === "working") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-blue-600 dark:text-blue-400">
        <IconLoader3 aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
        <span>Working…</span>
      </span>
    );
  }
  if (status === "input_needed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
        <IconMessageQuestion aria-hidden className="size-3.5" />
        <span>Input needed</span>
      </span>
    );
  }
  if (status === "stopped") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-destructive">
        <IconAlertCircle aria-hidden className="size-3.5" />
        <span>Work stopped</span>
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center text-emerald-600 dark:text-emerald-400">
      <IconCheck aria-hidden className="size-3.5" />
      <span className="sr-only">Work complete</span>
    </span>
  );
}

/** Shared disclosure for chronological background activity such as tool calls and progress. */
export function ActivityDisclosure({
  open,
  onOpenChange,
  status,
  stepCount,
  triggerRef,
  contentRef,
  children,
  className,
}: ActivityDisclosureProps) {
  return (
    <Accordion
      type="single"
      collapsible
      value={open ? "activity" : ""}
      onValueChange={(value) => onOpenChange(value === "activity")}
      className={cn("rounded-lg border border-border/70 bg-muted/20 overflow-hidden", className)}
    >
      <AccordionItem value="activity" className="border-0!">
        <AccordionTrigger
          ref={triggerRef}
          className={cn(
            "min-h-11 w-full items-center gap-2 rounded-none border-0 px-3 py-2 text-xs hover:no-underline hover:bg-muted/60",
            "active:bg-muted focus-visible:relative focus-visible:z-10 focus-visible:ring-inset focus-visible:ring-ring",
            "[&>[data-slot=accordion-trigger-icon]]:hidden",
          )}
        >
          <span className="min-w-0 flex-1 truncate font-medium">Work details</span>
          <span className="shrink-0 text-[11px] font-normal text-muted-foreground">
            {stepCount} {stepCount === 1 ? "step" : "steps"}
          </span>
          <Status status={status} />
          <IconChevronDown
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </AccordionTrigger>
        <AccordionContent
          forceMount
          className="border-t border-border/70 px-3 py-3"
        >
          <div ref={contentRef}>{children}</div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
