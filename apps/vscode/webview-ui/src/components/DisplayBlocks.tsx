import { useMemo } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import type { DisplayBlock, DiffBlock, TodoBlock, BriefBlock, ShellBlock } from "shared/legacy-sdk";
import { cn } from "@/lib/utils";
import * as Diff from "diff";

function useIsDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

interface DiffBlockProps {
  block: DiffBlock;
  maxHeight?: string;
}

interface DiffPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

function renderDiffLine(parts: DiffPart[], type: "added" | "removed"): React.ReactNode {
  return parts.map((part, i) => {
    if (type === "removed") {
      if (part.added) return null;
      return (
        <span key={i} className={cn(part.removed && "bg-red-300/50 dark:bg-red-700/50 rounded-sm")}>
          {part.value}
        </span>
      );
    } else {
      if (part.removed) return null;
      return (
        <span key={i} className={cn(part.added && "bg-emerald-300/50 dark:bg-emerald-700/50 rounded-sm")}>
          {part.value}
        </span>
      );
    }
  });
}

// Extract diff computation to a pure function for memoization
function computeDiffLines(oldText: string, newText: string): { oldLines: DiffPart[][]; newLines: DiffPart[][] } {
  const diffParts = Diff.diffWords(oldText, newText);

  const oldLines: DiffPart[][] = [];
  const newLines: DiffPart[][] = [];
  let currentOldLine: DiffPart[] = [];
  let currentNewLine: DiffPart[] = [];

  for (const part of diffParts) {
    const lines = part.value.split("\n");
    lines.forEach((line, lineIndex) => {
      const isLastLine = lineIndex === lines.length - 1;
      const partForLine: DiffPart = {
        value: line,
        added: part.added,
        removed: part.removed,
      };

      if (!part.added) {
        currentOldLine.push(partForLine);
      }
      if (!part.removed) {
        currentNewLine.push(partForLine);
      }

      if (!isLastLine) {
        if (!part.added) {
          oldLines.push(currentOldLine);
          currentOldLine = [];
        }
        if (!part.removed) {
          newLines.push(currentNewLine);
          currentNewLine = [];
        }
      }
    });
  }

  if (currentOldLine.length > 0) oldLines.push(currentOldLine);
  if (currentNewLine.length > 0) newLines.push(currentNewLine);

  return { oldLines, newLines };
}

export function DiffBlockView({ block, maxHeight = "max-h-40" }: DiffBlockProps) {
  const fileName = block.path.split("/").pop() || block.path;
  const hasOld = block.old_text.length > 0;
  const hasNew = block.new_text.length > 0;

  const { oldLines, newLines } = useMemo(() => computeDiffLines(block.old_text, block.new_text), [block.old_text, block.new_text]);

  return (
    <div className="text-[11px] border border-border rounded-md overflow-hidden">
      <div className="px-2 py-1 bg-muted/50 border-b border-border text-muted-foreground truncate">{fileName}</div>
      <div className="flex flex-col md:flex-row">
        {hasOld && (
          <div className="bg-red-500/5 dark:bg-red-500/10 border-b md:border-b-0 md:border-r border-border/50 flex-1 min-w-0">
            <div className={cn("px-2 py-1.5 overflow-auto", maxHeight)}>
              {oldLines.map((lineParts, i) => (
                <div key={i} className="flex">
                  <span className="text-red-500 select-none mr-2 shrink-0">-</span>
                  <span className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-all">{renderDiffLine(lineParts, "removed") || " "}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {hasNew && (
          <div className="bg-emerald-500/5 dark:bg-emerald-500/10 flex-1 min-w-0">
            <div className={cn("px-2 py-1.5 overflow-auto", maxHeight)}>
              {newLines.map((lineParts, i) => (
                <div key={i} className="flex">
                  <span className="text-emerald-500 select-none mr-2 shrink-0">+</span>
                  <span className="text-emerald-600 dark:text-emerald-400 whitespace-pre-wrap break-all">{renderDiffLine(lineParts, "added") || " "}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TodoBlockProps {
  block: TodoBlock;
}

export function TodoBlockView({ block }: TodoBlockProps) {
  return (
    <div className="text-xs border border-border rounded-md overflow-hidden">
      {block.items.map((item, i) => (
        <div key={i} className={cn("px-2 py-1.5 flex items-center gap-2", i !== block.items.length - 1 && "border-b border-border/50")}>
          <span
            className={cn(
              "size-2 rounded-full shrink-0",
              item.status === "done" && "bg-emerald-500",
              item.status === "in_progress" && "bg-amber-500",
              item.status === "pending" && "bg-zinc-400",
            )}
          />
          <span className="truncate">{item.title}</span>
        </div>
      ))}
    </div>
  );
}

interface BriefBlockProps {
  block: BriefBlock;
}

export function BriefBlockView({ block }: BriefBlockProps) {
  return <div className="text-xs text-muted-foreground bg-muted/30 rounded-md px-2 py-1.5">{block.text}</div>;
}

interface ShellBlockProps {
  block: ShellBlock;
  maxHeight?: string;
}

export function ShellBlockView({ block, maxHeight = "max-h-40" }: ShellBlockProps) {
  console.log("ShellBlockView render", { block });
  const isDark = useIsDark();
  const language = block.language || "bash";

  return (
    <div className="text-[11px] border border-border rounded-md overflow-hidden">
      <div className="px-2 py-1 bg-muted/50 border-b border-border text-muted-foreground flex items-center gap-2">
        <span className="font-mono">$</span>
        <span>Shell Command</span>
      </div>
      <div className={cn("overflow-auto", maxHeight)}>
        <SyntaxHighlighter
          style={isDark ? oneDark : oneLight}
          language={language}
          PreTag="div"
          customStyle={{ margin: 0, padding: "0.5rem", fontSize: "11px", background: "transparent" }}
          codeTagProps={{ style: { backgroundColor: "transparent" } }}
        >
          {block.command}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

interface DisplayBlockViewProps {
  block: DisplayBlock;
  maxHeight?: string;
}

export function DisplayBlockView({ block, maxHeight }: DisplayBlockViewProps) {
  switch (block.type) {
    case "diff":
      return <DiffBlockView block={block as DiffBlock} maxHeight={maxHeight} />;
    case "todo":
      return <TodoBlockView block={block as TodoBlock} />;
    case "brief":
      return <BriefBlockView block={block as BriefBlock} />;
    default:
      return null;
  }
}

interface DisplayBlocksProps {
  blocks: DisplayBlock[];
  maxHeight?: string;
  className?: string;
}

export function DisplayBlocks({ blocks, maxHeight, className }: DisplayBlocksProps) {
  if (!blocks || blocks.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-2", className)}>
      {blocks.map((block, i) => (
        <DisplayBlockView key={i} block={block} maxHeight={maxHeight} />
      ))}
    </div>
  );
}
