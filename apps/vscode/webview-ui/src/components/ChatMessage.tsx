import { memo, useState } from "react";
import { IconLoader3 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Markdown } from "./Markdown";
import { DisplayToolCallCard } from "./ToolRenderers";
import { getDisplayPartCopyContent, type DisplayMediaPart, type DisplayMessage, type DisplayPart, type DisplayStep } from "@moonshot-ai/kimi-code-vscode-display-model";
import { CopyButton } from "./CopyButton";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompactionCard } from "./CompactionCard";
import { MediaThumbnail } from "./MediaThumbnail";
import { MediaPreviewModal } from "./MediaPreviewModal";
import { InlineError } from "./InlineError";
import { PlanBlock } from "./PlanBlock";
import { useChatStore } from "@/stores";

interface ChatMessageProps {
  message: DisplayMessage;
  isStreaming?: boolean;
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 mt-1 text-blue-500/80 py-1">
      <IconLoader3 className="size-3.5 animate-spin" />
      <span className="text-[11px] font-medium tracking-wide">Processing...</span>
    </div>
  );
}

function isVisibleDisplayPart(part: DisplayPart): boolean {
  return part.type !== "approval" && part.type !== "interrupt" && part.type !== "status";
}

function visibleDisplayParts(parts: DisplayPart[]): DisplayPart[] {
  return parts.filter(isVisibleDisplayPart);
}

function DisplayPartContent({ part, isStreaming }: { part: DisplayPart; isStreaming?: boolean }) {
  switch (part.type) {
    case "thinking":
      return <ThinkingBlock content={part.text} finished={part.finished} />;
    case "text":
      return <Markdown content={part.text} className="text-xs leading-relaxed" enableEnrichment={part.finished === true} />;
    case "media":
      return <DisplayMediaPartContent part={part} />;
    case "plan":
      return <PlanBlock entries={part.plan.entries} />;
    case "tool-call":
      return <DisplayToolCallCard part={part} />;
    case "compaction":
      return <CompactionCard part={part} />;
    case "error":
      return !isStreaming ? <InlineError error={part.error} /> : null;
    default:
      return null;
  }
}

function DisplayMediaPartContent({ part }: { part: DisplayMediaPart }) {
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);

  if (part.kind === "audio") {
    return <audio controls src={part.url} className="w-full max-w-sm" />;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 my-2">
        <MediaThumbnail src={part.url} size="md" onClick={() => setPreviewMedia(part.url)} />
      </div>
      <MediaPreviewModal src={previewMedia} onClose={() => setPreviewMedia(null)} />
    </>
  );
}

function copyTitleForDisplayPart(part: DisplayPart): string {
  switch (part.type) {
    case "thinking":
      return "Copy thinking";
    case "plan":
      return "Copy plan";
    case "tool-call":
      return "Copy tool call";
    case "media":
      return "Copy media";
    case "text":
      return "Copy text";
    default:
      return "Copy";
  }
}

function DisplayPartRenderer({ part, isStreaming }: { part: DisplayPart; isStreaming?: boolean }) {
  const copyContent = isStreaming ? null : getDisplayPartCopyContent(part);

  if (!copyContent) {
    return <DisplayPartContent part={part} isStreaming={isStreaming} />;
  }

  const copyTitle = copyTitleForDisplayPart(part);

  return (
    <div className="relative group/copycard">
      <DisplayPartContent part={part} isStreaming={isStreaming} />
      <CopyButton
        content={copyContent}
        title={copyTitle}
        ariaLabel={copyTitle}
        className="absolute top-1 right-1 z-10 opacity-0 transition-opacity group-hover/copycard:opacity-100 group-focus-within/copycard:opacity-100"
      />
    </div>
  );
}

function DisplayPartList({ parts, isStreaming, className }: { parts: DisplayPart[]; isStreaming?: boolean; className?: string }) {
  const visibleParts = visibleDisplayParts(parts);
  if (visibleParts.length === 0) {
    return null;
  }

  return (
    <div className={cn("[&>*:not(:last-child)]:mb-3", className)}>
      {visibleParts.map((part, idx) => (
        <DisplayPartRenderer key={`${part.type}-${idx}`} part={part} isStreaming={isStreaming} />
      ))}
    </div>
  );
}

function DisplayStepContent({ step, showConnector, isStreaming }: { step: DisplayStep; showConnector?: boolean; isStreaming?: boolean }) {
  const visibleParts = visibleDisplayParts(step.parts);
  const hasItems = visibleParts.length > 0;
  const hasToolOrThinking = visibleParts.some((item) => item.type !== "text");
  const showIndicator = hasToolOrThinking;
  const hasActiveItem = visibleParts.some((item) => item.type === "thinking" && !item.finished);

  if (!hasItems) {
    return null;
  }

  return (
    <div className="flex gap-2">
      {showIndicator ? (
        <div className="hidden @[420px]:flex shrink-0 w-5 flex-col items-center relative">
          <div
            className={cn("size-1.5 rounded-full mt-2 shrink-0 relative z-10", hasActiveItem ? "bg-blue-400 shadow-[0_0_8px_rgba(59,130,246,0.6)] animate-pulse" : "bg-blue-400")}
          />
          {showConnector && (
            <div
              className={cn(
                "absolute left-1/2 w-px",
                hasActiveItem ? "bg-gradient-to-b from-zinc-300 to-transparent dark:from-zinc-600 dark:to-transparent" : "bg-zinc-300 dark:bg-zinc-600",
              )}
              style={{ top: "calc(0.5rem + 0.1875rem)", bottom: "calc(-0.75rem - 0.5rem - 0.1875rem)", transform: "translateX(-50%)" }}
            />
          )}
        </div>
      ) : (
        <div className="hidden @[420px]:block shrink-0 w-5" />
      )}
      <div className="flex-1 min-w-0 space-y-2">
        {visibleParts.map((part, idx) => (
          <DisplayPartRenderer key={`${step.n}-${idx}`} part={part} isStreaming={isStreaming} />
        ))}
      </div>
    </div>
  );
}

function userTextFromDisplayParts(parts: DisplayPart[]): string {
  return parts
    .filter((part): part is Extract<DisplayPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function userMediaFromDisplayParts(parts: DisplayPart[]): DisplayMediaPart[] {
  return parts.filter((part): part is DisplayMediaPart => part.type === "media");
}

function UserMessage({ message }: { message: DisplayMessage }) {
  const displayContent = userTextFromDisplayParts(message.parts);
  const mediaParts = userMediaFromDisplayParts(message.parts);

  if (!displayContent && mediaParts.length === 0) {
    return null;
  }

  return (
    <div className="px-3 pt-3 pb-1 flex justify-end">
      <div className={cn("max-w-[85%] px-3.5 py-1.5 rounded-2xl rounded-br-md", "bg-zinc-100 dark:bg-zinc-800", "text-foreground")}>
        {displayContent && (
          <div className="text-xs leading-relaxed whitespace-pre-wrap wrap-break-word">
            <Markdown content={displayContent} enableEnrichment />
          </div>
        )}
        {mediaParts.map((part, idx) => (
          <DisplayMediaPartContent key={`${part.kind}-${idx}`} part={part} />
        ))}
      </div>
    </div>
  );
}

function AssistantMessage({ message, isStreaming }: { message: DisplayMessage; isStreaming?: boolean }) {
  const isCompacting = useChatStore((state) => state.displayState.isCompacting);

  const steps = message.steps ?? [];
  const topLevelParts = visibleDisplayParts(message.parts);
  const hasSteps = steps.some((step) => visibleDisplayParts(step.parts).length > 0);

  const stepHasIndicator = steps.map((step) => visibleDisplayParts(step.parts).some((item) => item.type !== "text"));

  if (!isStreaming && !hasAssistantContent(message)) {
    return null;
  }

  const hasActiveStreaming =
    isStreaming &&
    (topLevelParts.some((item) => (item.type === "text" || item.type === "thinking") && !item.finished) ||
      steps.some((step) => visibleDisplayParts(step.parts).some((item) => (item.type === "text" || item.type === "thinking") && !item.finished)));

  return (
    <div className="@container px-3 py-3 group/message">
      <div className="flex gap-3 flex-col">
        <div className="flex flex-row items-center justify-start gap-2">
          <div className="shrink-0 size-5 rounded flex items-center justify-center text-[10px] font-medium bg-blue-500 text-white">K</div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Kimi</div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-col">
            <div className="[&>*:not(:last-child)]:mb-3">
              {topLevelParts.length > 0 && <DisplayPartList parts={topLevelParts} isStreaming={isStreaming} className="@[420px]:pl-5" />}
              {hasSteps &&
                steps.map((step, idx) => {
                  const hasNextIndicator = stepHasIndicator.slice(idx + 1).some(Boolean);
                  const showConnector = stepHasIndicator[idx] && hasNextIndicator;
                  return <DisplayStepContent key={step.id} step={step} showConnector={showConnector} isStreaming={isStreaming} />;
                })}
            </div>

            <div className="flex flex-row items-center space-between">
              <div className="inline-flex flex-1">{hasActiveStreaming && !isCompacting && <ThinkingIndicator />}</div>
              <div className="inline-flex flex-1" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function hasAssistantContent(message: DisplayMessage): boolean {
  if (visibleDisplayParts(message.parts).length > 0) {
    return true;
  }

  return message.steps?.some((step) => visibleDisplayParts(step.parts).length > 0) ?? false;
}

export const ChatMessage = memo(function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessage message={message} isStreaming={isStreaming} />;
  }
  return null;
});
