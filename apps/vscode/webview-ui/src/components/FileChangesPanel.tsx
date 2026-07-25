import { useState } from "react";
import { IconFilePlus, IconFileMinus, IconFileX, IconArrowBackUp, IconCheck, IconGitCompare } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useChatStore } from "@/stores";
import { bridge } from "@/services";
import { cn } from "@/lib/utils";
import { FileChange } from "shared/types";
import { toast } from "./ui/sonner";

const STATUS_CONFIG = {
  Added: { icon: IconFilePlus, color: "text-green-600 dark:text-green-400" },
  Deleted: { icon: IconFileX, color: "text-red-600 dark:text-red-400" },
  Modified: { icon: IconFileMinus, color: "text-yellow-600 dark:text-yellow-400" },
} as const;

function getTotalStats(changes: FileChange[]) {
  return changes.reduce(
    (a, c) => ({
      additions: a.additions + c.additions,
      deletions: a.deletions + c.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

interface FileItemProps {
  file: FileChange;
  onRevert: () => void;
  onKeep: () => void;
  onViewDiff: () => void;
  disabled: boolean;
  isStreaming?: boolean;
}

function FileItem({ file, onRevert, onKeep, onViewDiff, disabled, isStreaming }: FileItemProps) {
  const { icon: Icon, color } = STATUS_CONFIG[file.status];
  const name = file.path.split("/").pop() || file.path;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  return (
    <div className="group flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-accent/50 text-xs">
      <Icon className={cn("size-3.5 shrink-0", color)} />
      <div className="flex-1 min-w-0 text-left truncate hover:underline cursor-pointer" onClick={onViewDiff} title={file.path}>
        <span className="font-medium">{name}</span>
        {dir && <span className="ml-1 text-muted-foreground text-[10px]">{dir}</span>}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-5 border-0! cursor-pointer hover:bg-accent" onClick={onViewDiff}>
              <IconGitCompare className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>View Changes</TooltipContent>
        </Tooltip>
        {!isStreaming && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-5 border-0! cursor-pointer hover:bg-accent" onClick={onRevert} disabled={disabled}>
                  <IconArrowBackUp className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Undo Changes</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-5 border-0! cursor-pointer hover:bg-accent" onClick={onKeep} disabled={disabled}>
                  <IconCheck className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Keep Changes</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
      <div className="flex items-center gap-1 text-[10px] tabular-nums shrink-0">
        <span className="text-green-600 dark:text-green-400">+{file.additions}</span>
        <span className="text-red-600 dark:text-red-400">-{file.deletions}</span>
      </div>
    </div>
  );
}

interface FileChangesPanelProps {
  changes: FileChange[];
}

export function FileChangesPanel({ changes }: FileChangesPanelProps) {
  const { isStreaming } = useChatStore();
  const [loading, setLoading] = useState(false);

  const handleRevert = async (filePath?: string) => {
    setLoading(true);
    try {
      await bridge.revertFiles(filePath);
    } catch (error) {
      toast.error(`Unable to undo changes: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const handleKeep = async (filePath?: string) => {
    setLoading(true);
    try {
      await bridge.keepChanges(filePath);
    } catch (error) {
      toast.error(`Unable to keep changes: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const stats = getTotalStats(changes);

  if (!changes.length) {
    return <div className="px-2.5 py-3 text-xs text-muted-foreground text-center">No file changes</div>;
  }

  return (
    <div className="flex flex-col bg-card shrink">
      {/* Header with actions */}
      <div className="flex items-center justify-between px-2.5 py-1.5 text-xs bg-muted/30">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {changes.length} file{changes.length !== 1 ? "s" : ""}
          </span>
          <div className="flex items-center gap-1 text-[10px] tabular-nums">
            <span className="text-green-600 dark:text-green-400">+{stats.additions}</span>
            <span className="text-red-600 dark:text-red-400">-{stats.deletions}</span>
          </div>
        </div>
        {!isStreaming && (
          <div className="flex gap-1">
            <Button
              variant="default"
              size="sm"
              className="h-5 px-2 text-[10px] cursor-pointer"
              onClick={() => {
                void handleKeep();
              }}
              disabled={loading}
            >
              Keep All
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="h-5 px-2 text-[10px] cursor-pointer"
              onClick={() => {
                void handleRevert();
              }}
              disabled={loading}
            >
              Undo All
            </Button>
          </div>
        )}
      </div>

      {/* File list */}
      <div className="overflow-y-auto flex-1">
        {changes.map((file) => (
          <FileItem
            key={file.path}
            file={file}
            onRevert={() => {
              void handleRevert(file.path);
            }}
            onKeep={() => {
              void handleKeep(file.path);
            }}
            onViewDiff={() => {
              void bridge.openFileDiff(file.path);
            }}
            disabled={loading}
            isStreaming={isStreaming}
          />
        ))}
      </div>
    </div>
  );
}
