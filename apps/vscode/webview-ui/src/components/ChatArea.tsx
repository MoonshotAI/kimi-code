import ScrollToBottom, { useScrollToBottom, useSticky } from "react-scroll-to-bottom";
import { IconArrowDown } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { ChatMessage } from "./ChatMessage";
import { WelcomeScreen } from "./WelcomeScreen";
import { useChatStore } from "@/stores";
import { cn } from "@/lib/utils";

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
  const { messages, isStreaming } = useChatStore(
    useShallow((state) => ({
      messages: state.displayState.messages,
      isStreaming: state.displayState.isStreaming,
    })),
  );

  return (
    <>
      <div className="">
        {messages.map((message, idx) => (
          <ChatMessage key={message.id} message={message} isStreaming={isStreaming && idx === messages.length - 1 && message.role === "assistant"} />
        ))}
      </div>
      <ScrollButton />
    </>
  );
}

export function ChatArea() {
  const hasMessages = useChatStore((state) => state.displayState.messages.length > 0);

  if (!hasMessages) {
    return (
      <div className="h-full flex items-center justify-center relative">
        <WelcomeScreen />
      </div>
    );
  }

  return (
    <div className="h-full relative">
      <ScrollToBottom className="h-full" scrollViewClassName="h-full overflow-y-auto overflow-x-hidden" followButtonClassName="hidden" initialScrollBehavior="auto">
        <MessageList />
      </ScrollToBottom>
    </div>
  );
}
