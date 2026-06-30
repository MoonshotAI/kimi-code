import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { GroupedSlashCommands } from "./inputarea/hooks/useSlashMenu";

interface SlashCommand {
  name: string;
  description: string;
}

interface SlashCommandMenuProps {
  commands: SlashCommand[];
  groupedCommands?: GroupedSlashCommands[];
  query: string;
  selectedIndex: number;
  onSelect: (name: string) => void;
  onHover: (index: number) => void;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  let qi = 0;

  for (let i = 0; i < text.length && qi < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[qi]) {
      if (i > lastIdx) parts.push(text.slice(lastIdx, i));
      parts.push(
        <span key={i} className="text-primary font-semibold">
          {text[i]}
        </span>,
      );
      lastIdx = i + 1;
      qi++;
    }
  }

  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : text;
}

export function SlashCommandMenu({ commands, groupedCommands, query, selectedIndex, onSelect, onHover }: SlashCommandMenuProps) {
  const selectedRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (commands.length === 0) {
    return <div className="rounded-md border bg-popover shadow-md p-3 text-xs text-muted-foreground text-center">No commands found</div>;
  }

  const groups: GroupedSlashCommands[] = groupedCommands && groupedCommands.length > 0 ? groupedCommands : [{ commands }];

  return (
    <div className="rounded-md border bg-popover shadow-md overflow-hidden">
      <div className="max-h-70 overflow-y-auto">
        {groups.map((group, groupIdx) => {
          const isFirstGroup = groupIdx === 0;
          return (
            <div key={group.group ?? "__default__"}>
              {group.group && (
                <div className={cn("px-2 py-1 text-[10px] font-semibold text-muted-foreground bg-muted/50 uppercase tracking-wider", !isFirstGroup && "border-t")}>
                  {group.group}
                </div>
              )}
              {group.commands.map((cmd) => {
                const globalIndex = commands.indexOf(cmd);
                return (
                  <button
                    key={cmd.name}
                    ref={globalIndex === selectedIndex ? selectedRef : null}
                    onClick={() => onSelect(cmd.name)}
                    onMouseEnter={() => onHover(globalIndex)}
                    className={cn(
                      "w-full px-2 py-1.5 text-left flex items-center justify-between gap-3",
                      globalIndex === selectedIndex ? "bg-accent" : "hover:bg-accent/50",
                    )}
                  >
                    <span className="text-xs shrink-0">{highlightMatch(`/${cmd.name}`, query)}</span>
                    <span className="text-[10px] text-muted-foreground truncate">{cmd.description}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
