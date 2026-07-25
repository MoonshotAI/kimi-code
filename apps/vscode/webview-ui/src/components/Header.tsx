import { useState } from "react";
import { IconPlus, IconChevronDown, IconInfoCircle } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StreamingConfirmDialog } from "./StreamingConfirmDialog";
import { KimiLogo } from "./KimiLogo";
import { SessionList } from "./SessionList";
import { useChatStore } from "@/stores";
import { ChatStatus, TokenInfo } from "./ChatStatus";

export function Header() {
  const [showSessionList, setShowSessionList] = useState(false);
  const [showSessionInfo, setShowSessionInfo] = useState(false);
  const [showConfirmNew, setShowConfirmNew] = useState(false);
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
    setShowSessionList(false);
    setShowConfirmNew(false);
  };

  return (
    <header className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0 @container">
      <div className="flex items-center gap-2 shrink-0">
        <KimiLogo className="size-5 shrink-0" />
        <span className="text-sm font-semibold whitespace-nowrap">Kimi Code</span>
      </div>
      <div className="flex items-center gap-1">
        {sessionId && (
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
        <ChatStatus />
        <Popover open={showSessionList} onOpenChange={setShowSessionList}>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="xs" className="gap-1 h-6">
              <span className="text-xs @max-[280px]:hidden">History</span>
              <IconChevronDown className="size-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[20rem] max-w-[calc(100vw-1rem)] p-0">
            <SessionList onClose={() => setShowSessionList(false)} />
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => {
            void handleNewSession();
          }}
        >
          <IconPlus className="size-3.5" />
        </Button>
      </div>

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
