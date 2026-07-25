// node/vscode_extension/webview-ui/src/App.tsx
import { useEffect, useState, useCallback } from "react";
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
import { useAppInit } from "./hooks/useAppInit";
import { isPreflightError } from "shared/errors";
import type { UIStreamEvent, StreamError, ExtensionConfig } from "shared/types";
import "./styles/index.css";

function MainContent({ onAuthAction }: { onAuthAction: () => void }) {
  const { processEvent, startNewConversation, sessionId } = useChatStore();
  const { setMCPServers, setExtensionConfig, extensionConfig } = useSettingsStore();

  useEffect(() => {
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      // 只有当前已有 session 时才过滤，确保 session_start 能正常处理
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
      bridge.on(Events.MCPServersChanged, setMCPServers),
      bridge.on(Events.ExtensionConfigChanged, ({ config }: { config: ExtensionConfig }) => setExtensionConfig(config)),
      bridge.on(Events.FocusInput, () => document.querySelector<HTMLTextAreaElement>("textarea")?.focus()),
      bridge.on(Events.NewConversation, () => {
        void startNewConversation().catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [setMCPServers, setExtensionConfig, startNewConversation]);

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

  const handleLoginSuccess = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleSkip = useCallback(() => {
    setSkippedLogin(true);
  }, []);

  const handleAuthAction = useCallback(() => {
    setSkippedLogin(false);
    refresh();
  }, [refresh]);

  // 未登录且未跳过
  if (status === "not-logged-in" && !skippedLogin) {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <LoginScreen onLoginSuccess={handleLoginSuccess} onSkip={handleSkip} />
        <Toaster position="top-center" />
      </div>
    );
  }

  // 跳过登录但没有模型
  if (skippedLogin && modelsCount === 0) {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <ConfigErrorScreen type="no-models" errorMessage={errorMessage} onRefresh={refresh} onBackToLogin={() => setSkippedLogin(false)} />
        <Toaster position="top-center" />
      </div>
    );
  }

  // 其他错误状态
  if (status !== "ready" && status !== "not-logged-in") {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <ConfigErrorScreen type={status} errorMessage={errorMessage} onRefresh={refresh} />
        <Toaster position="top-center" />
      </div>
    );
  }

  // 正常状态
  return (
    <div className="flex flex-col h-screen text-foreground overflow-hidden">
      <Header />
      <MainContent onAuthAction={handleAuthAction} />
      <Toaster position="top-center" />
    </div>
  );
}
