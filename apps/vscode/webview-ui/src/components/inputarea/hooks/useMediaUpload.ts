import { useCallback, useEffect } from "react";
import { toast } from "@/components/ui/sonner";
import { bridge } from "@/services";
import { validateMediaFile, validateTotalSize, processMediaFile, getMediaType } from "@/lib/media-utils";
import { useChatStore } from "@/stores";
import { MEDIA_CONFIG } from "@/services/config";

interface UseMediaUploadResult {
  canAddMedia: boolean;
  handlePaste: (e: React.ClipboardEvent) => void;
  handlePickMedia: () => Promise<void>;
  addMediaFiles: (files: File[]) => void;
}

export function useMediaUpload(): UseMediaUploadResult {
  const { draftMedia, addDraftMedia, updateDraftMedia, removeDraftMedia } = useChatStore();

  const hasProcessing = draftMedia.some((m) => !m.dataUri);
  const canAddMedia = draftMedia.length < MEDIA_CONFIG.maxCount;

  const getExistingDataUris = useCallback((): string[] => {
    return draftMedia.filter((m) => m.dataUri).map((m) => m.dataUri!);
  }, [draftMedia]);

  const processFile = useCallback(
    async (file: File) => {
      const error = validateMediaFile(file, draftMedia.length);
      if (error) {
        toast.error(error.message);
        return;
      }

      const id = crypto.randomUUID();
      addDraftMedia(id);

      try {
        const dataUri = await processMediaFile(file);
        const totalError = validateTotalSize(getExistingDataUris(), dataUri);
        if (totalError) {
          removeDraftMedia(id);
          toast.error(totalError.message);
          return;
        }
        updateDraftMedia(id, dataUri);
      } catch {
        removeDraftMedia(id);
        toast.error("Failed to process media file");
      }
    },
    [draftMedia.length, addDraftMedia, updateDraftMedia, removeDraftMedia, getExistingDataUris],
  );

  const addMediaFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        void processFile(file);
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
    if (hasProcessing || draftMedia.length >= MEDIA_CONFIG.maxCount) {
      return;
    }
    const remaining = MEDIA_CONFIG.maxCount - draftMedia.length;
    try {
      const media = await bridge.pickMedia(remaining, true);
      const existingUris = getExistingDataUris();

      for (const dataUri of media) {
        const totalError = validateTotalSize(existingUris, dataUri);
        if (totalError) {
          toast.error(totalError.message);
          break;
        }
        existingUris.push(dataUri);
        addDraftMedia(crypto.randomUUID(), dataUri);
      }
    } catch {
      toast.error("Failed to pick media");
    }
  }, [hasProcessing, draftMedia.length, addDraftMedia, getExistingDataUris]);

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
      if (hasProcessing) {
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
  }, [hasProcessing, draftMedia.length, addMediaFiles]);

  return {
    canAddMedia,
    handlePaste,
    handlePickMedia,
    addMediaFiles,
  };
}
