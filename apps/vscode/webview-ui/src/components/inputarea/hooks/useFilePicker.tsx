// webview-ui/src/components/inputarea/hooks/useFilePicker.tsx
import { useMemo, useState, useEffect, useCallback } from "react";
import { useRequest } from "ahooks";
import { useShallow } from "zustand/react/shallow";
import Fuse from "fuse.js";
import { bridge } from "@/services";
import { useChatStore } from "@/stores";
import { MEDIA_CONFIG } from "@/lib/media-utils";

export type FilePickerMode = "search" | "folder";

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  highlightedName?: React.ReactNode;
}

function highlightMatches(text: string, indices: readonly [number, number][] | undefined): React.ReactNode {
  if (!indices?.length) return text;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  for (const [start, end] of indices) {
    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push(
      <span key={start} className="text-primary font-semibold">
        {text.slice(start, end + 1)}
      </span>,
    );
    lastIndex = end + 1;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

interface ActiveToken {
  trigger: "/" | "@";
  start: number;
  query: string;
}

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
  loadAllFiles: () => void;
  setShowAddMenu: (show: boolean) => void;
  showAddMenu: boolean;
}

export function useFilePicker(
  activeToken: ActiveToken | null,
  onInsertFile: (path: string, isAddMenu: boolean) => void,
  onPickMedia: () => void,
  onCancel: () => void,
): UseFilePickerResult {
  const { isStreaming, draftMediaCount } = useChatStore(
    useShallow((state) => ({
      isStreaming: state.isStreaming,
      draftMediaCount: state.draftMedia.length,
    })),
  );
  const canAddMedia = !isStreaming && draftMediaCount < MEDIA_CONFIG.maxCount;

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filePickerMode, setFilePickerMode] = useState<FilePickerMode>("search");
  const [folderPath, setFolderPath] = useState("");
  const [showAddMenu, setShowAddMenu] = useState(false);

  const showFileMenu = activeToken?.trigger === "@" || showAddMenu;

  const {
    data: allFiles = [],
    loading: isLoadingAllFiles,
    run: loadAllFiles,
  } = useRequest(() => bridge.getProjectFiles({}), {
    manual: true,
    cacheKey: "project-files-all",
  });

  const {
    data: folderItems = [],
    loading: isFolderLoading,
    run: loadFolder,
  } = useRequest((dir: string) => bridge.getProjectFiles({ directory: dir }), {
    manual: true,
  });

  useEffect(() => {
    if (showFileMenu && filePickerMode === "search" && allFiles.length === 0) {
      loadAllFiles();
    }
  }, [showFileMenu, filePickerMode, allFiles.length, loadAllFiles]);

  useEffect(() => {
    if (showFileMenu && filePickerMode === "folder") {
      loadFolder(folderPath || ".");
    }
  }, [showFileMenu, filePickerMode, folderPath, loadFolder]);

  useEffect(() => {
    if (!showFileMenu) {
      setFilePickerMode("search");
      setFolderPath("");
      setShowAddMenu(false);
    }
  }, [showFileMenu]);

  const fuse = useMemo(
    () =>
      new Fuse(allFiles, {
        keys: ["path"],
        includeMatches: true,
        threshold: 0.4,
        ignoreLocation: true,
      }),
    [allFiles],
  );

  const fileItems = useMemo((): FileItem[] => {
    if (filePickerMode === "folder") {
      return folderItems.map((f) => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory,
      }));
    }

    const query = showAddMenu ? "" : activeToken?.query || "";
    if (!query) {
      return allFiles.slice(0, 30).map((f) => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory,
      }));
    }

    return fuse.search(query, { limit: 30 }).map((r) => {
      const pathMatch = r.matches?.find((m) => m.key === "path");
      return {
        name: r.item.name,
        path: r.item.path,
        isDirectory: r.item.isDirectory,
        highlightedName: highlightMatches(r.item.path, pathMatch?.indices),
      };
    });
  }, [filePickerMode, folderItems, allFiles, fuse, activeToken?.query, showAddMenu]);

  const isLoading = filePickerMode === "search" ? isLoadingAllFiles : isFolderLoading;
  const showMediaOption = filePickerMode === "search" && canAddMedia;
  const fileMenuHeaderCount = filePickerMode === "search" ? (showMediaOption ? 2 : 1) : folderPath ? 2 : 1;

  const resetFilePicker = useCallback(() => {
    setSelectedIndex(0);
    setFilePickerMode("search");
    setFolderPath("");
    setShowAddMenu(false);
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
      onInsertFile(item.path, showAddMenu);
    }
  }, [filePickerMode, selectedIndex, showMediaOption, folderPath, fileMenuHeaderCount, fileItems, onPickMedia, onInsertFile, showAddMenu]);

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
          if (showAddMenu) {
            setShowAddMenu(false);
          } else if (filePickerMode === "folder") {
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
    [showFileMenu, fileMenuHeaderCount, fileItems, filePickerMode, folderPath, selectedIndex, showAddMenu, handleFileMenuConfirm, onCancel],
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
    loadAllFiles,
    setShowAddMenu,
    showAddMenu,
  };
}
