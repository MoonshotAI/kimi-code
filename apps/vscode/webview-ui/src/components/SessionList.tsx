import { useMemo, useState } from "react";
import { useRequest } from "ahooks";
import { IconSearch, IconDots, IconTrash, IconCheck } from "@tabler/icons-react";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StreamingConfirmDialog } from "./StreamingConfirmDialog";
import { bridge } from "@/services";
import type { SessionInfo } from "shared/legacy-sdk";
import { cn } from "@/lib/utils";
import { useChatStore, useSettingsStore } from "@/stores";
import { cleanSystemTags } from "shared/utils";
import { toast } from "./ui/sonner";

interface SessionListProps {
  onClose: () => void;
}

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

interface SessionItemProps {
  session: SessionInfo;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  dirLabel: string | null; // null = current dir, string = relative path
}

function SessionItem({ session, isSelected, onSelect, onDelete, dirLabel }: SessionItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn("group relative px-2 py-1 rounded-md cursor-pointer transition-colors", isSelected ? "bg-accent" : "hover:bg-accent/50")}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onSelect}
    >
      <p className="text-xs leading-relaxed line-clamp-3 text-foreground">{cleanSystemTags(session.brief) || "Untitled"}</p>
      <div className="flex items-center justify-between mt-0.5">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {isSelected && <IconCheck className="size-3 text-blue-500 shrink-0" />}
          <span className="text-[10px] text-muted-foreground shrink-0">{formatRelativeDate(session.updatedAt)}</span>
          {dirLabel && <span className="text-[10px] text-muted-foreground/70 truncate" title={session.workDir}>· {dirLabel}</span>}
        </div>
        <div className={cn("transition-opacity", isHovered ? "opacity-100" : "opacity-0")}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="p-1 -m-1 rounded hover:bg-muted transition-colors" onClick={(e) => e.stopPropagation()}>
                <IconDots className="size-3.5 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
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
    </div>
  );
}

export function SessionList({ onClose }: SessionListProps) {
  const { loadSession, sessionId, startNewConversation, isStreaming } = useChatStore();
  const { workspaceRoot, currentWorkDir, setCurrentWorkDir } = useSettingsStore();
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [pendingSession, setPendingSession] = useState<SessionInfo | null>(null);

  const { data: kimiSessions = [], loading, mutate } = useRequest(() => bridge.getAllKimiSessions());

  const getWorkDirLabel = (sessionWorkDir: string): string | null => {
    const activeWorkDir = currentWorkDir || workspaceRoot;
    if (sessionWorkDir === activeWorkDir) return null;
    if (!workspaceRoot) return sessionWorkDir;
    // Show (root) for workspace root, relative path for subdirs
    if (sessionWorkDir === workspaceRoot) {
      return "/";
    }
    if (sessionWorkDir.startsWith(workspaceRoot)) {
      return "." + sessionWorkDir.slice(workspaceRoot.length);
    }
    return sessionWorkDir;
  };

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return kimiSessions;
    const q = searchQuery.toLowerCase();
    return kimiSessions.filter((s) => s.brief.toLowerCase().includes(q));
  }, [kimiSessions, searchQuery]);

  const handleSelect = async (session: SessionInfo) => {
    console.log("[SessionList] Loading session:", session.id);

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

  const handleDelete = async () => {
    if (!deleteTarget) return;

    setIsDeleting(true);
    try {
      await bridge.deleteSession(deleteTarget.id);

      if (sessionId === deleteTarget.id) {
        await startNewConversation();
      }

      mutate((prev) => prev?.filter((s) => s.id !== deleteTarget.id) || []);
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
      <div className="flex flex-col max-h-[70vh]">
        <div className="p-2 border-b border-border shrink-0">
          <div className="relative">
            <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
            <Input placeholder="Search conversations..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-8 h-8 text-xs" />
          </div>
        </div>
        <div className="overflow-y-auto flex-1 min-h-0">
          <div className="p-1.5 space-y-1">
            {loading ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">Loading...</div>
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
                  onDelete={() => setDeleteTarget(session)}
                  dirLabel={getWorkDirLabel(session.workDir)}
                />
              ))
            )}
          </div>
        </div>
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
    </>
  );
}
