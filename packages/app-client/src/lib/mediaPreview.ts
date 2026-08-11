// packages/app-client/src/lib/mediaPreview.ts
// PhotoSwipe launcher for image attachments — the sent-message thumbnails and
// the composer's pending-attachment strip open the same full-screen preview.
// The thumbnail <img> doubles as the zoom origin AND the byte source: its
// currentSrc is the already-loaded resource (AuthMedia's authed blob URL or a
// composer draft's object URL), so opening needs no second fetch and the
// natural dimensions come for free. File-store media without a resolved
// thumbnail falls back to an authenticated blob fetch (the AuthMedia path) and
// opens with a fade instead of a zoom.
// The instance registers with the shared dialog stack (openDialogCount) while
// open — App's side-panel Esc handler and the conversation's Esc-interrupt
// defer to open overlays, and PhotoSwipe's own escKey handling owns the key.
// UI is the library default (top-bar close/zoom, tap toggles controls);
// styling is limited to tokens (backdrop, caption) plus the file-name caption.
import PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';
import './mediaPreview.css';
import { openDialogCount } from '@moonshot-ai/app-ui';
import type { KimiWebApi } from '@moonshot-ai/app-core/api';
import type { ToolMedia } from '@moonshot-ai/app-core/client';

export interface ImagePreviewOptions {
  /** Authenticated file-store access (the app's composed api singleton). */
  api: Pick<KimiWebApi, 'getFileBlob'>;
  media: ToolMedia;
  /** The clicked thumbnail <img>; null (e.g. unresolved src) means no zoom
   *  origin — the preview fades in from the blob-fetch/url fallback. */
  thumbImg: HTMLImageElement | null;
  labels: { close: string; zoom: string };
  onClose: () => void;
}

interface ResolvedImage {
  src: string;
  w: number;
  h: number;
  /** Set only when we created the blob URL ourselves (revoke on destroy). */
  objectUrl: string | null;
}

function loadDims(src: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function resolveImage(api: Pick<KimiWebApi, 'getFileBlob'>, media: ToolMedia, thumbImg: HTMLImageElement | null): Promise<ResolvedImage | null> {
  if (thumbImg?.currentSrc && thumbImg.naturalWidth > 0) {
    return { src: thumbImg.currentSrc, w: thumbImg.naturalWidth, h: thumbImg.naturalHeight, objectUrl: null };
  }
  let src = media.url;
  let objectUrl: string | null = null;
  if (media.fileId) {
    try {
      const blob = await api.getFileBlob(media.fileId);
      objectUrl = URL.createObjectURL(blob);
      src = objectUrl;
    } catch {
      // Keep the bare url — a failed auth fetch degrades to a likely-broken
      // slide, same honesty as AuthMedia's own fallback.
    }
  }
  const dims = await loadDims(src);
  if (!dims) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    return null;
  }
  return { src, ...dims, objectUrl };
}

/** Opens the preview; returns a cancel fn for the host component's unmount.
 *  Resolution failures call onClose without opening so the parent state resets. */
export function openImagePreview(opts: ImagePreviewOptions): () => void {
  let cancelled = false;
  let done = false;
  let pswp: PhotoSwipe | null = null;

  void (async () => {
    const resolved = await resolveImage(opts.api, opts.media, opts.thumbImg);
    if (cancelled) {
      if (resolved?.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
      return;
    }
    if (!resolved) {
      opts.onClose();
      return;
    }
    // Zoom origin only when the bytes come from the visible thumbnail itself.
    const origin = opts.thumbImg?.currentSrc === resolved.src ? opts.thumbImg : null;
    pswp = new PhotoSwipe({
      dataSource: [
        {
          src: resolved.src,
          w: resolved.w,
          h: resolved.h,
          // The thumbnail <img> is object-fit: cover (square crop) — tell
          // PhotoSwipe so the zoom maps the center-crop exactly instead of
          // squashing the full image into the thumb rect.
          thumbCropped: true,
          ...(origin ? { msrc: origin.currentSrc, element: origin } : {}),
        },
      ],
      index: 0,
      showHideAnimationType: origin ? 'zoom' : 'fade',
      arrowPrev: false,
      arrowNext: false,
      counter: false,
      close: true,
      zoom: true,
      wheelToZoom: true,
      escKey: true,
      closeTitle: opts.labels.close,
      zoomTitle: opts.labels.zoom,
      // --pswp-bg (a scrim token) already carries its alpha.
      bgOpacity: 1,
    });
    // A detached thumbnail (turn unloaded / strip re-rendered) has no usable
    // bounds — drop it so the transition degrades to a fade instead of
    // zooming toward (0,0). (The runtime accepts a null thumbEl; the type
    // declaration just doesn't admit it.)
    pswp.addFilter('thumbEl', (thumbnail) => (thumbnail?.isConnected ? thumbnail : (null as unknown as HTMLElement)));
    const caption = opts.media.path;
    pswp.on('uiRegister', () => {
      const ui = pswp?.ui;
      if (!ui || !caption) return;
      ui.registerElement({
        name: 'caption',
        className: 'media-preview-caption',
        isButton: false,
        appendTo: 'root',
        onInit: (el) => {
          el.textContent = caption;
        },
      });
    });
    pswp.on('openingAnimationStart', () => {
      openDialogCount.value += 1;
    });
    pswp.on('destroy', () => {
      done = true;
      openDialogCount.value = Math.max(0, openDialogCount.value - 1);
      if (resolved.objectUrl) URL.revokeObjectURL(resolved.objectUrl);
      opts.onClose();
    });
    pswp.init();
  })();

  return () => {
    cancelled = true;
    if (pswp && !done) pswp.close();
  };
}
