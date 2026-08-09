import { IconX, IconPlayerPlay, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { getMediaTypeFromDataUri } from "@/lib/media-utils";

interface ThumbnailWrapperProps {
  onClick?: () => void;
  onRemove?: () => void;
  sizeClass: string;
  children: React.ReactNode;
}

function ThumbnailWrapper({ onClick, onRemove, sizeClass, children }: ThumbnailWrapperProps) {
  return (
    <div className="relative group shrink-0">
      <div className={cn(sizeClass, "rounded-md cursor-pointer border border-border hover:border-primary/50 transition-colors overflow-hidden")} onClick={onClick}>
        {children}
      </div>
      {onRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -top-1.5 -right-1.5 size-5 rounded-full text-red-500 bg-white border border-red-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
        >
          <IconX className="size-3" />
        </button>
      )}
    </div>
  );
}

interface MediaThumbnailProps {
  src?: string;
  onClick?: () => void;
  onRemove?: () => void;
  size?: "sm" | "md";
  className?: string;
}

export function MediaThumbnail({ src, onClick, onRemove, size = "md", className }: MediaThumbnailProps) {
  const sizeClass = size === "sm" ? "size-12" : "size-16";
  const isLoading = !src;
  const isVideo = src && getMediaTypeFromDataUri(src) === "video";

  return (
    <ThumbnailWrapper onClick={onClick} onRemove={onRemove} sizeClass={cn(sizeClass, className)}>
      {isLoading ? (
        <div className="w-full h-full bg-muted flex items-center justify-center">
          <IconLoader2 className="size-5 text-muted-foreground animate-spin" />
        </div>
      ) : isVideo ? (
        <div className="relative w-full h-full bg-black">
          <video src={src} className="w-full h-full object-cover" muted preload="metadata" />
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <IconPlayerPlay className="size-5 text-white" />
          </div>
        </div>
      ) : (
        <img src={src} alt="Media" className={cn(sizeClass, "object-cover")} />
      )}
    </ThumbnailWrapper>
  );
}
