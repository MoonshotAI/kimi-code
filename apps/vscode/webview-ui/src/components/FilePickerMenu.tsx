import { useEffect, useRef } from "react";
import { IconFolder, IconFile, IconArrowLeft, IconFolderOpen, IconPhoto } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export type FilePickerMode = "search" | "folder";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  highlightedName?: React.ReactNode;
}

interface FilePickerMenuProps {
  mode: FilePickerMode;
  items: FileItem[];
  currentPath: string;
  selectedIndex: number;
  isLoading?: boolean;
  showMediaOption?: boolean;
  onSelectMedia?: () => void;
  onSwitchToFolder: () => void;
  onSwitchToSearch: () => void;
  onSelectItem: (item: FileItem) => void;
  onNavigateUp: () => void;
  onNavigateInto: (item: FileItem) => void;
  onHover: (index: number) => void;
}

function truncateMiddle(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const ellipsis = "...";
  const charsToShow = maxLen - ellipsis.length;
  const frontChars = Math.ceil(charsToShow / 2);
  const backChars = Math.floor(charsToShow / 2);
  return str.slice(0, frontChars) + ellipsis + str.slice(-backChars);
}

export function FilePickerMenu({
  mode,
  items,
  currentPath,
  selectedIndex,
  isLoading,
  showMediaOption = true,
  onSelectMedia,
  onSwitchToFolder,
  onSwitchToSearch,
  onSelectItem,
  onNavigateUp,
  onNavigateInto,
  onHover,
}: FilePickerMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const preventFocus = (e: React.MouseEvent) => e.preventDefault();

  // Calculate header count based on mode and options
  const getHeaderCount = () => {
    if (mode === "search") {
      // Select media (if shown) + Browse folders
      return showMediaOption ? 2 : 1;
    } else {
      // Back to search + optional parent nav
      return currentPath ? 2 : 1;
    }
  };

  const headerCount = getHeaderCount();

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden">
      {mode === "search" ? (
        <>
          {showMediaOption && onSelectMedia && (
            <button
              ref={selectedIndex === 0 ? selectedRef : null}
              onMouseDown={preventFocus}
              onClick={onSelectMedia}
              onMouseEnter={() => onHover(0)}
              className={cn("w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border", selectedIndex === 0 ? "bg-accent" : "hover:bg-accent/50")}
            >
              <IconPhoto className="size-3.5 text-muted-foreground" />
              <span className="text-xs">Select images or videos...</span>
            </button>
          )}
          <button
            ref={selectedIndex === (showMediaOption ? 1 : 0) ? selectedRef : null}
            onMouseDown={preventFocus}
            onClick={onSwitchToFolder}
            onMouseEnter={() => onHover(showMediaOption ? 1 : 0)}
            className={cn(
              "w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border",
              selectedIndex === (showMediaOption ? 1 : 0) ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <IconFolderOpen className="size-3.5 text-muted-foreground" />
            <span className="text-xs">Browse folders...</span>
          </button>
        </>
      ) : (
        <>
          <button
            ref={selectedIndex === 0 ? selectedRef : null}
            onMouseDown={preventFocus}
            onClick={onSwitchToSearch}
            onMouseEnter={() => onHover(0)}
            className={cn("w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border", selectedIndex === 0 ? "bg-accent" : "hover:bg-accent/50")}
          >
            <IconArrowLeft className="size-3.5 text-muted-foreground" />
            <span className="text-xs">Back to search</span>
          </button>
          {currentPath && (
            <button
              ref={selectedIndex === 1 ? selectedRef : null}
              onMouseDown={preventFocus}
              onClick={onNavigateUp}
              onMouseEnter={() => onHover(1)}
              className={cn("w-full px-2 py-1.5 text-left flex items-center gap-2 border-b border-border/50", selectedIndex === 1 ? "bg-accent" : "hover:bg-accent/50")}
            >
              <IconFolder className="size-3.5 text-muted-foreground" />
              <span className="text-xs font-medium">..</span>
              <span className="text-[10px] text-muted-foreground truncate">({currentPath.split("/").pop()})</span>
            </button>
          )}
        </>
      )}
      <div className="max-h-64 overflow-y-auto">
        {isLoading ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">Loading...</div>
        ) : items.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-muted-foreground">{mode === "search" ? "No files found" : "Empty folder"}</div>
        ) : (
          items.map((item, idx) => {
            const itemIndex = idx + headerCount;
            return (
              <button
                key={item.path}
                ref={itemIndex === selectedIndex ? selectedRef : null}
                onMouseDown={preventFocus}
                onClick={() => {
                  if (item.isDirectory && mode === "search") {
                    onNavigateInto(item);
                  } else {
                    onSelectItem(item);
                  }
                }}
                onMouseEnter={() => onHover(itemIndex)}
                className={cn("w-full px-2 py-1.5 text-left flex items-center justify-between gap-3", itemIndex === selectedIndex ? "bg-accent" : "hover:bg-accent/50")}
              >
                <span className="flex items-center gap-1.5 text-xs shrink-0">
                  {item.isDirectory ? <IconFolder className="size-3 text-muted-foreground" /> : <IconFile className="size-3 text-muted-foreground" />}
                  <span className={cn(item.isDirectory && "font-medium")}>
                    {mode === "folder" ? item.name : item.highlightedName || item.name}
                    {item.isDirectory && "/"}
                  </span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground truncate max-w-32">{truncateMiddle(item.path, 25)}</span>
                  {item.isDirectory && mode === "folder" && <span className="text-[10px] text-muted-foreground">→</span>}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
