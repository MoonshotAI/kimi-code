import { useMemo, useState, useEffect, useCallback } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { ProjectFile } from "shared/types";
import { bridge } from "@/services";
import { useChatStore } from "@/stores";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { MEDIA_CONFIG } from "@/services/config";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  matchPositions?: number[];
}

interface ActiveToken {
  trigger: "/" | "@";
  start: number;
  query: string;
}

const NO_FILES: ProjectFile[] = [];

interface UseFilePickerResult {
  showFileMenu: boolean;
  fileItems: FileItem[];
  selectedIndex: number;
  isLoading: boolean;
  showMediaOption: boolean;
  fileMenuHeaderCount: number;
  setSelectedIndex: (index: number) => void;
  handleFileMenuKey: (e: React.KeyboardEvent) => boolean;
  resetFilePicker: () => void;
}

export function useFilePicker(activeToken: ActiveToken | null, onInsertFile: (path: string) => void, onPickMedia: () => void, onCancel: () => void): UseFilePickerResult {
  const { isStreaming, draftMedia } = useChatStore();
  const canAddMedia = !isStreaming && draftMedia.length < MEDIA_CONFIG.maxCount;

  const [selectedIndex, setSelectedIndex] = useState(0);

  const showFileMenu = activeToken?.trigger === "@";
  const query = activeToken?.query || "";

  const debouncedQuery = useDebouncedValue(query, 100);
  const searchQuery = useQuery({
    queryKey: ["projectFiles", "search", debouncedQuery],
    queryFn: () => bridge.getProjectFiles({ query: debouncedQuery || undefined }),
    enabled: showFileMenu,
    placeholderData: keepPreviousData,
  });
  const searchResults = searchQuery.data ?? NO_FILES;
  const isLoading = searchQuery.isLoading;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const fileItems = useMemo((): FileItem[] => {
    return searchResults.map((f) => ({
      name: f.name,
      path: f.path,
      isDirectory: f.isDirectory,
      matchPositions: f.matchPositions,
    }));
  }, [searchResults]);

  const showMediaOption = canAddMedia && query === "";
  const fileMenuHeaderCount = showMediaOption ? 1 : 0;

  const resetFilePicker = useCallback(() => {
    setSelectedIndex(0);
  }, []);

  const handleFileMenuConfirm = useCallback(() => {
    if (showMediaOption && selectedIndex === 0) {
      onPickMedia();
      return;
    }

    const item = fileItems[selectedIndex - fileMenuHeaderCount];
    if (!item) return;
    onInsertFile(item.path);
  }, [selectedIndex, showMediaOption, fileMenuHeaderCount, fileItems, onPickMedia, onInsertFile]);

  const handleFileMenuKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showFileMenu) return false;

      const maxIdx = Math.max(0, fileMenuHeaderCount + fileItems.length - 1);

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, maxIdx));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case "Tab":
        case "Enter":
          e.preventDefault();
          handleFileMenuConfirm();
          return true;
        case "Escape":
          e.preventDefault();
          onCancel();
          return true;
        default:
          return false;
      }
    },
    [showFileMenu, fileMenuHeaderCount, fileItems, handleFileMenuConfirm, onCancel],
  );

  return {
    showFileMenu,
    fileItems,
    selectedIndex,
    isLoading,
    showMediaOption,
    fileMenuHeaderCount,
    setSelectedIndex,
    handleFileMenuKey,
    resetFilePicker,
  };
}
