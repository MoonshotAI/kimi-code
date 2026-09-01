import { useMemo, useState, useEffect, useCallback } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import type { ProjectFile } from "shared/types";
import { bridge } from "@/services";
import { useChatStore } from "@/stores";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { MEDIA_CONFIG } from "@/services/config";

export type FilePickerMode = "search" | "folder";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface ActiveToken {
  trigger: "/" | "@";
  start: number;
  query: string;
}

const NO_FILES: ProjectFile[] = [];

interface UseFilePickerResult {
  showFileMenu: boolean;
  filePickerMode: FilePickerMode;
  folderPath: string;
  fileItems: FileItem[];
  selectedIndex: number;
  isLoading: boolean;
  showMediaOption: boolean;
  fileMenuHeaderCount: number;
  setSelectedIndex: (index: number) => void;
  setFilePickerMode: (mode: FilePickerMode) => void;
  setFolderPath: (path: string) => void;
  handleFileMenuKey: (e: React.KeyboardEvent) => boolean;
  resetFilePicker: () => void;
}

export function useFilePicker(activeToken: ActiveToken | null, onInsertFile: (path: string) => void, onPickMedia: () => void, onCancel: () => void): UseFilePickerResult {
  const { isStreaming, draftMedia } = useChatStore();
  const canAddMedia = !isStreaming && draftMedia.length < MEDIA_CONFIG.maxCount;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filePickerMode, setFilePickerMode] = useState<FilePickerMode>("search");
  const [folderPath, setFolderPath] = useState("");

  const showFileMenu = activeToken?.trigger === "@";
  const query = activeToken?.query || "";

  const debouncedQuery = useDebouncedValue(query, 100);
  const searchQuery = useQuery({
    queryKey: ["projectFiles", "search", debouncedQuery],
    queryFn: () => bridge.getProjectFiles({ query: debouncedQuery || undefined }),
    enabled: showFileMenu && filePickerMode === "search",
    placeholderData: keepPreviousData,
  });
  const searchResults = searchQuery.data ?? NO_FILES;
  const isSearchLoading = searchQuery.isLoading;

  const folderQuery = useQuery({
    queryKey: ["projectFiles", "folder", folderPath || "."],
    queryFn: () => bridge.getProjectFiles({ directory: folderPath || "." }),
    enabled: showFileMenu && filePickerMode === "folder",
  });
  const folderItems = folderQuery.data ?? NO_FILES;
  const isFolderLoading = folderQuery.isLoading;

  useEffect(() => {
    if (!showFileMenu) {
      setFilePickerMode("search");
      setFolderPath("");
    }
  }, [showFileMenu]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filePickerMode, folderPath]);

  const fileItems = useMemo((): FileItem[] => {
    if (filePickerMode === "folder") {
      return folderItems.map((f) => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory,
      }));
    }
    return searchResults.slice(0, 50).map((f) => ({
      name: f.name,
      path: f.path,
      isDirectory: f.isDirectory,
    }));
  }, [filePickerMode, folderItems, searchResults]);

  const isLoading = filePickerMode === "search" ? isSearchLoading : isFolderLoading;
  const showMediaOption = filePickerMode === "search" && canAddMedia;
  const fileMenuHeaderCount = filePickerMode === "search" ? (showMediaOption ? 2 : 1) : folderPath ? 2 : 1;

  const resetFilePicker = useCallback(() => {
    setSelectedIndex(0);
    setFilePickerMode("search");
    setFolderPath("");
  }, []);

  const handleFileMenuConfirm = useCallback(() => {
    if (filePickerMode === "search") {
      if (showMediaOption && selectedIndex === 0) {
        onPickMedia();
        return;
      }

      const browseIndex = showMediaOption ? 1 : 0;
      if (selectedIndex === browseIndex) {
        setFilePickerMode("folder");
        setFolderPath("");
        setSelectedIndex(0);
        return;
      }
    }

    if (filePickerMode === "folder" && selectedIndex === 0) {
      setFilePickerMode("search");
      setFolderPath("");
      setSelectedIndex(0);
      return;
    }

    if (filePickerMode === "folder" && selectedIndex === 1 && folderPath) {
      setFolderPath(folderPath.split("/").slice(0, -1).join("/"));
      setSelectedIndex(0);
      return;
    }

    const itemIndex = selectedIndex - fileMenuHeaderCount;
    const item = fileItems[itemIndex];
    if (!item) return;

    if (filePickerMode === "search" && item.isDirectory) {
      setFilePickerMode("folder");
      setFolderPath(item.path);
      setSelectedIndex(0);
    } else {
      onInsertFile(item.path);
    }
  }, [filePickerMode, selectedIndex, showMediaOption, folderPath, fileMenuHeaderCount, fileItems, onPickMedia, onInsertFile]);

  const handleFileMenuKey = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!showFileMenu) return false;

      const maxIdx = fileMenuHeaderCount + fileItems.length - 1;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, maxIdx));
          return true;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          return true;
        case "ArrowLeft":
          if (filePickerMode !== "folder") return false;
          e.preventDefault();
          if (folderPath) {
            setFolderPath(folderPath.split("/").slice(0, -1).join("/"));
          } else {
            setFilePickerMode("search");
          }
          setSelectedIndex(0);
          return true;
        case "ArrowRight": {
          if (filePickerMode !== "folder") return false;
          e.preventDefault();
          const itemForRight = fileItems[selectedIndex - fileMenuHeaderCount];
          if (itemForRight?.isDirectory) {
            setFolderPath(itemForRight.path);
            setSelectedIndex(0);
          }
          return true;
        }
        case "Tab":
        case "Enter":
          e.preventDefault();
          handleFileMenuConfirm();
          return true;
        case "Escape":
          e.preventDefault();
          if (filePickerMode === "folder") {
            setFilePickerMode("search");
            setFolderPath("");
            setSelectedIndex(0);
          } else {
            onCancel();
          }
          return true;
        default:
          return false;
      }
    },
    [showFileMenu, fileMenuHeaderCount, fileItems, filePickerMode, folderPath, selectedIndex, handleFileMenuConfirm, onCancel],
  );

  return {
    showFileMenu,
    filePickerMode,
    folderPath,
    fileItems,
    selectedIndex,
    isLoading,
    showMediaOption,
    fileMenuHeaderCount,
    setSelectedIndex,
    setFilePickerMode,
    setFolderPath,
    handleFileMenuKey,
    resetFilePicker,
  };
}
