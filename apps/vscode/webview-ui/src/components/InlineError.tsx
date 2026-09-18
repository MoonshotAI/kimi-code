import { IconAlertCircle, IconArrowsMinimize, IconRefresh } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import { isContextOverflowError } from "shared/errors";
import type { InlineError as InlineErrorType } from "../stores/chat.store";

interface InlineErrorProps {
  error: InlineErrorType;
}

export function InlineError({ error }: InlineErrorProps) {
  const { retryLastMessage, compactAndRetry, isStreaming, isCompacting } = useChatStore();

  // 如果 detail 和 message 不同，则显示详细错误信息
  const showDetail = error.detail && error.detail !== error.message;
  // context.overflow means the engine's auto-compaction already gave up; a
  // plain Retry would resend into the same wall, so offer compact-then-retry.
  const canCompact = isContextOverflowError(error.code);
  const busy = isStreaming || isCompacting;

  return (
    <div className={cn("flex flex-col gap-1 px-3 py-2 mt-2 rounded-md", "bg-red-50 dark:bg-red-950/30", "border border-red-200 dark:border-red-900/50")}>
      <div className="flex items-center gap-2">
        <IconAlertCircle className="size-4 text-red-500 shrink-0" />
        <span className="text-xs text-red-600 dark:text-red-400 flex-1">{error.message}</span>
        {canCompact && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
            onClick={() => { void compactAndRetry(); }}
            disabled={busy}
          >
            <IconArrowsMinimize className="size-3.5 mr-1" />
            {isCompacting ? "Compacting..." : "Compact & Retry"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
          onClick={retryLastMessage}
          disabled={busy}
        >
          <IconRefresh className="size-3.5 mr-1" />
          Retry
        </Button>
      </div>
      {showDetail && <div className="text-[10px] text-red-500/70 dark:text-red-400/70 pl-6 font-mono break-all">{error.detail}</div>}
    </div>
  );
}
