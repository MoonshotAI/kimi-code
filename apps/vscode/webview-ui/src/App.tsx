import { useEffect, useState, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "./components/Header";
import { ChatArea } from "./components/ChatArea";
import { InputArea } from "./components/inputarea/InputArea";
import { MCPServersModal } from "./components/MCPServersModal";
import { WorkDirModal } from "./components/WorkDirModal";
import { ConfigErrorScreen } from "./components/ConfigErrorScreen";
import { LoginScreen } from "./components/LoginScreen";
import { Toaster, toast } from "./components/ui/sonner";
import { useChatStore, useSettingsStore } from "./stores";
import { bridge, Events } from "./services";
import { useAppInit, resolveAppView } from "./hooks/useAppInit";
import { isPreflightError } from "shared/errors";
import type { UIStreamEvent, StreamError, ExtensionConfig } from "shared/types";
import "./styles/index.css";

function MainContent({ onAuthAction }: { onAuthAction: () => void }) {
  const { processEvent, startNewConversation, sessionId } = useChatStore();
  const { setExtensionConfig, extensionConfig } = useSettingsStore();
  const queryClient = useQueryClient();

  useEffect(() => {
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      if (sessionId && "_sessionId" in event && event._sessionId && event._sessionId !== sessionId) {
        console.log("Ignored stream event from another session:", event._sessionId);
        return;
      }
      processEvent(event);
      if (event.type === "error") {
        const streamError = event as StreamError;
        if (isPreflightError(streamError.code || "UNKNOWN")) {
          toast.error(streamError.message);
        }
      }
    });
  }, [processEvent, sessionId]);

  useEffect(() => {
    const unsubs = [
      bridge.on(Events.MCPServersChanged, () => void queryClient.invalidateQueries({ queryKey: ["mcpServers"] })),
      bridge.on(Events.ExtensionConfigChanged, ({ config }: { config: ExtensionConfig }) => setExtensionConfig(config)),
      bridge.on(Events.FocusInput, () => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()),
      bridge.on(Events.NewConversation, () => {
        void startNewConversation().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [queryClient, setExtensionConfig, startNewConversation]);

  useEffect(() => {
    if (!extensionConfig.enableNewConversationShortcut) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void startNewConversation().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [extensionConfig.enableNewConversationShortcut, startNewConversation]);

  return (
    <>
      <div className="flex-1 min-h-0 relative group/chat">
        <ChatArea />
      </div>
      <div className="shrink-0 max-h-[80vh] flex flex-col min-h-0">
        <InputArea onAuthAction={onAuthAction} />
      </div>
      <MCPServersModal />
      <WorkDirModal />
    </>
  );
}

export default function App() {
  const { status, errorMessage, modelsCount, refresh } = useAppInit();
  const [skippedLogin, setSkippedLogin] = useState(false);
  const [showLogin, setShowLogin] = useState(false);

  const handleLoginSuccess = useCallback(() => {
    setShowLogin(false);
    setSkippedLogin(false);
    refresh();
  }, [refresh]);

  const handleSkip = useCallback(() => {
    setShowLogin(false);
    setSkippedLogin(true);
  }, []);

  const handleShowLogin = useCallback(() => {
    setSkippedLogin(false);
    setShowLogin(true);
  }, []);

  const handleAuthAction = useCallback(() => {
    setSkippedLogin(false);
    setShowLogin(false);
    refresh();
  }, [refresh]);

  const resolution = resolveAppView({ status, modelsCount, skippedLogin, showLogin });

  if (resolution.view === "login") {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <LoginScreen onLoginSuccess={handleLoginSuccess} onSkip={handleSkip} />
        <Toaster position="top-center" />
      </div>
    );
  }

  if (resolution.view === "status") {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <ConfigErrorScreen
          type={resolution.status}
          errorMessage={errorMessage}
          onRefresh={refresh}
          onBackToLogin={resolution.canGoToLogin ? handleShowLogin : undefined}
        />
        <Toaster position="top-center" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen text-foreground overflow-hidden">
      <Header />
      <MainContent onAuthAction={handleAuthAction} />
      <Toaster position="top-center" />
    </div>
  );
}
