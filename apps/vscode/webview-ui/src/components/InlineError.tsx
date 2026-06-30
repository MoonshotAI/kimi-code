import { IconAlertCircle, IconRefresh } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
interface InlineErrorProps {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

function formatErrorDetails(details?: Record<string, unknown>): string | null {
  if (!details) return null;
  const text = JSON.stringify(details);
  return text && text !== "{}" ? text : null;
}

export function InlineError({ error }: InlineErrorProps) {
  const { retryLastMessage, isStreaming } = useChatStore(
    useShallow((state) => ({
      retryLastMessage: state.retryLastMessage,
      isStreaming: state.isStreaming,
    })),
  );
  const details = formatErrorDetails(error.details);

  return (
    <div className={cn("flex items-center gap-2 px-3 py-2 mt-2 rounded-md", "bg-red-50 dark:bg-red-950/30", "border border-red-200 dark:border-red-900/50")}>
      <IconAlertCircle className="size-4 text-red-500 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-red-600 dark:text-red-400">{error.message}</div>
        {details && <div className="mt-0.5 text-[11px] text-red-500/80 dark:text-red-300/80 whitespace-pre-wrap wrap-break-word">{details}</div>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30"
        onClick={retryLastMessage}
        disabled={isStreaming}
      >
        <IconRefresh className="size-3.5 mr-1" />
        Retry
      </Button>
    </div>
  );
}
