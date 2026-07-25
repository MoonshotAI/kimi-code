import { useState, useLayoutEffect, useCallback } from "react";
import { IconX, IconPhoto } from "@tabler/icons-react";
import { getMediaTypeFromDataUri } from "@/lib/media-utils";

const IMG_HEIGHT = 128;
const dimensionCache = new Map<string, number>();

export function ImagePlaceholder() {
  return (
    <span className="inline-flex items-center justify-center bg-muted rounded my-2" style={{ width: 192, height: IMG_HEIGHT }}>
      <IconPhoto className="size-6 text-muted-foreground animate-pulse" />
    </span>
  );
}

export function ImageLoadFail({ path }: { path: string }) {
  return (
    <span className="flex flex-col items-center justify-center bg-muted rounded my-2" style={{ width: 192, height: IMG_HEIGHT }}>
      <IconPhoto className="size-6 text-red-400" />
      <span className="text-xs">{path}</span>
    </span>
  );
}

export interface StreamImagePreviewProps {
  src: string;
  alt?: string;
  onPreview: (uri: string) => void;
}

export function StreamImagePreview({ src, alt, onPreview }: StreamImagePreviewProps) {
  const [width, setWidth] = useState<number | null>(() => dimensionCache.get(src) ?? null);

  useLayoutEffect(() => {
    if (width !== null) return;
    const img = new Image();
    img.onload = () => {
      const w = Math.round(IMG_HEIGHT * (img.naturalWidth / img.naturalHeight));
      dimensionCache.set(src, w);
      setWidth(w);
    };
    img.src = src;
  }, [src, width]);

  if (width === null) return <ImagePlaceholder />;

  return (
    <img
      src={src}
      alt={alt || ""}
      style={{ width, height: IMG_HEIGHT }}
      className="rounded my-2 cursor-pointer hover:opacity-90 transition-opacity object-cover"
      onClick={() => onPreview(src)}
    />
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

  useLayoutEffect(() => {
    if (src) {
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }
  }, [src, handleKeyDown]);

  if (!src) return null;

  const isVideo = getMediaTypeFromDataUri(src) === "video";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={onClose}>
      <button onClick={onClose} className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors">
        <IconX className="size-5" />
      </button>
      {isVideo ? (
        <video src={src} className="max-w-[90vw] max-h-[90vh] rounded-lg" controls autoPlay onClick={(e) => e.stopPropagation()} />
      ) : (
        <img src={src} alt="Preview" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
      )}
    </div>
  );
}
