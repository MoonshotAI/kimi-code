import { useState, Fragment } from "react";
import { IconLoader3, IconGitFork } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Content } from "@/lib/content";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolRenderers";
import { CopyButton } from "./CopyButton";
import { ThinkingBlock } from "./ThinkingBlock";
import { CompactionCard } from "./CompactionCard";
import { MediaThumbnail } from "./MediaThumbnail";
import { MediaPreviewModal } from "./MediaPreviewModal";
import { InlineError } from "./InlineError";
import { PlanCard } from "./PlanCard";
import { StreamingConfirmDialog } from "./StreamingConfirmDialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useChatStore } from "@/stores";
import { bridge } from "@/services";
import type { ChatMessage as ChatMessageType, UIStep, UIStepItem } from "@/stores/chat.store";
import type { ContentPart } from "shared/legacy-sdk";

interface ChatMessageProps {
  message: ChatMessageType;
  /** 0-indexed turn number for this message */
  turnIndex?: number;
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

function SteerBubble({ content }: { content: string | ContentPart[] }) {
  const text = typeof content === "string" ? content : Content.getText(content);
  return (
    <div className="flex justify-end my-1">
      <div className="max-w-[85%] px-3 py-1 rounded-2xl rounded-br-md bg-zinc-100 dark:bg-zinc-800 text-foreground">
        <p className="text-xs leading-relaxed">{text}</p>
      </div>
    </div>
  );
}

function StepItemRenderer({ item }: { item: UIStepItem }) {
  switch (item.type) {
    case "thinking":
      return <ThinkingBlock content={item.content} finished={item.finished} />;
    case "text":
      return <Markdown content={item.content} className="text-xs leading-relaxed" enableEnrichment={item.finished === true} />;
    case "tool_use":
      return <ToolCallCard call={item.call} result={item.result} subagentSteps={item.subagent_steps} />;
    case "compaction":
      return <CompactionCard />;
    case "steer":
      return <SteerBubble content={item.content} />;
    default:
      return null;
  }
}

function StepContent({ step, showConnector }: { step: UIStep; showConnector?: boolean }) {
  const hasItems = step.items.length > 0;
  const hasToolOrThinking = step.items.some((item) => item.type === "tool_use" || item.type === "thinking" || item.type === "compaction");
  const showIndicator = hasToolOrThinking;
  const hasActiveItem = step.items.some((item) => (item.type === "text" || item.type === "thinking") && !item.finished);

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
        {step.items.map((item, idx) => (
          <StepItemRenderer key={`${step.n}-${idx}`} item={item} />
        ))}
      </div>
    </div>
  );
}

function MessageMedia({ images, videos, onPreview }: { images: string[]; videos: string[]; onPreview: (src: string) => void }) {
  if (images.length === 0 && videos.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2 my-2">
      {images.map((src, idx) => (
        <MediaThumbnail key={`img-${idx}`} src={src} size="md" onClick={() => onPreview(src)} />
      ))}
      {videos.map((src, idx) => (
        <MediaThumbnail key={`vid-${idx}`} src={src} size="md" onClick={() => onPreview(src)} />
      ))}
    </div>
  );
}

interface StepGroup {
  planMode: boolean;
  steps: UIStep[];
  startIndex: number;
}

function groupStepsByPlanMode(steps: UIStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (let i = 0; i < steps.length; i++) {
    const isPlan = steps[i].planMode === true;
    const last = groups.at(-1);
    if (last && last.planMode === isPlan) {
      last.steps.push(steps[i]);
    } else {
      groups.push({ planMode: isPlan, steps: [steps[i]], startIndex: i });
    }
  }
  return groups;
}

interface ForkButtonProps {
  turnIndex: number;
  className?: string;
}

function ForkButton({ turnIndex, className }: ForkButtonProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isForking, setIsForking] = useState(false);
  const { sessionId, isStreaming, loadSession } = useChatStore();

  const handleFork = () => {
    if (!sessionId || turnIndex < 0) return;
    setShowConfirm(true);
  };

  const doFork = async () => {
    if (!sessionId) return;

    setIsForking(true);
    try {
      const result = await bridge.forkSession(sessionId, turnIndex);
      if (result) {
        // Load the forked session
        const events = await bridge.loadSessionHistory(result.sessionId);
        await loadSession(result.sessionId, events);
      }
    } catch (error) {
      toast.error(`Failed to fork conversation: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsForking(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={cn(
          "h-5 w-5 text-muted-foreground hover:text-foreground transition-all border-0! hover:bg-zinc-200 dark:hover:bg-zinc-800 cursor-pointer",
          isForking && "opacity-50 pointer-events-none",
          className,
        )}
        onClick={handleFork}
        disabled={isForking || !sessionId}
        title="Fork conversation from this point"
      >
        <IconGitFork className="size-3.5" />
      </Button>

      <StreamingConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Fork Conversation"
        description={
          isStreaming
            ? "The current conversation is still generating a response. Forking will stop the generation and create a new conversation from this point. Continue?"
            : "This will create a new conversation branching from this point. All messages after this turn will be removed in the forked conversation. Continue?"
        }
        confirmLabel="Fork"
        onConfirm={() => { void doFork(); }}
        confirmLoading={isForking}
        confirmDisabled={isForking}
        cancelDisabled={isForking}
      />
    </>
  );
}

function UserMessage({ message }: { message: ChatMessageType }) {
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);
  const displayContent = Content.getText(message.content);
  const images = Content.getImages(message.content);
  const videos = Content.getVideos(message.content);

  return (
    <div className="px-3 pt-3 pb-1 flex justify-end">
      <div className={cn("max-w-[85%] px-3.5 py-1.5 rounded-2xl rounded-br-md", "bg-zinc-100 dark:bg-zinc-800", "text-foreground")}>
        {displayContent && (
          // FIX: removed whitespace-pre-wrap — it conflicted with ReactMarkdown's
          // block-level elements (<p>, <ol>, <li>), doubling vertical spacing.
          // ReactMarkdown already handles paragraph breaks from \n\n.
          <div className="text-xs leading-relaxed wrap-break-word">
            <Markdown content={displayContent} enableEnrichment enableLocalImageRender={false} />
          </div>
        )}
        <MessageMedia images={images} videos={videos} onPreview={setPreviewMedia} />
      </div>
      <MediaPreviewModal src={previewMedia} onClose={() => setPreviewMedia(null)} />
    </div>
  );
}

function AssistantMessage({ message, turnIndex, isStreaming }: { message: ChatMessageType; turnIndex?: number; isStreaming?: boolean }) {
  const [previewMedia, setPreviewMedia] = useState<string | null>(null);
  const { isCompacting } = useChatStore();

  const steps = message.steps || [];
  const hasSteps = steps.length > 0;
  const images = Content.getImages(message.content);
  const videos = Content.getVideos(message.content);

  const stepHasIndicator = steps.map((step) => step.items.some((item) => item.type === "tool_use" || item.type === "thinking" || item.type === "compaction"));

  const contentToCopy = (() => {
    if (!hasSteps) {
      return typeof message.content === "string" ? message.content : "";
    }
    const lastStep = steps[steps.length - 1];
    const textItems = lastStep.items.filter((item) => item.type === "text");
    if (textItems.length > 0) {
      return textItems.map((item) => (item as { type: "text"; content: string }).content).join("\n");
    }
    return typeof message.content === "string" ? message.content : "";
  })();

  if (!isStreaming && !hasMessageContent(message) && !message.inlineError) {
    return null;
  }

  const displayContent = typeof message.content === "string" ? message.content : "";
  const isShowingInlineError = message.inlineError && !isStreaming;

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
              {hasSteps &&
                groupStepsByPlanMode(steps).map((group, gi) => {
                  const totalSteps = steps.length;
                  const stepsContent = group.steps.map((step, i) => {
                    const globalIndex = group.startIndex + i;
                    const isLastInGroup = i === group.steps.length - 1;
                    const isLastOverall = globalIndex === totalSteps - 1;
                    const hasIndicator = stepHasIndicator[globalIndex];
                    const hasNextIndicator = stepHasIndicator.slice(globalIndex + 1).some(Boolean);
                    const showConnector = hasIndicator && hasNextIndicator && !isLastInGroup && !isLastOverall;
                    return <StepContent key={step.n} step={step} showConnector={showConnector} />;
                  });

                  if (group.planMode) {
                    return <PlanCard key={`plan-${gi}`}>{stepsContent}</PlanCard>;
                  }
                  return <Fragment key={`normal-${gi}`}>{stepsContent}</Fragment>;
                })}
              {!hasSteps && displayContent && <Markdown content={displayContent} className="text-xs leading-relaxed @[420px]:pl-5" enableEnrichment={!isStreaming} />}
              {(images.length > 0 || videos.length > 0) && (
                <div className="@[420px]:pl-5">
                  <MessageMedia images={images} videos={videos} onPreview={setPreviewMedia} />
                </div>
              )}
            </div>

            {/* 内嵌错误显示 */}
            {isShowingInlineError && message.inlineError && (
              <div className="@[420px]:pl-5">
                <InlineError error={message.inlineError} />
              </div>
            )}
            <div className="flex flex-row items-center space-between">
              <div className="inline-flex flex-1">{isStreaming && !isShowingInlineError && !isCompacting && <ThinkingIndicator />}</div>
              <div className="inline-flex flex-1" />
              {!isStreaming && contentToCopy.trim().length > 0 && (
                <div className="flex justify-start pt-1 gap-1 opacity-0 group-hover/message:opacity-100 transition-opacity duration-100">
                  <CopyButton content={contentToCopy} />
                  {message.forkable !== false && turnIndex !== undefined && turnIndex >= 0 && <ForkButton turnIndex={turnIndex} />}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <MediaPreviewModal src={previewMedia} onClose={() => setPreviewMedia(null)} />
    </div>
  );
}

function hasMessageContent(message: ChatMessageType): boolean {
  if (!Content.isEmpty(message.content)) {
    return true;
  }
  return message.steps?.some((s) => s.items.length > 0) ?? false;
}

export function ChatMessage({ message, turnIndex, isStreaming }: ChatMessageProps) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  return <AssistantMessage message={message} turnIndex={turnIndex} isStreaming={isStreaming} />;
}
