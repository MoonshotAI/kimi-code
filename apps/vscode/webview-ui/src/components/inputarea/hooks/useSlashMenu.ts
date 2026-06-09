import { useMemo, useState, useCallback } from "react";
import type { SlashCommand } from "@/services";

export interface GroupedSlashCommands {
  group?: string;
  commands: SlashCommand[];
}

interface ActiveToken {
  trigger: "/" | "@";
  start: number;
  query: string;
}

function fuzzyMatch(text: string, query: string): boolean {
  if (!query) {
    return true;
  }
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < lowerText.length && qi < lowerQuery.length; i++) {
    if (lowerText[i] === lowerQuery[qi]) {
      qi++;
    }
  }
  return qi === lowerQuery.length;
}

export function findActiveToken(text: string, cursorPos: number): ActiveToken | null {
  const beforeCursor = text.slice(0, cursorPos);
  const lastSpace = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\n"), beforeCursor.lastIndexOf("\t"), -1);
  const currentWord = beforeCursor.slice(lastSpace + 1);

  if (currentWord.startsWith("@")) {
    return { trigger: "@", start: lastSpace + 1, query: currentWord.slice(1) };
  }
  if (currentWord.startsWith("/")) {
    return { trigger: "/", start: lastSpace + 1, query: currentWord.slice(1) };
  }
  return null;
}

interface UseSlashMenuResult {
  showSlashMenu: boolean;
  filteredCommands: SlashCommand[];
  groupedCommands: GroupedSlashCommands[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleSlashMenuKey: (e: React.KeyboardEvent) => boolean;
  resetSlashMenu: () => void;
}

export function useSlashMenu(
  activeToken: ActiveToken | null,
  commands: SlashCommand[],
  onSelectCommand: (name: string) => void,
  onCancel: () => void,
): UseSlashMenuResult {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const showSlashMenu = activeToken?.trigger === "/";

  const { filteredCommands, groupedCommands } = useMemo(() => {
    if (!showSlashMenu) {
      return { filteredCommands: [], groupedCommands: [] };
    }
    const q = activeToken.query;
    const filtered = q
      ? commands.filter((cmd) => fuzzyMatch(cmd.name, q) || fuzzyMatch(cmd.description, q))
      : [...commands];

    const groups = new Map<string | undefined, SlashCommand[]>();
    for (const cmd of filtered) {
      const group = cmd.group;
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group)!.push(cmd);
    }

    const groupOrder = (a: GroupedSlashCommands, b: GroupedSlashCommands): number => {
      // Builtins (undefined / "builtin") first, then alphabetically by group name
      const rank = (g?: string) => (g === undefined || g === "builtin" ? 0 : 1);
      const diff = rank(a.group) - rank(b.group);
      if (diff !== 0) return diff;
      return (a.group ?? "").localeCompare(b.group ?? "");
    };

    const grouped = Array.from(groups.entries())
      .map(([group, groupCommands]) => ({ group, commands: groupCommands }))
      .sort(groupOrder);

    return { filteredCommands: filtered, groupedCommands: grouped };
  }, [showSlashMenu, activeToken?.query, commands]);

  const resetSlashMenu = useCallback(() => {
    setSelectedIndex(0);
  }, []);

  const handleSlashMenuKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showSlashMenu || filteredCommands.length === 0) {
        return false;
      }

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Tab":
        case "Enter": {
          e.preventDefault();
          const cmd = filteredCommands[selectedIndex];
          if (cmd) {
            onSelectCommand(cmd.name);
          }
          return true;
        }
        case "Escape":
          e.preventDefault();
          onCancel();
          return true;
        default:
          return false;
      }
    },
    [showSlashMenu, filteredCommands, selectedIndex, onSelectCommand, onCancel],
  );

  return {
    showSlashMenu,
    filteredCommands,
    groupedCommands,
    selectedIndex,
    setSelectedIndex,
    handleSlashMenuKey,
    resetSlashMenu,
  };
}
