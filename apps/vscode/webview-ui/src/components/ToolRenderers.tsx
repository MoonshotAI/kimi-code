import { useState, type ReactNode } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconTerminal2,
  IconFileText,
  IconReplace,
  IconFolderSearch,
  IconSubtask,
  IconListCheck,
  IconSquareCheck,
  IconSquare,
  IconSquareChevronRight,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { FileLink, Markdown } from "./Markdown";
import { DisplayBlocks } from "./DisplayBlocks";
import { displayBlocksToLegacy } from "@/lib/display-block-adapter";
import { PlanBlock } from "./PlanBlock";
import {
  getRichToolDisplayBlocks,
  getToolCallSummary,
  getTodoItemsForToolCall,
  isTodoToolName,
  parseToolArguments as parseArgs,
  type DisplayPart,
  type DisplayStep,
  type DisplayToolCallPart,
} from "@moonshot-ai/kimi-code-vscode-display-model";
import { ThinkingBlock } from "./ThinkingBlock";

interface DisplayToolCallCardProps {
  part: DisplayToolCallPart;
}

function CodeBlock({ content, maxLines = 10 }: { content: string; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const shouldCollapse = lines.length > maxLines;
  const displayContent = shouldCollapse && !expanded ? lines.slice(0, maxLines).join("\n") : content;

  return (
    <div className="relative group/codeblock">
      <pre className="text-[11px] bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
        {displayContent}
        {shouldCollapse && !expanded && <span className="text-zinc-500">{"\n"}...</span>}
      </pre>
      {shouldCollapse && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="absolute bottom-1.5 right-1.5 text-[11px] px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 opacity-0 group-hover/codeblock:opacity-100 transition-opacity cursor-pointer"
        >
          {expanded ? "Less" : `Expand +${lines.length - maxLines}`}
        </button>
      )}
    </div>
  );
}

function StatusIndicator({ status }: { status: "pending" | "success" | "error" }) {
  if (status === "pending") {
    return (
      <span className="relative flex size-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full size-2 bg-amber-500" />
      </span>
    );
  }
  return <span className={cn("inline-flex rounded-full size-2 shrink-0", status === "success" ? "bg-emerald-500" : "bg-red-500")} />;
}

function ToolIcon({ name }: { name: string }) {
  const iconClass = "size-3.5 text-muted-foreground shrink-0";
  switch (name) {
    case "Shell":
      return <IconTerminal2 className={iconClass} />;
    case "ReadFile":
      return <IconFile className={iconClass} />;
    case "WriteFile":
      return <IconFileText className={iconClass} />;
    case "StrReplaceFile":
      return <IconReplace className={iconClass} />;
    case "Glob":
      return <IconFolderSearch className={iconClass} />;
    case "Task":
    case "Agent":
      return <IconSubtask className={iconClass} />;
    case "SetTodoList":
      return <IconListCheck className={iconClass} />;
    default:
      if (isTodoToolName(name)) {
        return <IconListCheck className={iconClass} />;
      }
      return <IconTerminal2 className={iconClass} />;
  }
}

function IORow({ label, children }: { label: "IN" | "OUT"; children: ReactNode }) {
  return (
    <div className="flex flex-col @[420px]:flex-row gap-1 @[420px]:gap-0.5 py-2">
      <span className="shrink-0 w-8 text-xs text-muted-foreground font-medium">{label}</span>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function TodoStatusIcon({ status }: { status: string }) {
  if (status === "done") {
    return (
      <div className="size-4 rounded flex items-center justify-center">
        <IconSquareCheck className="size-3 text-zinc-600 dark:text-zinc-400" />
      </div>
    );
  }
  if (status === "in_progress") {
    return <IconSquareChevronRight className="size-4 text-amber-500" />;
  }
  return <IconSquare className="size-4 text-zinc-300 dark:text-zinc-600" />;
}

function DisplaySubagentStepItemRenderer({ part }: { part: DisplayPart }) {
  if (part.type === "thinking") {
    return <ThinkingBlock content={part.text} finished={part.finished} compact />;
  }
  if (part.type === "text") {
    return <Markdown content={part.text} className="text-[0.75rem] leading-relaxed" enableEnrichment={part.finished} />;
  }
  if (part.type === "plan") {
    return <PlanBlock entries={part.plan.entries} />;
  }
  if (part.type === "tool-call") {
    return <DisplayToolCallCard part={part} />;
  }
  return null;
}

function finalTextFromDisplaySteps(steps: DisplayStep[]): string {
  const lastStep = steps.at(-1);
  if (!lastStep) {
    return "";
  }

  return lastStep.parts
    .filter((part): part is Extract<DisplayPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function displayStatus(part: DisplayToolCallPart): "pending" | "success" | "error" {
  if (part.status === "error") {
    return "error";
  }
  if (part.status === "success") {
    return "success";
  }
  return "pending";
}

function DisplaySetTodoListTool({ part }: { part: DisplayToolCallPart }) {
  const fallbackItems = getTodoItemsForToolCall(part);

  if (fallbackItems.length === 0) {
    return <div className="py-2 text-xs text-muted-foreground">{part.status === "success" && "Todo list updated"}</div>;
  }

  return (
    <div className="py-1 w-full">
      <div className="space-y-1">
        {fallbackItems.map((item, idx) => (
          <div key={idx} className="flex items-start gap-1 py-0.5 w-full">
            <div className="mt-0.5 shrink-0">
              <TodoStatusIcon status={item.status} />
            </div>
            <span className={cn("flex-1 min-w-0 text-left text-xs leading-relaxed", item.status === "done" && "line-through text-muted-foreground")}>{item.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DisplayShellTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const command = (args.command as string) || "";
  const output = part.resultText ?? "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="text-[11px] text-foreground font-mono">{command}</span>
      </IORow>
      {showOutput && output && (
        <IORow label="OUT">
          <CodeBlock content={output} />
        </IORow>
      )}
    </div>
  );
}

function DisplayReadFileTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const filePath = (args.path as string) || "";
  const lineOffset = args.line_offset as number | undefined;
  const output = part.resultText ?? "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="inline-flex items-center gap-1.5">
          <FileLink path={filePath} display={filePath} />
          {lineOffset && lineOffset > 1 && <span className="text-[11px] text-muted-foreground">:L{lineOffset}</span>}
        </span>
      </IORow>
      {showOutput && output && (
        <IORow label="OUT">
          <CodeBlock content={output} maxLines={15} />
        </IORow>
      )}
    </div>
  );
}

function DisplayWriteFileTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const filePath = (args.path as string) || "";
  const mode = (args.mode as string) || "overwrite";
  const richDisplay = getRichToolDisplayBlocks(part.displayBlocks);
  const hasRichDisplay = richDisplay.length > 0;
  const output = part.resultText ?? "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="inline-flex items-center gap-1.5">
          <FileLink path={filePath} display={filePath} />
          <span className="text-[11px] text-muted-foreground">({mode})</span>
        </span>
      </IORow>
      {showOutput && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={displayBlocksToLegacy(richDisplay)} maxHeight="max-h-48" />
          ) : (
            <span className={cn("text-xs", part.status === "success" ? "text-emerald-500" : "text-red-500")}>{part.status === "success" ? "✓ Written" : output}</span>
          )}
        </IORow>
      )}
    </div>
  );
}

function DisplayStrReplaceFileTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const filePath = (args.path as string) || "";
  const richDisplay = getRichToolDisplayBlocks(part.displayBlocks);
  const hasRichDisplay = richDisplay.length > 0;
  const output = part.resultText ?? "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <FileLink path={filePath} display={filePath} />
      </IORow>
      {showOutput && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={displayBlocksToLegacy(richDisplay)} maxHeight="max-h-48" />
          ) : (
            <span className={cn("text-xs font-medium", part.status === "success" ? "text-emerald-600 dark:text-emerald-500" : "text-destructive")}>
              {part.status === "success" ? "✓ Replaced successfully" : output}
            </span>
          )}
        </IORow>
      )}
    </div>
  );
}

function DisplayGlobTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const pattern = (args.pattern as string) || "";
  const directory = args.directory as string | undefined;
  const output = part.resultText ?? "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="text-[11px] font-mono">
          {pattern}
          {directory && <span className="text-muted-foreground ml-1.5">in {directory}</span>}
        </span>
      </IORow>
      {showOutput && output && (
        <IORow label="OUT">
          <CodeBlock content={output} />
        </IORow>
      )}
    </div>
  );
}

function DisplayGenericTool({ part }: { part: DisplayToolCallPart }) {
  const args = parseArgs(part.argumentsText);
  const output = part.resultText ?? "";
  const richDisplay = getRichToolDisplayBlocks(part.displayBlocks);
  const hasRichDisplay = richDisplay.length > 0;
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <CodeBlock content={JSON.stringify(args, null, 2)} maxLines={8} />
      </IORow>
      {showOutput && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={displayBlocksToLegacy(richDisplay)} maxHeight="max-h-48" />
          ) : output ? (
            <CodeBlock content={output} />
          ) : (
            <span className={cn("text-xs", part.status === "success" ? "text-emerald-500" : "text-red-500")}>{part.status === "success" ? "✓ Done" : "✗ Failed"}</span>
          )}
        </IORow>
      )}
    </div>
  );
}

function DisplayTaskTool({ part }: { part: DisplayToolCallPart }) {
  const [showProcess, setShowProcess] = useState(false);
  const args = parseArgs(part.argumentsText);
  const description = (args.description as string) || "";
  const subagentName = (args.subagent_name as string) || (args.subagent_type as string) || "agent";
  const prompt = (args.prompt as string) || "";
  const subagentSteps = part.children ?? [];
  const hasSubagentSteps = subagentSteps.length > 0;
  const finalOutput = finalTextFromDisplaySteps(subagentSteps) || part.resultText || "";
  const showOutput = part.status === "success" || part.status === "error";

  return (
    <div className="divide-y divide-border">
      <div className="py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">{subagentName}</span>
          <span className="text-xs font-medium">{description}</span>
        </div>
        {prompt && <div className="text-[10px] text-muted-foreground line-clamp-2">{prompt}</div>}
      </div>
      {hasSubagentSteps && (
        <div className="py-2">
          <button onClick={() => setShowProcess(!showProcess)} className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground hover:text-foreground transition-colors">
            {showProcess ? <IconChevronDown className="size-3 shrink-0" /> : <IconChevronRight className="size-3 shrink-0" />}
            <span>
              {subagentSteps.length} step{subagentSteps.length > 1 ? "s" : ""}
            </span>
          </button>
          {showProcess && (
            <div className="mt-2 space-y-3">
              {subagentSteps.map((step) => (
                <div key={step.id} className="space-y-2">
                  <div className="text-[0.75rem] text-muted-foreground uppercase tracking-wider">Step {step.n}</div>
                  <div className="space-y-2">
                    {step.parts.map((childPart, idx) => (
                      <DisplaySubagentStepItemRenderer key={`${step.id}-${idx}`} part={childPart} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {showOutput && finalOutput && (
        <IORow label="OUT">
          <CodeBlock content={finalOutput} maxLines={15} />
        </IORow>
      )}
    </div>
  );
}

function DisplayToolCallContent({ part }: { part: DisplayToolCallPart }) {
  switch (part.name) {
    case "Shell":
      return <DisplayShellTool part={part} />;
    case "ReadFile":
      return <DisplayReadFileTool part={part} />;
    case "WriteFile":
      return <DisplayWriteFileTool part={part} />;
    case "StrReplaceFile":
      return <DisplayStrReplaceFileTool part={part} />;
    case "Glob":
      return <DisplayGlobTool part={part} />;
    case "Task":
    case "Agent":
      return <DisplayTaskTool part={part} />;
    case "SetTodoList":
      return <DisplaySetTodoListTool part={part} />;
    default:
      if (isTodoToolName(part.name)) {
        return <DisplaySetTodoListTool part={part} />;
      }
      return <DisplayGenericTool part={part} />;
  }
}

export function DisplayToolCallCard({ part }: DisplayToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const status = displayStatus(part);
  const subagentStepCount = part.children?.length ?? 0;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2 pr-8 hover:bg-muted/50 transition-colors text-left">
        <StatusIndicator status={status} />
        <ToolIcon name={part.name} />
        <span className="text-xs font-medium min-w-0 truncate">{part.name}</span>
        <span className="text-xs text-muted-foreground truncate flex-1 text-left">{getToolCallSummary(part.name, part.argumentsText)}</span>
        {subagentStepCount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500 shrink-0">{subagentStepCount} steps</span>}
        <IconChevronDown className={cn("size-3.5 text-muted-foreground transition-transform shrink-0", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div className="@container px-3 py-0.5 border-t border-border">
          <DisplayToolCallContent part={part} />
        </div>
      )}
    </div>
  );
}
