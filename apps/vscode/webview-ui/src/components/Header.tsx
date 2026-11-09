import { useState } from "react";
import {
  IconArrowLeft,
  IconExternalLink,
  IconInfoCircle,
  IconLoader2,
  IconPlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StreamingConfirmDialog } from "./StreamingConfirmDialog";
import { KimiLogo } from "./KimiLogo";
import { useChatStore } from "@/stores";
import { ChatStatus, TokenInfo } from "./ChatStatus";
import { UsageStatus } from "./UsageStatus";
import { bridge } from "@/services";
import { toast } from "./ui/sonner";

interface HeaderProps {
  view?: "chat" | "sessions";
  onShowSessions?: () => void;
  onConversationOpened?: () => void;
}

export function Header({
  view = "chat",
  onShowSessions,
  onConversationOpened = () => undefined,
}: HeaderProps) {
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [showConfirmNew, setShowConfirmNew] = useState(false);
  const [openingSessionTab, setOpeningSessionTab] = useState(false);
  const { startNewConversation, sessionId, messages, isStreaming } = useChatStore();

  const handleNewSession = async () => {
    // If streaming, show confirmation dialog
    if (isStreaming) {
      setShowConfirmNew(true);
      return;
    }

    await doStartNewSession();
  };

  const doStartNewSession = async () => {
    await startNewConversation();
    setShowConfirmNew(false);
    onConversationOpened();
  };

  const openNewSessionTab = async () => {
    setOpeningSessionTab(true);
    try {
      await bridge.openNewSessionTab();
    } catch (error) {
      toast.error(`Unable to open a new Kimi session: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpeningSessionTab(false);
    }
  };

  return (
    <header className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3 py-2 border-b border-border shrink-0 @container">
      <div className="order-1 flex items-center gap-1 shrink-0">
        {view === "chat" && onShowSessions !== undefined && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onShowSessions}
            aria-label="Show conversations"
          >
            <IconArrowLeft className="size-3.5" />
          </Button>
        )}
        <KimiLogo className="size-5 shrink-0" />
        <span className="text-sm font-semibold whitespace-nowrap">
          {view === "sessions" ? "Conversations" : "Kimi Code"}
        </span>
      </div>
      <div className="order-2 flex items-center gap-1">
        {view === "chat" && sessionId && (
          <Button
            variant="ghost"
            size="xs"
            className="gap-1 h-6 border-0! pl-px! pr-1! text-muted-foreground hover:text-foreground @max-[320px]:hidden"
            onClick={() => setShowSessionInfo(true)}
          >
            <span className="text-[11px] @max-[500px]:hidden">Session</span>
            <IconInfoCircle className="size-3.5 hidden @max-[500px]:block" />
          </Button>
        )}
        {view === "chat" && <ChatStatus />}
        <Button
          variant="ghost"
          size={view === "sessions" ? "xs" : "icon-xs"}
          onClick={() => {
            void handleNewSession();
          }}
          aria-label="New conversation in this view"
        >
          <IconPlus className="size-3.5" />
          {view === "sessions" && <span>New</span>}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={openingSessionTab}
          onClick={() => void openNewSessionTab()}
          aria-label="Open new session tab"
        >
          {openingSessionTab ? (
            <IconLoader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <IconExternalLink className="size-3.5" />
          )}
        </Button>
      </div>
      <UsageStatus />

      <Dialog open={showSessionInfo} onOpenChange={setShowSessionInfo}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Session Details</DialogTitle>
            <DialogDescription className="text-xs">Details for this conversation.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Session ID</div>
              <code className="text-xs font-mono text-foreground break-all select-all">{sessionId}</code>
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Messages</div>
              <span className="text-xs text-foreground">{messages.length}</span>
            </div>
            <TokenInfo />
          </div>
        </DialogContent>
      </Dialog>

      <StreamingConfirmDialog
        open={showConfirmNew}
        onOpenChange={(open) => !open && setShowConfirmNew(false)}
        title="Start New Conversation?"
        description="The current conversation is still generating a response. Starting a new one will truncate the output. Are you sure you want to continue?"
        confirmLabel="New Conversation"
        onConfirm={() => {
          void doStartNewSession();
        }}
      />
    </header>
  );
}
