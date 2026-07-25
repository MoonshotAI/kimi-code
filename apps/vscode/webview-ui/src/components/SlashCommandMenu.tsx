import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { SlashCommandInfo } from "shared/legacy-sdk";

interface SlashCommandMenuProps {
  commands: SlashCommandInfo[];
  query: string;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onHover: (index: number) => void;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) {
    return text;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let qi = 0;

  for (let i = 0; i < text.length && qi < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[qi]) {
      if (i > lastIdx) {
        parts.push(text.slice(lastIdx, i));
      }
      parts.push(
        <span key={i} className="text-foreground font-semibold">
          {text[i]}
        </span>,
      );
      lastIdx = i + 1;
      qi++;
    }
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }
  return parts.length > 0 ? parts : text;
}

export function SlashCommandMenu({ commands, query, selectedIndex, onSelect, onHover }: SlashCommandMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return <div className="rounded-md border bg-popover shadow-md p-3 text-xs text-muted-foreground text-center">No commands found</div>;
  }

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden">
      <div className="max-h-70 overflow-y-auto">
        {commands.map((cmd, idx) => (
          <button
            key={cmd.name}
            ref={idx === selectedIndex ? selectedRef : null}
            onClick={() => onSelect(cmd.name)}
            onMouseEnter={() => onHover(idx)}
            className={cn("w-full px-2 py-1.5 text-left flex items-center justify-between gap-3", idx === selectedIndex ? "bg-accent" : "hover:bg-accent/50")}
          >
            <span className="text-xs shrink-0">{highlightMatch(`/${cmd.name}`, query)}</span>
            <span className="text-[10px] text-muted-foreground truncate">{cmd.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
