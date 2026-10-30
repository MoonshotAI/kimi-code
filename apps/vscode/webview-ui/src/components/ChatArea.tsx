import { useEffect, useRef } from "react";
import ScrollToBottom, { useScrollToBottom, useSticky } from "react-scroll-to-bottom";
import { IconArrowDown } from "@tabler/icons-react";
import { ChatMessage } from "./ChatMessage";
import { WelcomeScreen } from "./WelcomeScreen";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";
import { getForkTurnIndex } from "shared/fork-turn-index";
import { bridge } from "@/services";
import { toast } from "@/components/ui/sonner";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";

function ScrollButton() {
  const scrollToBottom = useScrollToBottom();
  const [sticky] = useSticky();

  if (sticky) return null;

  return (
    <button
      onClick={() => scrollToBottom()}
      className={cn("absolute bottom-4 right-4 p-2 rounded-full z-10", "bg-blue-400 text-white shadow-lg", "hover:bg-blue-600 transition-all")}
    >
      <IconArrowDown className="size-4" />
    </button>
  );
}

function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const isStreaming = useChatStore((s) => s.isStreaming);

  return (
    <>
      <div className="">
        {messages.map((message, idx) => (
          <ChatMessage
            key={message.id}
            message={message}
            turnIndex={getForkTurnIndex(messages, idx)}
            isStreaming={isStreaming && idx === messages.length - 1 && message.role === "assistant"}
          />
        ))}
      </div>
      <ScrollButton />
    </>
  );
}

function getChatSelection(root: HTMLDivElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed) return "";
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return "";
  return selection.toString();
}

async function copyChatText(text: string): Promise<void> {
  if (!text) return;
  try {
    await bridge.copyText(text);
  } catch (error) {
    toast.error(`Failed to copy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function ChatArea() {
  const messageCount = useChatStore((s) => s.messages.length);
  const chatRef = useRef<HTMLDivElement>(null);
  const contextTargetRef = useRef<EventTarget | null>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "c") return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
      const text = getChatSelection(chatRef.current);
      if (!text) return;
      event.preventDefault();
      void copyChatText(text);
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, []);

  const handleContextCopy = () => {
    const target = contextTargetRef.current;
    const element = target instanceof Element ? target : null;
    const markdown = element?.closest("[data-markdown-content]");
    const markdownText = markdown instanceof HTMLElement ? markdown.dataset.markdownContent : undefined;
    const fallback = markdownText ?? element?.textContent ?? "";
    void copyChatText(getChatSelection(chatRef.current) || fallback);
  };

  if (messageCount === 0) {
    return (
      <div className="h-full flex items-center justify-center relative">
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild className="select-text">
        <div ref={chatRef} className="h-full relative" onContextMenu={(event) => { contextTargetRef.current = event.target; }}>
          <ScrollToBottom className="h-full" scrollViewClassName="h-full overflow-y-auto overflow-x-hidden" followButtonClassName="hidden" initialScrollBehavior="auto">
            <MessageList />
          </ScrollToBottom>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={handleContextCopy}>Copy</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
