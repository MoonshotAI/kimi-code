import { useMemo, useState, useCallback } from "react";
import { useSettingsStore } from "@/stores";
import type { SlashCommandInfo } from "shared/legacy-sdk";

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
  filteredCommands: SlashCommandInfo[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  handleSlashMenuKey: (e: React.KeyboardEvent) => boolean;
  resetSlashMenu: () => void;
}

export function useSlashMenu(activeToken: ActiveToken | null, onSelectCommand: (name: string) => void, onCancel: () => void): UseSlashMenuResult {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { slashCommands } = useSettingsStore();

  const showSlashMenu = activeToken?.trigger === "/";

  const filteredCommands = useMemo(() => {
    if (!showSlashMenu) {
      return [];
    }
    const q = activeToken.query;
    if (!q) {
      return slashCommands;
    }
    return slashCommands.filter((cmd) => fuzzyMatch(cmd.name, q) || fuzzyMatch(cmd.description, q));
  }, [showSlashMenu, activeToken?.query, slashCommands]);

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
    selectedIndex,
    setSelectedIndex,
    handleSlashMenuKey,
    resetSlashMenu,
  };
}
