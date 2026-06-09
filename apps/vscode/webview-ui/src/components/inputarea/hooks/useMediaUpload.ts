import { useCallback, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "@/components/ui/sonner";
import { bridge } from "@/services";
import { MEDIA_CONFIG, validateMediaFile, processMediaFile, getMediaType } from "@/lib/media-utils";
import { generateId } from "@/lib/id";
import { useChatStore } from "@/stores";

interface UseMediaUploadResult {
  canAddMedia: boolean;
  handlePaste: (e: React.ClipboardEvent) => void;
  handlePickMedia: () => Promise<void>;
  addMediaFiles: (files: File[]) => void;
}

export function useMediaUpload(): UseMediaUploadResult {
  const { isStreaming, draftMedia, addDraftMedia, updateDraftMedia, removeDraftMedia } = useChatStore(
    useShallow((state) => ({
      isStreaming: state.isStreaming,
      draftMedia: state.draftMedia,
      addDraftMedia: state.addDraftMedia,
      updateDraftMedia: state.updateDraftMedia,
      removeDraftMedia: state.removeDraftMedia,
    })),
  );

  const hasProcessing = draftMedia.some((m) => !m.dataUri);
  const canAddMedia = !isStreaming && draftMedia.length < MEDIA_CONFIG.maxCount;

  const processFile = useCallback(
    async (file: File) => {
      const error = validateMediaFile(file, draftMedia.length);
      if (error) {
        toast.error(error.message);
        return;
      }

      const id = generateId();
      addDraftMedia(id);

      try {
        const dataUri = await processMediaFile(file);
        updateDraftMedia(id, dataUri);
      } catch {
        removeDraftMedia(id);
        toast.error("Failed to process media file");
      }
    },
    [draftMedia.length, addDraftMedia, updateDraftMedia, removeDraftMedia],
  );

  const addMediaFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        processFile(file);
      }
    },
    [processFile],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const mediaFiles: File[] = [];

      for (const item of items) {
        if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
          const file = item.getAsFile();
          if (file) {
            mediaFiles.push(file);
          }
        }
      }

      if (mediaFiles.length === 0) {
        return;
      }

      e.preventDefault();
      addMediaFiles(mediaFiles);
    },
    [addMediaFiles],
  );

  const handlePickMedia = useCallback(async () => {
    if (isStreaming || hasProcessing || draftMedia.length >= MEDIA_CONFIG.maxCount) {
      return;
    }
    const remaining = MEDIA_CONFIG.maxCount - draftMedia.length;
    try {
      const media = await bridge.pickMedia(remaining, true);
      for (const dataUri of media) {
        addDraftMedia(generateId(), dataUri);
      }
    } catch {
      toast.error("Failed to pick media");
    }
  }, [isStreaming, hasProcessing, draftMedia.length, addDraftMedia]);

  useEffect(() => {
    const isMediaFile = (file: File) => getMediaType(file) !== null;

    const handleDocDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDocDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "copy";
      }
    };

    const handleDocDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (hasProcessing || isStreaming) {
        return;
      }
      if (draftMedia.length >= MEDIA_CONFIG.maxCount) {
        toast.error(`Maximum ${MEDIA_CONFIG.maxCount} media files allowed`);
        return;
      }

      const files = Array.from(e.dataTransfer?.files || []).filter(isMediaFile);
      if (files.length === 0) {
        return;
      }
      addMediaFiles(files);
    };

    document.addEventListener("dragenter", handleDocDragEnter);
    document.addEventListener("dragover", handleDocDragOver);
    document.addEventListener("drop", handleDocDrop);

    return () => {
      document.removeEventListener("dragenter", handleDocDragEnter);
      document.removeEventListener("dragover", handleDocDragOver);
      document.removeEventListener("drop", handleDocDrop);
    };
  }, [hasProcessing, isStreaming, draftMedia.length, addMediaFiles]);

  return {
    canAddMedia,
    handlePaste,
    handlePickMedia,
    addMediaFiles,
  };
}
