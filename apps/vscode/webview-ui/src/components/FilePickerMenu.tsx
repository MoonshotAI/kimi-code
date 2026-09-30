import { Fragment, useEffect, useRef } from "react";
import { IconFolder, IconFile, IconPhoto } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { mentionMatchSpans, type MentionMatchSpan } from "@/lib/mention-match";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  matchPositions?: number[];
}

interface FilePickerMenuProps {
  items: FileItem[];
  selectedIndex: number;
  isLoading?: boolean;
  isStale?: boolean;
  showMediaOption?: boolean;
  onSelectMedia?: () => void;
  onSelectItem: (item: FileItem) => void;
  onHover: (index: number) => void;
}

function parentDir(path: string): string {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? "" : trimmed.slice(0, idx);
}

function nameSpans(item: FileItem): MentionMatchSpan[] {
  const path = item.path.endsWith("/") ? item.path.slice(0, -1) : item.path;
  return mentionMatchSpans(item.name, item.matchPositions, Math.max(0, path.length - item.name.length));
}

function dirSpans(item: FileItem): MentionMatchSpan[] {
  return mentionMatchSpans(parentDir(item.path), item.matchPositions, 0);
}

export function FilePickerMenu({
  items,
  selectedIndex,
  isLoading,
  isStale = false,
  showMediaOption = true,
  onSelectMedia,
  onSelectItem,
  onHover,
}: FilePickerMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const hoverSelectionRef = useRef<number | null>(null);

  useEffect(() => {
    if (hoverSelectionRef.current === selectedIndex) {
      hoverSelectionRef.current = null;
      return;
    }
    hoverSelectionRef.current = null;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const handleHover = (index: number) => {
    if (isStale) return;
    hoverSelectionRef.current = index;
    onHover(index);
  };

  const headerCount = showMediaOption ? 1 : 0;

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden">
      {showMediaOption && onSelectMedia && (
        <button
          ref={selectedIndex === 0 ? selectedRef : null}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSelectMedia}
          onMouseMove={() => handleHover(0)}
          className={cn("w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border", selectedIndex === 0 ? "bg-accent" : "hover:bg-accent/50")}
        >
          <IconPhoto className="size-3.5 text-muted-foreground" />
          <span className="text-xs">Select images or videos…</span>
        </button>
      )}
      <div className={cn("max-h-64 overflow-y-auto", isStale && "opacity-60")}>
        {isLoading ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">Loading…</div>
        ) : items.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">No files found</div>
        ) : (
          items.map((item, idx) => {
            const itemIndex = idx + headerCount;
            const dir = parentDir(item.path);
            return (
              <button
                key={item.path}
                ref={itemIndex === selectedIndex ? selectedRef : null}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelectItem(item)}
                onMouseMove={() => handleHover(itemIndex)}
                className={cn("w-full px-2 py-1.5 text-left flex items-center justify-between gap-3", itemIndex === selectedIndex ? "bg-accent" : "hover:bg-accent/50")}
              >
                <span className="flex items-center gap-1.5 text-xs shrink-0">
                  {item.isDirectory ? <IconFolder className="size-3 text-muted-foreground" /> : <IconFile className="size-3 text-muted-foreground" />}
                  <span className={cn(item.isDirectory && "font-medium")}>
                    {nameSpans(item).map((span, spanIdx) =>
                      span.hit ? (
                        <span key={spanIdx} className="text-foreground font-semibold">{span.text}</span>
                      ) : (
                        <Fragment key={spanIdx}>{span.text}</Fragment>
                      ),
                    )}
                    {item.isDirectory && "/"}
                  </span>
                </span>
                {dir && (
                  <span className="text-[10px] text-muted-foreground truncate max-w-32">
                    {dirSpans(item).map((span, spanIdx) =>
                      span.hit ? (
                        <span key={spanIdx} className="text-foreground">{span.text}</span>
                      ) : (
                        <Fragment key={spanIdx}>{span.text}</Fragment>
                      ),
                    )}
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
