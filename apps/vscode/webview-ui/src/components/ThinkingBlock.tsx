import { useState } from "react";
import { IconChevronDown, IconLoader3, IconBulb } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { useSettingsStore } from "@/stores";

interface ThinkingBlockProps {
  content: string;
  finished?: boolean;
  compact?: boolean;
}

export function ThinkingBlock({ content, finished, compact }: ThinkingBlockProps) {
  const { extensionConfig } = useSettingsStore();
  const showThinkingContent = extensionConfig.showThinkingContent;

  const [expanded, setExpanded] = useState(extensionConfig.showThinkingExpanded);
  const isStreaming = !finished;

  if (!showThinkingContent) {
    // Hidden mode: static label, no interaction
    return (
      <div className="rounded-lg border border-zinc-200/50 bg-zinc-50/30 dark:border-zinc-800/50 dark:bg-zinc-900/10 overflow-hidden">
        <div
          className={cn("w-full flex items-center gap-2", compact ? "px-2 py-1.5" : "px-3 py-2")}
        >
          <div className="inline-flex items-center gap-2">
            <IconBulb className={cn("text-zinc-500", compact ? "size-3" : "size-3.5")} />
            <span className={cn("font-medium text-zinc-700 dark:text-zinc-300", compact ? "text-[0.75rem]" : "text-xs")}>Thinking</span>
            {isStreaming && <IconLoader3 className={cn("text-zinc-400 ml-auto animate-spin", compact ? "size-3" : "size-3.5")} />}
          </div>
        </div>
      </div>
    );
  }

  // Show mode: clickable, expandable/collapsible
  if (!content && !isStreaming) {
    return null;
  }

  return (
    <div className="rounded-lg border border-zinc-200/50 bg-zinc-50/30 dark:border-zinc-800/50 dark:bg-zinc-900/10 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className={cn("w-full flex items-center gap-2 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/20 transition-colors", compact ? "px-2 py-1.5" : "px-3 py-2")}
      >
        <div className="inline-flex items-center gap-2">
          <IconBulb className={cn("text-zinc-500", compact ? "size-3" : "size-3.5")} />
          <span className={cn("font-medium text-zinc-700 dark:text-zinc-300", compact ? "text-[0.75rem]" : "text-xs")}>Thinking</span>
          {isStreaming && <IconLoader3 className={cn("text-zinc-400 ml-auto animate-spin", compact ? "size-3" : "size-3.5")} />}
        </div>
        <IconChevronDown className={cn("text-zinc-400 ml-auto transition-transform", compact ? "size-3" : "size-3.5", expanded && "rotate-180")} />
      </button>

      {expanded && content && (
        <Markdown
          content={content}
          className={cn("border-t border-zinc-200/50 dark:border-zinc-700/50", compact ? "py-2 px-2 text-[0.75rem]" : "py-3 px-2 pl-3.5 text-xs")}
          enableEnrichment={finished}
        />
      )}
    </div>
  );
}
