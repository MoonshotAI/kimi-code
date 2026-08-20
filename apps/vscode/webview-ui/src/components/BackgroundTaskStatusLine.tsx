import { cn } from "@/lib/utils";
import type { BackgroundTaskInfo, BackgroundTaskStatus } from "shared/legacy-sdk";

const MAX_DETAIL_LENGTH = 240;

type Phase = "started" | "completed" | "failed";

function phaseFromStatus(status: BackgroundTaskStatus): Phase {
  switch (status) {
    case "running":
      return "started";
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
    case "killed":
    case "lost":
      return "failed";
  }
}

function subjectFor(info: BackgroundTaskInfo): string {
  if (info.kind === "agent") return "agent task";
  if (info.kind === "question") return "question task";
  return "bash task";
}

function headlineFor(info: BackgroundTaskInfo): string {
  const subject = subjectFor(info);
  switch (info.status) {
    case "running":
      return `${subject} started in background`;
    case "completed":
      return `${subject} completed in background`;
    case "failed":
      return `${subject} failed in background`;
    case "timed_out":
      return `${subject} timed out`;
    case "killed":
      return `${subject} stopped`;
    case "lost":
      return `${subject} lost`;
  }
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const collapsed = value.trim().replaceAll(/\s+/g, " ");
  if (collapsed.length === 0) return undefined;
  if (collapsed.length <= MAX_DETAIL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_DETAIL_LENGTH - 3)}...`;
}

function detailFor(info: BackgroundTaskInfo): string | undefined {
  const parts: string[] = [];
  const description = truncate(info.description);
  if (description !== undefined) parts.push(description);

  if (info.status === "completed" || info.status === "failed") {
    if (info.kind === "process" && info.exitCode !== null) {
      parts.push(`exit ${info.exitCode}`);
    }
  }
  if (info.status === "killed") {
    const reason = truncate(info.stopReason);
    parts.push(reason !== undefined ? `stopped — ${reason}` : "stopped");
  }
  if (info.status === "failed") {
    const reason = truncate(info.stopReason);
    if (reason !== undefined) parts.push(reason);
  }
  if (info.status === "timed_out") parts.push("timed out");
  if (info.status === "lost") {
    parts.push("session restarted before completion");
  }

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const PHASE_DOT_CLASS: Record<Phase, string> = {
  started: "bg-blue-400",
  completed: "bg-green-500",
  failed: "bg-red-500",
};

export function BackgroundTaskStatusLine({ info }: { info: BackgroundTaskInfo }) {
  const phase = phaseFromStatus(info.status);
  const detail = detailFor(info);
  return (
    <div className="flex items-baseline gap-1.5 text-xs py-0.5">
      <span className={cn("size-1.5 rounded-full shrink-0 self-center", PHASE_DOT_CLASS[phase])} />
      <span className="text-muted-foreground">{headlineFor(info)}</span>
      {detail && <span className="text-muted-foreground/70 truncate min-w-0">({detail})</span>}
    </div>
  );
}
