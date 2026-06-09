import { useEffect } from "react";
import { Header } from "./components/Header";
import { ChatArea } from "./components/ChatArea";
import { InputArea } from "./components/inputarea/InputArea";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { MCPServersModal } from "./components/MCPServersModal";
import { ConfigErrorScreen } from "./components/ConfigErrorScreen";
import { Toaster, toast } from "./components/ui/sonner";
import { useChatStore, useSettingsStore } from "./stores";
import { bridge, Events } from "./services";
import { useAppInit } from "./hooks/useAppInit";
import { isPreflightError, getUserMessage } from "shared/errors";
import type { UIStreamEvent, StreamError } from "shared/types";
import type { MCPServerConfig } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import "./styles/index.css";

function MainContent() {
  const enableNewConversationShortcut = useSettingsStore((state) => state.extensionConfig.enableNewConversationShortcut);

  useEffect(() => {
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      useChatStore.getState().processEvent(event);

      // Pre-flight 错误显示 Toast
      if (event.type === "error") {
        const streamError = event as StreamError;
        const code = streamError.code || "UNKNOWN";

        if (isPreflightError(code)) {
          const message = getUserMessage(code, streamError.message);
          toast.error(message);
        }
      }
    });
  }, []);

  useEffect(() => {
    const unsubs = [
      bridge.on<MCPServerConfig[]>(Events.MCPServersChanged, (servers) => useSettingsStore.getState().setMCPServers(servers)),
      bridge.on(Events.FocusInput, () => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()),
      bridge.on(Events.NewConversation, () => useChatStore.getState().startNewConversation()),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  useEffect(() => {
    if (!enableNewConversationShortcut) {
      return;
    }
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        useChatStore.getState().startNewConversation();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableNewConversationShortcut]);

  return (
    <>
      <div className="flex-1 min-h-0 relative group/chat">
        <ChatArea />
      </div>
      <ApprovalDialog />
      <InputArea />
      <MCPServersModal />
    </>
  );
}

export default function App() {
  const { status, errorType, errorMessage } = useAppInit();

  if (status !== "ready") {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <ConfigErrorScreen type={errorType ?? "loading"} errorMessage={errorMessage} />
        <Toaster position="top-center" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen text-foreground overflow-hidden">
      <Header />
      <MainContent />
      <Toaster position="top-center" />
    </div>
  );
}
