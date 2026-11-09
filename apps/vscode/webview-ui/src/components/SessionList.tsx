import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  IconSearch,
  IconDots,
  IconTrash,
  IconCheck,
  IconLoader2,
  IconExternalLink,
  IconSend,
  IconGitBranch,
  IconAlertCircle,
  IconClock,
} from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StreamingConfirmDialog } from "./StreamingConfirmDialog";
import { bridge, Events } from "@/services";
import type { SessionInfo } from "shared/legacy-sdk";
import { cn } from "@/lib/utils";
import { useChatStore, useSettingsStore } from "@/stores";
import { cleanSystemTags } from "shared/utils";
import { toast } from "./ui/sonner";

interface SessionListProps {
  onClose: () => void;
}

export const KIMI_SESSIONS_KEY = ["kimiSessions"] as const;
const NO_SESSIONS: SessionInfo[] = [];

function formatRelativeDate(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

interface SessionItemProps {
  session: SessionInfo;
  isSelected: boolean;
  onSelect: () => void;
  onOpenInNewWindow: () => void;
  isOpeningInNewWindow: boolean;
  onDelete: () => void;
  dirLabel: string;
  now: number;
}

function SessionItem({
  session,
  isSelected,
  onSelect,
  onOpenInNewWindow,
  isOpeningInNewWindow,
  onDelete,
  dirLabel,
  now,
}: SessionItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const status = session.status ?? (session.isRunning ? "running" : "completed");
  const statusLabel = status === "waiting" ? "Waiting" : status[0].toUpperCase() + status.slice(1);

  return (
    <div
      className={cn(
        "group relative px-3 py-2.5 rounded-lg cursor-pointer transition-colors",
        isSelected ? "bg-accent" : "hover:bg-accent/50",
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? "page" : undefined}
    >
      <p className="text-xs font-medium leading-relaxed line-clamp-2 text-foreground">{cleanSystemTags(session.brief) || "Untitled"}</p>
      <div className="flex items-start justify-between mt-1 gap-2">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {isSelected && <IconCheck className="size-3 text-blue-500 shrink-0" />}
          <span
            className={cn(
              "flex items-center gap-1 text-[10px] shrink-0",
              status === "running" && "text-blue-500",
              status === "waiting" && "text-amber-500",
              status === "failed" && "text-destructive",
              status === "completed" && "text-emerald-600 dark:text-emerald-400",
            )}
          >
            {status === "running" && (
              <IconLoader2 className="size-3 animate-spin motion-reduce:animate-none" />
            )}
            {status === "waiting" && <IconClock className="size-3" />}
            {status === "failed" && <IconAlertCircle className="size-3" />}
            {status === "completed" && <IconCheck className="size-3" />}
            {statusLabel}
          </span>
          {session.startedAt !== undefined && session.isRunning && (
            <span className="text-[10px] text-muted-foreground shrink-0">{formatElapsed(session.startedAt, now)}</span>
          )}
          <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeDate(session.updatedAt)}</span>
          <span className="text-[10px] text-muted-foreground/70 truncate" title={session.workDir}>· {dirLabel}</span>
          {session.branch && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground/70 truncate" title={`Git branch: ${session.branch}`}>
              <IconGitBranch className="size-3 shrink-0" />
              <span className="truncate">{session.branch}</span>
            </span>
          )}
        </div>
        <div className={cn("transition-opacity group-focus-within:opacity-100", isHovered ? "opacity-100" : "opacity-0")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="p-1 -m-1 rounded hover:bg-muted transition-colors"
                onClick={(e) => e.stopPropagation()}
                aria-label={`Conversation actions for ${cleanSystemTags(session.brief) || "Untitled"}`}
              >
                <IconDots className="size-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                className="text-xs cursor-pointer"
                disabled={isOpeningInNewWindow}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenInNewWindow();
                }}
              >
                {isOpeningInNewWindow ? (
                  <IconLoader2 className="size-3.5 mr-2 animate-spin motion-reduce:animate-none" />
                ) : (
                  <IconExternalLink className="size-3.5 mr-2" />
                )}
                Open in new window
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-xs text-destructive focus:text-destructive cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
              >
                <IconTrash className="size-3.5 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground truncate" title={session.latestActivity}>
        {session.latestActivity ?? (session.isRunning ? "Working" : "Finished")}
      </p>
    </div>
  );
}

export function SessionList({ onClose }: SessionListProps) {
  const { loadSession, sessionId, startNewConversation, isStreaming } = useChatStore();
  const { workspaceRoot, currentWorkDir, setCurrentWorkDir } = useSettingsStore();
  const useCtrlEnterToSend = useSettingsStore((state) => state.extensionConfig.useCtrlEnterToSend);
  const [searchQuery, setSearchQuery] = useState("");
  const [newChatPrompt, setNewChatPrompt] = useState("");
  const [pendingNewPrompt, setPendingNewPrompt] = useState<string | null>(null);
  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);
  const [openingSessionId, setOpeningSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const newChatInputRef = useRef<HTMLTextAreaElement>(null);

  const queryClient = useQueryClient();
  const { data: kimiSessions = NO_SESSIONS, isPending: loading } = useQuery({
    queryKey: KIMI_SESSIONS_KEY,
    queryFn: () => bridge.getAllKimiSessions(),
  });

  useEffect(() => {
    if (!kimiSessions.some((session) => session.isRunning)) return;
    const interval = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [kimiSessions]);

  useEffect(() => {
    const unsubs = [
      bridge.on(Events.FocusInput, () => newChatInputRef.current?.focus()),
      bridge.on<{ mention: string }>(Events.InsertMention, ({ mention }) => {
        setNewChatPrompt((prompt) => `${prompt}${mention} `);
        setTimeout(() => newChatInputRef.current?.focus(), 0);
      }),
    ];
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, []);

  const getWorkDirLabel = (sessionWorkDir: string): string => {
    if (!workspaceRoot) return sessionWorkDir;
    if (sessionWorkDir === workspaceRoot) {
      return "/";
    }
    if (sessionWorkDir.startsWith(workspaceRoot)) {
      return "." + sessionWorkDir.slice(workspaceRoot.length);
    }
    return sessionWorkDir;
  };

  const filteredSessions = useMemo(() => {
    const sorted = kimiSessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
    if (!searchQuery.trim()) return sorted;
    const q = searchQuery.toLowerCase();
    return sorted.filter((s) => s.brief.toLowerCase().includes(q));
  }, [kimiSessions, searchQuery]);

  const handleSelect = async (session: SessionInfo) => {
    console.log("[SessionList] Loading session:", session.id);

    if (sessionId === session.id) {
      onClose();
      return;
    }

    // If streaming, show confirmation dialog
    if (isStreaming) {
      setPendingSession(session);
      return;
    }

    await doLoadSession(session);
  };

  const doLoadSession = async (session: SessionInfo) => {
    try {
      // Switch workDir if session is from a different directory
      const activeWorkDir = currentWorkDir || workspaceRoot;
      if (session.workDir !== activeWorkDir) {
        const newWorkDir = session.workDir === workspaceRoot ? null : session.workDir;
        const result = await bridge.setWorkDir(newWorkDir);
        if (result.ok) {
          setCurrentWorkDir(newWorkDir);
        }
      }
      const events = await bridge.loadSessionHistory(session.id);
      await loadSession(session.id, events);
      onClose();
    } catch (error) {
      console.error("[SessionList] Failed to load session:", error);
      toast.error(`Unable to open the conversation: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleConfirmSwitch = async () => {
    if (!pendingSession) return;
    await doLoadSession(pendingSession);
    setPendingSession(null);
  };

  const handleOpenInNewWindow = async (session: SessionInfo) => {
    setOpeningSessionId(session.id);
    try {
      const result = await bridge.openNewSessionTab({
        sessionId: session.id,
        workDir: session.workDir,
      });
      if (!result.ok) throw new Error("The conversation is unavailable.");
    } catch (error) {
      toast.error(`Unable to open the conversation in a new window: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setOpeningSessionId(null);
    }
  };

  const startConversationWithPrompt = async (prompt: string) => {
    setIsStartingConversation(true);
    try {
      await startNewConversation();
      useChatStore.getState().sendMessage(prompt);
      setNewChatPrompt("");
      setPendingNewPrompt(null);
      onClose();
    } catch (error) {
      toast.error(`Unable to start the conversation: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsStartingConversation(false);
    }
  };

  const handleNewChatSubmit = () => {
    const prompt = newChatPrompt;
    if (!prompt.trim() || isStartingConversation) return;
    if (isStreaming) {
      setPendingNewPrompt(prompt);
      return;
    }
    void startConversationWithPrompt(prompt);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      await bridge.deleteSession(deleteTarget.id);

      if (sessionId === deleteTarget.id) {
        await startNewConversation();
      }

      queryClient.setQueryData<SessionInfo[]>(KIMI_SESSIONS_KEY, (prev) => prev?.filter((s) => s.id !== deleteTarget.id) ?? []);
    } catch (error) {
      console.error("[SessionList] Failed to delete session:", error);
      toast.error(`Unable to delete the conversation: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <div className="flex flex-col h-full min-h-0">
        <div className="p-3 border-b border-border shrink-0">
          <div className="relative">
            <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input placeholder="Search conversations…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-8 h-8 text-xs" />
          </div>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          <div className="p-2 space-y-1">
            {loading ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">Loading…</div>
            ) : filteredSessions.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">{searchQuery ? "No conversations found" : "No conversations yet"}</div>
            ) : (
              filteredSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  isSelected={sessionId === session.id}
                  onSelect={() => {
                    void handleSelect(session);
                  }}
                  onOpenInNewWindow={() => {
                    void handleOpenInNewWindow(session);
                  }}
                  isOpeningInNewWindow={openingSessionId === session.id}
                  onDelete={() => setDeleteTarget(session)}
                  dirLabel={getWorkDirLabel(session.workDir)}
                  now={now}
                />
              ))
            )}
          </div>
        </div>
        <form
          className="p-2 border-t border-border shrink-0"
          onSubmit={(event) => {
            event.preventDefault();
            handleNewChatSubmit();
          }}
        >
          <div className="px-1 pb-1.5 text-[10px] font-medium text-muted-foreground">Start a new conversation</div>
          <InputGroup className="items-end">
            <InputGroupTextarea
              ref={newChatInputRef}
              aria-label="New conversation message"
              placeholder="Message Kimi…"
              value={newChatPrompt}
              disabled={isStartingConversation}
              rows={2}
              className="min-h-14 max-h-28 text-xs"
              onChange={(event) => setNewChatPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.key !== "Enter" || event.shiftKey) return;
                const shouldSend = useCtrlEnterToSend ? event.ctrlKey || event.metaKey : true;
                if (!shouldSend) return;
                event.preventDefault();
                handleNewChatSubmit();
              }}
            />
            <InputGroupAddon align="inline-end" className="pb-2">
              <InputGroupButton
                type="submit"
                variant="default"
                size="icon-xs"
                aria-label="Start conversation"
                disabled={!newChatPrompt.trim() || isStartingConversation}
              >
                {isStartingConversation ? (
                  <IconLoader2 className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <IconSend />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>

      <StreamingConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Conversation?"
        description="This will permanently delete this conversation. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => {
          void handleDelete();
        }}
        confirmDisabled={isDeleting}
        cancelDisabled={isDeleting}
        confirmLoading={isDeleting}
      />

      <StreamingConfirmDialog
        open={pendingSession !== null}
        onOpenChange={(open) => !open && setPendingSession(null)}
        title="Switch Conversation?"
        description="The current conversation is still generating a response. Switching will truncate the output. Are you sure you want to continue?"
        confirmLabel="Switch"
        onConfirm={() => {
          void handleConfirmSwitch();
        }}
      />

      <StreamingConfirmDialog
        open={pendingNewPrompt !== null}
        onOpenChange={(open) => !open && setPendingNewPrompt(null)}
        title="Start New Conversation?"
        description="The current conversation is still generating a response. Starting a new one will truncate the output. Are you sure you want to continue?"
        confirmLabel="Start Conversation"
        onConfirm={() => {
          if (pendingNewPrompt !== null) void startConversationWithPrompt(pendingNewPrompt);
        }}
        confirmDisabled={isStartingConversation}
        cancelDisabled={isStartingConversation}
        confirmLoading={isStartingConversation}
      />
    </>
  );
}
