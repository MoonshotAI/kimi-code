import { useState } from "react";
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
import { formatContentOutput } from "shared/legacy-sdk";
import { cleanSystemTags } from "shared/utils";
import { ThinkingBlock } from "./ThinkingBlock";
import type { UIToolCall, UIStep, UIStepItem } from "@/stores/chat.store";
import type { ToolResult, DisplayBlock, TodoBlock } from "shared/legacy-sdk";

type ToolResultValue = ToolResult["return_value"];

interface ToolRendererProps {
  call: UIToolCall;
  result?: ToolResultValue;
  subagentSteps?: UIStep[];
}

function parseArgs(args: string | null): Record<string, unknown> {
  if (!args) {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return { raw: args };
  }
}

function formatOutput(output: string | object | object[]): string {
  const raw = formatContentOutput(output as string);
  return cleanSystemTags(raw);
}

function getTodoBlock(display?: DisplayBlock[]): TodoBlock | null {
  if (!display) {
    return null;
  }
  return (display.find((b) => b.type === "todo") as TodoBlock) || null;
}

function getRichDisplayBlocks(display?: DisplayBlock[]): DisplayBlock[] {
  if (!display) {
    return [];
  }
  return display.filter((b) => b.type === "diff");
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
      <span className="relative flex size-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
        <span className="relative inline-flex rounded-full size-2 bg-amber-500" />
      </span>
    );
  }
  return <span className={cn("inline-flex rounded-full size-2", status === "success" ? "bg-emerald-500" : "bg-red-500")} />;
}

function ToolIcon({ name }: { name: string }) {
  const iconClass = "size-3.5 text-muted-foreground";
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
      return <IconSubtask className={iconClass} />;
    case "SetTodoList":
      return <IconListCheck className={iconClass} />;
    default:
      return <IconTerminal2 className={iconClass} />;
  }
}

function IORow({ label, children }: { label: "IN" | "OUT"; children: React.ReactNode }) {
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

function SetTodoListTool({ result }: ToolRendererProps) {
  const todoBlock = getTodoBlock(result?.display);
  if (!todoBlock || !todoBlock.items || todoBlock.items.length === 0) {
    return <div className="py-2 text-xs text-muted-foreground">{!result?.is_error && "Todo list updated"}</div>;
  }
  return (
    <div className="py-1">
      <div className="space-y-1">
        {todoBlock.items.map((item, idx) => (
          <div key={idx} className="flex items-start gap-1 py-0.5">
            <div className="mt-0.5">
              <TodoStatusIcon status={item.status} />
            </div>
            <span className={cn("text-xs leading-relaxed", item.status === "done" && "line-through text-muted-foreground")}>{item.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShellTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const command = (args.command as string) || "";
  const output = result ? formatOutput(result.output) : "";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="text-[11px] text-foreground font-mono">{command}</span>
      </IORow>
      {result && output && (
        <IORow label="OUT">
          <CodeBlock content={output} />
        </IORow>
      )}
    </div>
  );
}

function ReadFileTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const filePath = (args.path as string) || "";
  const lineOffset = args.line_offset as number | undefined;
  const output = result ? formatOutput(result.output) : "";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="inline-flex items-center gap-1.5">
          <FileLink path={filePath} display={filePath} />
          {lineOffset && lineOffset > 1 && <span className="text-[11px] text-muted-foreground">:L{lineOffset}</span>}
        </span>
      </IORow>
      {result && output && (
        <IORow label="OUT">
          <CodeBlock content={output} maxLines={15} />
        </IORow>
      )}
    </div>
  );
}

function WriteFileTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const filePath = (args.path as string) || "";
  const mode = (args.mode as string) || "overwrite";
  const richDisplay = getRichDisplayBlocks(result?.display);
  const hasRichDisplay = richDisplay.length > 0;

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="inline-flex items-center gap-1.5">
          <FileLink path={filePath} display={filePath} />
          <span className="text-[11px] text-muted-foreground">({mode})</span>
        </span>
      </IORow>
      {result && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={richDisplay} maxHeight="max-h-48" />
          ) : (
            <span className={cn("text-xs", !result.is_error ? "text-emerald-500" : "text-red-500")}>{!result.is_error ? "✓ Written" : formatOutput(result.output)}</span>
          )}
        </IORow>
      )}
    </div>
  );
}

function StrReplaceFileTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const filePath = (args.path as string) || "";
  const richDisplay = getRichDisplayBlocks(result?.display);
  const hasRichDisplay = richDisplay.length > 0;

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <FileLink path={filePath} display={filePath} />
      </IORow>
      {result && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={richDisplay} maxHeight="max-h-48" />
          ) : (
            <span className={cn("text-xs font-medium", !result.is_error ? "text-emerald-600 dark:text-emerald-500" : "text-destructive")}>
              {!result.is_error ? "✓ Replaced successfully" : formatOutput(result.output)}
            </span>
          )}
        </IORow>
      )}
    </div>
  );
}

function GlobTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const pattern = (args.pattern as string) || "";
  const directory = args.directory as string | undefined;
  const output = result ? formatOutput(result.output) : "";

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <span className="text-[11px] font-mono">
          {pattern}
          {directory && <span className="text-muted-foreground ml-1.5">in {directory}</span>}
        </span>
      </IORow>
      {result && output && (
        <IORow label="OUT">
          <CodeBlock content={output} />
        </IORow>
      )}
    </div>
  );
}

function GenericTool({ call, result }: ToolRendererProps) {
  const args = parseArgs(call.arguments);
  const output = result ? formatOutput(result.output) : "";
  const richDisplay = getRichDisplayBlocks(result?.display);
  const hasRichDisplay = richDisplay.length > 0;

  return (
    <div className="divide-y divide-border">
      <IORow label="IN">
        <CodeBlock content={JSON.stringify(args, null, 2)} maxLines={8} />
      </IORow>
      {result && (
        <IORow label="OUT">
          {hasRichDisplay ? (
            <DisplayBlocks blocks={richDisplay} maxHeight="max-h-48" />
          ) : output ? (
            <CodeBlock content={output} />
          ) : (
            <span className={cn("text-xs", !result.is_error ? "text-emerald-500" : "text-red-500")}>{!result.is_error ? "✓ Done" : "✗ Failed"}</span>
          )}
        </IORow>
      )}
    </div>
  );
}

function SubagentStepItemRenderer({ item }: { item: UIStepItem }) {
  if (item.type === "thinking") {
    return <ThinkingBlock content={item.content} finished={item.finished} compact />;
  }
  if (item.type === "text") {
    return <Markdown content={item.content} className="text-[0.75rem] leading-relaxed" enableEnrichment={item.finished} />;
  }
  if (item.type === "tool_use") {
    return <ToolCallCard call={item.call} result={item.result} subagentSteps={item.subagent_steps} />;
  }
  return null;
}

function TaskTool({ call, result, subagentSteps }: ToolRendererProps) {
  const [showProcess, setShowProcess] = useState(false);
  const args = parseArgs(call.arguments);
  const description = (args.description as string) || "";
  const subagentName = (args.subagent_name as string) || (args.subagent_type as string) || "coder";
  const prompt = (args.prompt as string) || "";
  const hasSubagentSteps = subagentSteps && subagentSteps.length > 0;

  const finalOutput = (() => {
    if (!hasSubagentSteps) {
      return result ? formatOutput(result.output) : "";
    }
    const lastStep = subagentSteps[subagentSteps.length - 1];
    const textItems = lastStep.items.filter((i) => i.type === "text");
    if (textItems.length > 0) {
      return textItems.map((i) => (i as { type: "text"; content: string }).content).join("\n");
    }
    return result ? formatOutput(result.output) : "";
  })();

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
            {showProcess ? <IconChevronDown className="size-3" /> : <IconChevronRight className="size-3" />}
            <span>
              {subagentSteps.length} step{subagentSteps.length > 1 ? "s" : ""}
            </span>
          </button>
          {showProcess && (
            <div className="mt-2 space-y-3">
              {subagentSteps.map((step) => (
                <div key={step.n} className="space-y-2">
                  <div className="text-[0.75rem] text-muted-foreground uppercase tracking-wider">Step {step.n}</div>
                  <div className="space-y-2">
                    {step.items.map((item, idx) => (
                      <SubagentStepItemRenderer key={`${step.n}-${idx}`} item={item} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {result && finalOutput && (
        <IORow label="OUT">
          <CodeBlock content={finalOutput} maxLines={15} />
        </IORow>
      )}
    </div>
  );
}

function getToolLabel(call: UIToolCall): string {
  const args = parseArgs(call.arguments);
  switch (call.name) {
    case "Shell":
      return (args.command as string) || "command";
    case "ReadFile":
      return (args.path as string)?.split("/").pop() || "file";
    case "WriteFile":
      return (args.path as string)?.split("/").pop() || "file";
    case "StrReplaceFile":
      return (args.path as string)?.split("/").pop() || "file";
    case "Glob":
      return (args.pattern as string) || "pattern";
    case "Task":
      return (args.description as string) || "subagent task";
    case "SetTodoList":
      return "Update Todos";
    default:
      return "";
  }
}

export function ToolCallCard({ call, result, subagentSteps }: ToolRendererProps) {
  const [expanded, setExpanded] = useState(false);
  const status = !result ? "pending" : !result.is_error ? "success" : "error";

  const renderContent = () => {
    const props = { call, result, subagentSteps };
    switch (call.name) {
      case "Shell":
        return <ShellTool {...props} />;
      case "ReadFile":
        return <ReadFileTool {...props} />;
      case "WriteFile":
        return <WriteFileTool {...props} />;
      case "StrReplaceFile":
        return <StrReplaceFileTool {...props} />;
      case "Glob":
        return <GlobTool {...props} />;
      case "Task":
      case "Agent":
        return <TaskTool {...props} />;
      case "SetTodoList":
        return <SetTodoListTool {...props} />;
      default:
        return <GenericTool {...props} />;
    }
  };

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors">
        <StatusIndicator status={status} />
        <ToolIcon name={call.name} />
        <span className="text-xs font-medium">{call.name}</span>
        <span className="text-xs text-muted-foreground truncate flex-1 text-left">{getToolLabel(call)}</span>
        {subagentSteps && subagentSteps.length > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-500">{subagentSteps.length} steps</span>}
        <IconChevronDown className={cn("size-3.5 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
      {expanded && <div className="@container px-3 py-0.5 border-t border-border">{renderContent()}</div>}
    </div>
  );
}
