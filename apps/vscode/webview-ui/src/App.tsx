// node/vscode_extension/webview-ui/src/App.tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Header } from "./components/Header";
import { ChatArea } from "./components/ChatArea";
import { KIMI_SESSIONS_KEY, SessionList } from "./components/SessionList";
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

function MainContent({
  onAuthAction,
  onConversationOpened,
  onInitialTargetResolved,
  isChatVisible,
}: {
  onAuthAction: () => void;
  onConversationOpened: () => void;
  onInitialTargetResolved: () => void;
  isChatVisible: boolean;
}) {
  const { processEvent, loadSession, startNewConversation, sessionId } = useChatStore();
  const { setExtensionConfig, extensionConfig } = useSettingsStore();
  const queryClient = useQueryClient();
  const initialTargetStarted = useRef(false);

  useEffect(() => {
    if (initialTargetStarted.current) return;
    initialTargetStarted.current = true;
    let cancelled = false;
    void bridge
      .getPanelSessionTarget()
      .then(async (target) => {
        if (cancelled) return;
        if (target === null) {
          onInitialTargetResolved();
          return;
        }
        if (useChatStore.getState().sessionId === target.sessionId) {
          onConversationOpened();
          onInitialTargetResolved();
          return;
        }
        const settings = useSettingsStore.getState();
        const activeWorkDir = settings.currentWorkDir ?? settings.workspaceRoot;
        if (target.workDir !== activeWorkDir) {
          const workDir = target.workDir === settings.workspaceRoot ? null : target.workDir;
          const result = await bridge.setWorkDir(workDir);
          if (!result.ok) throw new Error("The conversation working directory is unavailable.");
          settings.setCurrentWorkDir(workDir);
        }
        const events = await bridge.loadSessionHistory(target.sessionId);
        if (cancelled) return;
        await loadSession(target.sessionId, events);
        onConversationOpened();
        onInitialTargetResolved();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onInitialTargetResolved();
        toast.error(`Unable to open the conversation: ${error instanceof Error ? error.message : String(error)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [loadSession, onConversationOpened, onInitialTargetResolved]);

  useEffect(() => {
    return bridge.on(Events.StreamEvent, (event: UIStreamEvent) => {
      // 只有当前已有 session 时才过滤，确保 session_start 能正常处理
      if (sessionId && "_sessionId" in event && event._sessionId && event._sessionId !== sessionId) {
        console.log("Ignored stream event from another session:", event._sessionId);
        return;
      }
      processEvent(event);
      if (event.type === "stream_complete" || event.type === "error") {
        void queryClient.invalidateQueries({ queryKey: KIMI_SESSIONS_KEY });
      }
      if (event.type === "error") {
        const streamError = event as StreamError;
        if (isPreflightError(streamError.code || "UNKNOWN")) {
          toast.error(streamError.message);
        }
      }
    });
  }, [processEvent, queryClient, sessionId]);

  useEffect(() => {
    const unsubs = [
      bridge.on(Events.MCPServersChanged, () => void queryClient.invalidateQueries({ queryKey: ["mcpServers"] })),
      bridge.on(Events.SessionsChanged, () => void queryClient.invalidateQueries({ queryKey: KIMI_SESSIONS_KEY })),
      bridge.on(Events.ExtensionConfigChanged, ({ config }: { config: ExtensionConfig }) => setExtensionConfig(config)),
      bridge.on(Events.FocusInput, () => {
        if (isChatVisible) document.querySelector<HTMLTextAreaElement>("[data-kimi-input-rail] textarea")?.focus();
      }),
      bridge.on(Events.NewConversation, () => {
        void startNewConversation()
          .then(onConversationOpened)
          .catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : String(error));
          });
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, [isChatVisible, onConversationOpened, queryClient, setExtensionConfig, startNewConversation]);

  useEffect(() => {
    if (!extensionConfig.enableNewConversationShortcut) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        void startNewConversation()
          .then(onConversationOpened)
          .catch((error: unknown) => {
            toast.error(error instanceof Error ? error.message : String(error));
          });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [extensionConfig.enableNewConversationShortcut, onConversationOpened, startNewConversation]);

  return (
    <>
      <div className="flex-1 min-h-0 relative group/chat">
        <ChatArea />
      </div>
      <div className="shrink-0 max-h-[80vh] flex flex-col min-h-0">
        <InputArea onAuthAction={onAuthAction} active={isChatVisible} />
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
  const [mainView, setMainView] = useState<"chat" | "sessions">("sessions");
  const [initialTargetResolved, setInitialTargetResolved] = useState(false);

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

  const showChat = useCallback(() => setMainView("chat"), []);
  const showSessions = useCallback(() => setMainView("sessions"), []);
  const markInitialTargetResolved = useCallback(() => setInitialTargetResolved(true), []);

  useEffect(() => {
    if (!initialTargetResolved) return;
    void bridge.setViewState({ view: mainView }).catch(() => undefined);
  }, [initialTargetResolved, mainView]);

  const resolution = resolveAppView({ status, modelsCount, skippedLogin, showLogin });

  // 登录界面：未登录且未跳过，或用户从其他界面主动选择登录
  if (resolution.view === "login") {
    return (
      <div className="flex flex-col h-screen text-foreground overflow-hidden">
        <Header />
        <LoginScreen onLoginSuccess={handleLoginSuccess} onSkip={handleSkip} />
        <Toaster position="top-center" />
      </div>
    );
  }

  // 错误与设置状态界面；no-models 必须保留回到登录界面的入口
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

  // 正常状态
  return (
    <div className="flex flex-col h-screen text-foreground overflow-hidden">
      <Header
        view={mainView}
        onShowSessions={showSessions}
        onConversationOpened={showChat}
      />
      <div className={mainView === "chat" ? "contents" : "hidden"}>
        <MainContent
          onAuthAction={handleAuthAction}
          onConversationOpened={showChat}
          onInitialTargetResolved={markInitialTargetResolved}
          isChatVisible={mainView === "chat"}
        />
      </div>
      {mainView === "sessions" && (
        <div className="flex-1 min-h-0">
          <SessionList onClose={showChat} />
        </div>
      )}
      <Toaster position="top-center" />
    </div>
  );
}
