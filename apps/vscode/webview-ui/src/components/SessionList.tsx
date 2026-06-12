import { useMemo, useState } from "react";
import { useRequest } from "ahooks";
import { IconSearch, IconDots, IconTrash, IconCheck, IconLoader2 } from "@tabler/icons-react";
import { useShallow } from "zustand/react/shallow";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { bridge } from "@/services";
import type { SessionInfo } from "@moonshot-ai/kimi-code-vscode-agent-sdk/schema";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores";

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
  isLoading: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function SessionItem({ session, isSelected, isLoading, onSelect, onDelete }: SessionItemProps) {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={cn("group relative px-2 py-1 rounded-md cursor-pointer transition-colors", isSelected || isLoading ? "bg-accent" : "hover:bg-accent/50")}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onSelect}
    >
      <p className="text-xs leading-relaxed line-clamp-3 text-foreground">{session.brief || "Untitled"}</p>
      <div className="flex items-center justify-between mt-0.5">
        <div className="flex items-center gap-1.5">
          {isLoading ? <IconLoader2 className="size-3 animate-spin text-blue-500" /> : isSelected ? <IconCheck className="size-3 text-blue-500" /> : null}
          <span className="text-[10px] text-muted-foreground">{formatRelativeDate(session.updatedAt)}</span>
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
  const { loadSession, sessionId, startNewConversation } = useChatStore(
    useShallow((state) => ({
      loadSession: state.loadSession,
      sessionId: state.sessionId,
      startNewConversation: state.startNewConversation,
    })),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);

  const { data: kimiSessions = [], loading, mutate } = useRequest(() => bridge.getKimiSessions());

  const filteredSessions = useMemo(() => {
    // Hide the session currently running in this terminal so the history list
    // only shows past conversations.
    const list = sessionId ? kimiSessions.filter((s) => s.id !== sessionId) : kimiSessions;
    if (!searchQuery.trim()) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((s) => s.brief.toLowerCase().includes(q));
  }, [kimiSessions, searchQuery, sessionId]);

  const handleSelect = async (session: SessionInfo) => {
    console.log("[SessionList] Loading session:", session.id);
    setLoadingSessionId(session.id);
    try {
      const events = await bridge.loadSessionHistory(session.id);
      loadSession(session.id, events);
      onClose();
    } catch (error) {
      console.error("[SessionList] Failed to load session:", error);
    } finally {
      setLoadingSessionId(null);
    }
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
                  isLoading={loadingSessionId === session.id}
                  onSelect={() => handleSelect(session)}
                  onDelete={() => setDeleteTarget(session)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Conversation?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently delete this conversation. This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={isDeleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
