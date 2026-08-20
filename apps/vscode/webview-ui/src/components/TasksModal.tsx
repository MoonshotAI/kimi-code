import { useState, useEffect } from "react";
import {
  IconX,
  IconChevronDown,
  IconLoader2,
  IconPlayerStop,
  IconRefresh,
  IconTerminal2,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
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
import { useTasksStore, visibleBackgroundTasks } from "@/stores";
import { bridge } from "@/services";
import { cn } from "@/lib/utils";
import {
  isBackgroundTaskTerminal,
  type BackgroundTaskInfo,
  type BackgroundTaskStatus,
} from "shared/legacy-sdk";

type Filter = "all" | "active";

const OUTPUT_REFRESH_INTERVAL_MS = 2000;
const OUTPUT_TAIL_BYTES = 4000;

const STATUS_DOT_CLASS: Record<BackgroundTaskStatus, string> = {
  running: "bg-blue-400 animate-pulse",
  completed: "bg-green-500",
  failed: "bg-red-500",
  timed_out: "bg-red-500",
  killed: "bg-red-500",
  lost: "bg-red-500",
};

const STATUS_LABEL: Record<BackgroundTaskStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  timed_out: "Timed out",
  killed: "Stopped",
  lost: "Lost",
};

function kindLabel(info: BackgroundTaskInfo): string {
  if (info.kind === "agent") return "agent";
  if (info.kind === "question") return "question";
  return "bash";
}

function formatDuration(info: BackgroundTaskInfo): string {
  const end = info.endedAt ?? Date.now();
  const seconds = Math.max(0, Math.round((end - info.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function TaskOutput({ task }: { task: BackgroundTaskInfo }) {
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const running = task.status === "running";

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      bridge
        .getBackgroundTaskOutput(task.taskId, OUTPUT_TAIL_BYTES)
        .then((result) => {
          if (!cancelled) {
            setOutput(result.output);
            setError(null);
          }
        })
        .catch((loadError: unknown) => {
          if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
        });
    };
    load();
    if (!running) return () => { cancelled = true; };
    const timer = setInterval(load, OUTPUT_REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task.taskId, running]);

  if (error !== null) {
    return <div className="text-[10px] text-destructive px-2 py-1">{error}</div>;
  }
  if (output === null) {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground px-2 py-1">
        <IconLoader2 className="size-3 animate-spin" />
        Loading output...
      </div>
    );
  }
  if (output.length === 0) {
    return (
      <div className="text-[10px] text-muted-foreground px-2 py-1">
        {running ? "No output yet." : "No output."}
      </div>
    );
  }
  return (
    <pre className="text-[10px] font-mono bg-muted/50 rounded p-2 whitespace-pre-wrap break-all max-h-48 overflow-auto">
      {output}
    </pre>
  );
}

function TaskItem({ task, onStop }: { task: BackgroundTaskInfo; onStop: (taskId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const running = task.status === "running";

  return (
    <div className="rounded-md border border-border/60 bg-card px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className={cn("size-1.5 rounded-full shrink-0", STATUS_DOT_CLASS[task.status])} />
        <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground shrink-0">
          {kindLabel(task)}
        </span>
        <span className="flex-1 min-w-0 truncate text-xs" title={task.description}>
          {task.description || task.taskId}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
          {STATUS_LABEL[task.status]} · {formatDuration(task)}
        </span>
        {running && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:text-destructive"
            title="Stop task"
            onClick={() => onStop(task.taskId)}
          >
            <IconPlayerStop className="size-3.5" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 text-muted-foreground"
          title={expanded ? "Hide output" : "View output"}
          onClick={() => setExpanded((prev) => !prev)}
        >
          <IconChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </Button>
      </div>
      {task.kind === "process" && (
        <div className="mt-1 truncate text-[10px] font-mono text-muted-foreground/70" title={task.command}>
          {task.command}
        </div>
      )}
      {expanded && (
        <div className="mt-2">
          <TaskOutput task={task} />
        </div>
      )}
    </div>
  );
}

export function TasksModal() {
  const { tasks, browserOpen, setBrowserOpen, refreshTasks } = useTasksStore();
  const [filter, setFilter] = useState<Filter>("all");
  const [stopTarget, setStopTarget] = useState<string | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (browserOpen) {
      void refreshTasks().catch((error: unknown) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    }
  }, [browserOpen, refreshTasks]);

  const handleStop = async () => {
    if (stopTarget === null) return;
    setIsStopping(true);
    setActionError(null);
    try {
      await bridge.stopBackgroundTask(stopTarget);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
    setIsStopping(false);
    setStopTarget(null);
  };

  if (!browserOpen) return null;

  const visible = visibleBackgroundTasks(tasks);
  const filtered = filter === "active"
    ? visible.filter((task) => !isBackgroundTaskTerminal(task.status))
    : visible;
  const sorted = [...filtered].sort((a, b) => {
    const aRunning = a.status === "running" ? 0 : 1;
    const bRunning = b.status === "running" ? 0 : 1;
    if (aRunning !== bRunning) return aRunning - bRunning;
    return b.startedAt - a.startedAt;
  });

  return (
    <>
      <div className="fixed inset-0 z-40 flex flex-col bg-background">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <div className="flex items-center gap-2">
            <IconTerminal2 className="size-4 text-blue-500" />
            <h2 className="text-xs font-medium">Background Tasks</h2>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex items-center rounded-md border border-border/60 overflow-hidden">
              {(["all", "active"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    "px-2 py-0.5 text-[10px] capitalize transition-colors",
                    filter === value ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted/50",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              title="Refresh"
              onClick={() => {
                void refreshTasks().catch((error: unknown) => {
                  setActionError(error instanceof Error ? error.message : String(error));
                });
              }}
            >
              <IconRefresh className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="size-6" onClick={() => setBrowserOpen(false)}>
              <IconX className="size-3.5" />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-3 py-3 space-y-1.5">
            {actionError && (
              <div className="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs text-destructive">
                {actionError}
              </div>
            )}
            {sorted.map((task) => (
              <TaskItem key={task.taskId} task={task} onStop={setStopTarget} />
            ))}
            {sorted.length === 0 && (
              <div className="py-6 text-center">
                <IconTerminal2 className="size-6 mx-auto text-muted-foreground/30 mb-1" />
                <p className="text-xs text-muted-foreground">
                  {filter === "active" ? "No running background tasks" : "No background tasks"}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={stopTarget !== null} onOpenChange={(open) => !open && setStopTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop Background Task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop "{stopTarget}". The process is asked to terminate gracefully first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStopping}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { void handleStop(); }}
              disabled={isStopping}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isStopping ? "Stopping..." : "Stop"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
