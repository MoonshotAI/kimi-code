import { useEffect, useCallback } from "react";
import { IconX } from "@tabler/icons-react";
import { getMediaTypeFromDataUri } from "@/lib/media-utils";

function ImagePreview({ src }: { src: string }) {
  return <img src={src} alt="Preview" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />;
}

function VideoPreview({ src }: { src: string }) {
  return <video src={src} className="max-w-[90vw] max-h-[90vh] rounded-lg" controls autoPlay onClick={(e) => e.stopPropagation()} />;
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors">
      <IconX className="size-5" />
    </button>
  );
}

interface MediaPreviewModalProps {
  src: string | null;
  onClose: () => void;
}

export function MediaPreviewModal({ src, onClose }: MediaPreviewModalProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (src) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [src, handleKeyDown]);

  if (!src) return null;

  const isVideo = getMediaTypeFromDataUri(src) === "video";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <CloseButton onClick={onClose} />
      {isVideo ? <VideoPreview src={src} /> : <ImagePreview src={src} />}
    </div>
  );
}
