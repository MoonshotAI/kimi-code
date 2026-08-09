import { useState, useEffect } from "react";
import { IconChevronUp, IconStack2, IconFileCode } from "@tabler/icons-react";
import { useChatStore } from "@/stores";
import { bridge, Events } from "@/services";
import { cn } from "@/lib/utils";
import { FileChangesPanel } from "./FileChangesPanel";
import { QueuedMessagesPanel } from "./QueuedMessagesPanel";
import { ApprovalDialog } from "./ApprovalDialog";
import { QuestionDialog } from "./QuestionDialog";
import type { FileChange } from "shared/types";

type TabId = "queue" | "changes" | null;

export function BottomToolbar() {
  const { queue } = useChatStore();
  const [activeTab, setActiveTab] = useState<TabId>(null);
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);

  useEffect(() => {
    return bridge.on<FileChange[]>(Events.FileChangesUpdated, setFileChanges);
  }, []);

  // Auto-close tab when data becomes empty
  useEffect(() => {
    if (activeTab === "queue" && queue.length === 0) {
      setActiveTab(null);
    }
    if (activeTab === "changes" && fileChanges.length === 0) {
      setActiveTab(null);
    }
  }, [activeTab, queue.length, fileChanges.length]);

  const hasQueue = queue.length > 0;
  const hasChanges = fileChanges.length > 0;
  const hasTabs = hasQueue || hasChanges;

  const toggleTab = (tab: TabId) => {
    setActiveTab((prev) => (prev === tab ? null : tab));
  };

  const fileStats = fileChanges.reduce((a, c) => ({ additions: a.additions + c.additions, deletions: a.deletions + c.deletions }), { additions: 0, deletions: 0 });

  return (
    <div className="flex flex-col min-h-0 flex-1 overflow-hidden">
      {/* ApprovalDialog and QuestionDialog - priority, shrink-0 */}
      <ApprovalDialog />
      <QuestionDialog />

      {/* Queue/Changes panel - takes remaining space */}
      {activeTab && (
        <div className="flex-1 min-h-16 max-h-32 overflow-y-auto mb-0.5 border border-border/60 rounded-md bg-card">
          {activeTab === "queue" && <QueuedMessagesPanel />}
          {activeTab === "changes" && <FileChangesPanel changes={fileChanges} />}
        </div>
      )}

      {/* Tab bar - always at bottom, shrink-0 */}
      {hasTabs && (
        <div className="shrink-0 mb-0.5 rounded-md overflow-hidden bg-card">
          <div className="flex items-center gap-1 py-0.5 min-h-7">
            {hasQueue && (
              <button
                onClick={() => toggleTab("queue")}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors",
                  activeTab === "queue" ? "bg-accent text-accent-foreground" : "hover:bg-muted/50 text-muted-foreground",
                )}
              >
                <IconStack2 className="size-3.5" />
                <span>{queue.length} Queued</span>
                <IconChevronUp className={cn("size-3 transition-transform", activeTab === "queue" && "rotate-180")} />
              </button>
            )}

            {hasChanges && (
              <button
                onClick={() => toggleTab("changes")}
                className={cn(
                  "flex items-center gap-1.5 px-2 py-0.5 rounded text-xs transition-colors",
                  activeTab === "changes" ? "bg-accent text-accent-foreground" : "hover:bg-muted/50 text-muted-foreground",
                )}
              >
                <IconFileCode className="size-3.5" />
                <span>{fileChanges.length} Changed</span>
                <span className="text-[10px] tabular-nums">
                  <span className="text-green-600 dark:text-green-400">+{fileStats.additions}</span> <span className="text-red-600 dark:text-red-400">-{fileStats.deletions}</span>
                </span>
                <IconChevronUp className={cn("size-3 transition-transform", activeTab === "changes" && "rotate-180")} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
