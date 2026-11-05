import { useEffect, useRef } from "react";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { QuestionItem } from "./inputarea/hooks/useQuestionsHistory";

interface QuestionsHistoryMenuProps {
  items: QuestionItem[];
  totalCount: number;
  query: string;
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onSelect: (item: QuestionItem) => void;
  onHide: (id: string) => void;
  onHover: (index: number) => void;
  onMoveActive: (delta: number) => void;
  onClose: () => void;
}

export function QuestionsHistoryMenu({ items, totalCount, query, activeIndex, onQueryChange, onSelect, onHide, onHover, onMoveActive, onClose }: QuestionsHistoryMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  const hoverSelectionRef = useRef<number | null>(null);

  useEffect(() => {
    if (hoverSelectionRef.current === activeIndex) {
      hoverSelectionRef.current = null;
      return;
    }
    hoverSelectionRef.current = null;
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleHover = (index: number) => {
    hoverSelectionRef.current = index;
    onHover(index);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        onMoveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        onMoveActive(-1);
        break;
      case "Enter": {
        e.preventDefault();
        const target = items[activeIndex] ?? (items.length === 1 ? items[0] : undefined);
        if (target) {
          onSelect(target);
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  };

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden flex flex-col max-h-[40vh]">
      <input
        autoFocus
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Filter questions… (↑↓ select, Enter jump, Esc close)"
        className="px-2 py-1.5 text-xs bg-transparent outline-none border-b placeholder:text-muted-foreground"
      />
      <div className="overflow-y-auto min-h-0">
        {items.length === 0 ? (
          <div className="p-3 text-xs text-muted-foreground text-center">
            {totalCount === 0 ? "No questions yet in this session" : "No matches"}
          </div>
        ) : (
          items.map((item, idx) => (
            <button
              key={item.id}
              ref={idx === activeIndex ? selectedRef : null}
              onClick={() => onSelect(item)}
              onMouseMove={() => handleHover(idx)}
              className={cn("w-full px-2 py-1.5 text-left flex items-center justify-between gap-2 group", idx === activeIndex ? "bg-accent" : "hover:bg-accent/50")}
            >
              <span className="text-xs truncate" title={item.text}>
                {item.text}
              </span>
              <span
                role="button"
                title="Hide for this session"
                onClick={(e) => {
                  e.stopPropagation();
                  onHide(item.id);
                }}
                className="shrink-0 invisible group-hover:visible rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <IconX className="size-3" />
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
