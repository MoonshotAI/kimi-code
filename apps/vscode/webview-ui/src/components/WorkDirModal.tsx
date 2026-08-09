import { useState, useEffect } from "react";
import { IconFolder, IconFolderOpen, IconCheck, IconHome } from "@tabler/icons-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useSettingsStore, useChatStore } from "@/stores";
import { bridge } from "@/services";
import { cn } from "@/lib/utils";

export function WorkDirModal() {
  const { workDirModalOpen, setWorkDirModalOpen, currentWorkDir, workspaceRoot, setCurrentWorkDir } = useSettingsStore();
  const { startNewConversation } = useChatStore();
  const [workDirs, setWorkDirs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (workDirModalOpen) {
      void bridge.getRegisteredWorkDirs().then(setWorkDirs);
    }
  }, [workDirModalOpen]);

  const handleSelect = async (dir: string | null) => {
    setLoading(true);
    try {
      const result = await bridge.setWorkDir(dir);
      if (result.ok) {
        setCurrentWorkDir(result.workDir === workspaceRoot ? null : result.workDir);
        await startNewConversation();
        setWorkDirModalOpen(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleBrowse = async () => {
    setLoading(true);
    try {
      const result = await bridge.browseWorkDir();
      if (result.ok && result.workDir) {
        setCurrentWorkDir(result.workDir === workspaceRoot ? null : result.workDir);
        await startNewConversation();
        setWorkDirModalOpen(false);
      }
    } finally {
      setLoading(false);
    }
  };

  const displayPath = (fullPath: string) => {
    if (!workspaceRoot) return fullPath;
    if (fullPath === workspaceRoot) return fullPath.split("/").pop() || fullPath;
    return fullPath.replace(workspaceRoot, ".");
  };

  const isSelected = (dir: string) => {
    if (!currentWorkDir) return dir === workspaceRoot;
    return dir === currentWorkDir;
  };

  return (
    <Dialog open={workDirModalOpen} onOpenChange={setWorkDirModalOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Select Working Directory</DialogTitle>
        </DialogHeader>

        <div className="space-y-1 max-h-64 overflow-y-auto -mx-1 px-1">
          {workDirs.map((dir) => (
            <button
              key={dir}
              onClick={() => {
                void handleSelect(dir === workspaceRoot ? null : dir);
              }}
              disabled={loading}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-2 rounded-md text-left text-sm transition-colors",
                isSelected(dir) ? "bg-accent" : "hover:bg-accent/50",
                loading && "opacity-50 cursor-not-allowed",
              )}
            >
              {dir === workspaceRoot ? (
                <IconHome className="size-4 text-muted-foreground shrink-0" />
              ) : (
                <IconFolder className="size-4 text-muted-foreground shrink-0" />
              )}
              <span className="flex-1 truncate">{displayPath(dir)}</span>
              {isSelected(dir) && <IconCheck className="size-4 text-blue-500 shrink-0" />}
              {dir === workspaceRoot && <span className="text-xs text-muted-foreground">(root)</span>}
            </button>
          ))}
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void handleBrowse();
              }}
              disabled={loading}
            >
              <IconFolderOpen className="size-4 mr-1.5" />
              Browse...
            </Button>
            {currentWorkDir && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void handleSelect(null);
                }}
                disabled={loading}
              >
                <IconHome className="size-4 mr-1.5" />
                Reset
              </Button>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setWorkDirModalOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
